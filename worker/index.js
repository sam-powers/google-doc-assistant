const SERVICE_ACCOUNT_EMAIL = 'claude-assistant@claude-doc-assistant.iam.gserviceaccount.com';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const ENABLE_WEB_SEARCH = false; // requires Cloudflare paid plan (30s free limit too short for web search)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/webhook') return handleWebhook(request, env, ctx);
    if (request.method === 'POST' && url.pathname === '/register') return handleRegister(request, env);
    if (request.method === 'POST' && url.pathname === '/unregister') return handleUnregister(request, env);
    return new Response('Not Found', { status: 404 });
  }
};

async function handleRegister(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || token !== env.REGISTER_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { channelToken, channelId, docId, anthropicApiKey, activatedAt } = body;
  if (!channelToken || !channelId || !docId || !anthropicApiKey) {
    return new Response('Missing required fields: channelToken, channelId, docId, anthropicApiKey', { status: 400 });
  }

  await env.DOC_CONFIGS.put(channelToken, JSON.stringify({ docId, anthropicApiKey, channelId, activatedAt }));
  await env.DOC_CONFIGS.put(`canonical_${docId}`, channelToken);
  return new Response('OK', { status: 200 });
}

async function handleUnregister(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || token !== env.REGISTER_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body;
  try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }

  const { channelToken, docId } = body;
  if (channelToken) await env.DOC_CONFIGS.delete(channelToken);
  if (docId) {
    const canonical = await env.DOC_CONFIGS.get(`canonical_${docId}`);
    if (canonical === channelToken) await env.DOC_CONFIGS.delete(`canonical_${docId}`);
  }

  return new Response('OK', { status: 200 });
}

async function handleWebhook(request, env, ctx) {
  const resourceState = request.headers.get('X-Goog-Resource-State');
  const channelToken = request.headers.get('X-Goog-Channel-Token');
  const channelId = request.headers.get('X-Goog-Channel-ID');
  const resourceId = request.headers.get('X-Goog-Resource-ID');

  console.log(`[webhook] state=${resourceState} token=${channelToken} channelId=${channelId} resourceId=${resourceId}`);

  if (resourceState === 'sync') {
    console.log('[webhook] sync ping received — watch registration confirmed');
    return new Response('OK', { status: 200 });
  }

  if (!channelToken) {
    console.log('[webhook] no channel token, ignoring');
    return new Response('OK', { status: 200 });
  }

  const raw = await env.DOC_CONFIGS.get(channelToken);
  if (!raw) {
    console.log(`[webhook] no KV config for token=${channelToken}`);
    return new Response('OK', { status: 200 });
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    console.error('[webhook] failed to parse KV config:', err);
    return new Response('OK', { status: 200 });
  }

  console.log(`[webhook] config found: docId=${config.docId} storedChannelId=${config.channelId}`);

  if (config.channelId !== channelId) {
    console.log(`[webhook] channelId mismatch: got=${channelId} stored=${config.channelId}`);
    return new Response('OK', { status: 200 });
  }

  config.channelToken = channelToken;
  console.log(`[webhook] dispatching processDoc for docId=${config.docId}`);
  ctx.waitUntil(processDoc(config, env));
  return new Response('OK', { status: 200 });
}

async function getServiceAccountToken(env) {
  const cached = await env.DOC_CONFIGS.get('sa_token_cache');
  if (cached) {
    console.log('[getServiceAccountToken] returning cached token');
    return cached;
  }
  console.log('[getServiceAccountToken] cache miss, signing new JWT');

  const key = JSON.parse(env.SERVICE_ACCOUNT_KEY);

  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  function base64url(str) {
    return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  function base64urlFromUint8Array(buf) {
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(claim));
  const signingInput = `${headerB64}.${payloadB64}`;

  const pemBody = key.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '');

  const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyData.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const sigB64 = base64urlFromUint8Array(signatureBuffer);
  const jwt = `${signingInput}.${sigB64}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    console.error('[getServiceAccountToken] token exchange failed:', JSON.stringify(tokenData));
    throw new Error(`Failed to obtain service account token: ${JSON.stringify(tokenData)}`);
  }

  console.log('[getServiceAccountToken] token obtained, caching for 55min');
  await env.DOC_CONFIGS.put('sa_token_cache', tokenData.access_token, { expirationTtl: 3300 });
  return tokenData.access_token;
}

async function fetchAllComments(docId, accessToken) {
  const comments = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      pageSize: '100',
      fields: 'comments(id,content,createdTime,quotedFileContent,author(displayName,me),resolved,replies(id,content,createdTime,author(displayName,me))),nextPageToken',
      includeDeleted: 'false'
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const res = await fetch(`${DRIVE_API_BASE}/files/${docId}/comments?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`fetchAllComments failed ${res.status}: ${body}`);
    }

    const data = await res.json();
    if (data.comments && data.comments.length > 0) {
      comments.push(...data.comments);
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return comments;
}

function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '\u2026';
}

function stripAtClaude(content) {
  return content.replace(/@claude/gi, '').trim();
}

function containsAtClaude(content) {
  return /@claude/i.test(content);
}

function authorEmail(reply) {
  return (reply?.author?.emailAddress || '').toLowerCase();
}

function processComment(comment, processedIds) {
  const replies = comment.replies || [];
  const anchorText = comment.quotedFileContent?.value || '';

  // Flatten the thread into a single sequence: top-level comment first, then replies
  const items = [
    { content: comment.content, id: null },
    ...replies.map(r => ({ content: r.content, id: r.id }))
  ];

  for (let i = 0; i < items.length; i++) {
    if (!containsAtClaude(items[i].content)) continue;

    // Answered if any subsequent item is in processedIds
    const alreadyAnswered = items.slice(i + 1).some(r => r.id && processedIds.has(r.id));
    if (alreadyAnswered) continue;

    return [{
      commentId: comment.id,
      replyId: items[i].id,
      anchorText,
      prompt: stripAtClaude(items[i].content)
    }];
  }

  return [];
}

function buildThreadHistory(comment, claudeEmail) {
  const messages = [];
  const lowerClaude = claudeEmail.toLowerCase();

  messages.push({
    role: 'user',
    content: stripAtClaude(comment.content)
  });

  const replies = comment.replies || [];
  for (const reply of replies) {
    const role = authorEmail(reply) === lowerClaude ? 'assistant' : 'user';
    messages.push({
      role,
      content: stripAtClaude(reply.content)
    });
  }

  return messages;
}

function normalizeMessages(messages) {
  if (messages.length === 0) return messages;

  const normalized = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    const current = messages[i];
    const last = normalized[normalized.length - 1];
    if (current.role === last.role) {
      last.content = last.content + '\n\n' + current.content;
    } else {
      normalized.push({ ...current });
    }
  }
  return normalized;
}

function buildSystemPrompt(docContext, anchorText) {
  return `You are an assistant embedded in a Google Doc.

If the request is about research, facts, or questions: respond concisely and directly.
If the request is about writing, editing, or rewriting: match the document's tone and style as described in the document context below.
${ENABLE_WEB_SEARCH ? '\nIf you search the web, include sources at the end of your reply.' : ''}
Document context:
"${docContext}"

Highlighted text:
"${anchorText}"`;
}

async function summarizeWithHaiku(text, apiKey, targetWords) {
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: Math.ceil((targetWords / 0.75) * 1.1),
        messages: [
          {
            role: 'user',
            content: `Summarize this document in approximately ${targetWords} words. Focus on:\n- Overall structure and organization\n- A brief outline of main sections\n- Key points and arguments\n- Important quotes or specific language worth preserving\n- The document's tone and writing style (e.g. formal/informal, technical/conversational, persuasive/neutral, first/third person)\n\nDocument:\n\n${text}`
          }
        ]
      })
    });

    if (!res.ok) {
      throw new Error(`Haiku summarize failed: ${res.status}`);
    }

    const data = await res.json();
    const textBlocks = (data.content || []).filter(b => b.type === 'text' && b.text);
    if (textBlocks.length > 0) {
      return textBlocks.map(b => b.text).join('\n\n');
    }
    return text.slice(0, 5000);
  } catch (err) {
    console.error('summarizeWithHaiku error:', err);
    return text.slice(0, 5000);
  }
}

async function getDocContext(docId, accessToken, anthropicApiKey, env) {
  const cacheKey = `doc_context_${docId}`;
  const cached = await env.DOC_CONFIGS.get(cacheKey);
  if (cached) {
    return cached;
  }

  const exportRes = await fetch(
    `${DRIVE_API_BASE}/files/${docId}/export?mimeType=text%2Fplain`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!exportRes.ok) {
    const body = await exportRes.text();
    throw new Error(`getDocContext export failed ${exportRes.status}: ${body}`);
  }

  const fullText = await exportRes.text();
  const wordCount = fullText.trim().split(/\s+/).length;

  let context;
  if (wordCount <= 1000) {
    context = fullText;
  } else {
    const targetWords = Math.max(Math.round(wordCount * 0.1), 1000);
    context = await summarizeWithHaiku(fullText, anthropicApiKey, targetWords);
  }

  await env.DOC_CONFIGS.put(cacheKey, context, { expirationTtl: 3600 });
  return context;
}

async function getProcessedIds(docId, env) {
  try {
    const raw = await env.DOC_CONFIGS.get(`processed_${docId}`);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(arr);
  } catch {
    return new Set();
  }
}

async function markProcessed(docId, replyId, env) {
  const key = `processed_${docId}`;
  let arr = [];
  try {
    const raw = await env.DOC_CONFIGS.get(key);
    if (raw) arr = JSON.parse(raw);
  } catch {
    arr = [];
  }

  if (!arr.includes(replyId)) {
    arr.push(replyId);
  }

  if (arr.length > 500) {
    arr = arr.slice(arr.length - 500);
  }

  await env.DOC_CONFIGS.put(key, JSON.stringify(arr));
}

async function processSingleInvocation(item, docId, anthropicApiKey, accessToken, env) {
  const { comment, commentId, anchorText } = item;

  // Build thread history before posting placeholder so it doesn't appear as context
  let messages = buildThreadHistory(comment, SERVICE_ACCOUNT_EMAIL);
  messages = normalizeMessages(messages);

  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    return;
  }

  // Post placeholder immediately so user knows Claude is working
  const placeholderRes = await fetch(
    `${DRIVE_API_BASE}/files/${docId}/comments/${commentId}/replies?fields=id`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Claude is responding\u2026' })
    }
  );
  if (!placeholderRes.ok) {
    const body = await placeholderRes.text();
    throw new Error(`Post placeholder failed ${placeholderRes.status}: ${body}`);
  }
  console.log(`[processSingleInvocation] placeholder posted for commentId=${commentId}`);

  const docContext = await getDocContext(docId, accessToken, anthropicApiKey, env);
  const systemPrompt = buildSystemPrompt(docContext, anchorText);

  let replyText;
  let isError = false;
  try {
    const anthropicHeaders = {
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    };
    if (ENABLE_WEB_SEARCH) anthropicHeaders['anthropic-beta'] = 'web-search-2025-03-05';

    const anthropicBody = {
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages
    };
    if (ENABLE_WEB_SEARCH) anthropicBody.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

    const anthropicRes = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: anthropicHeaders,
      body: JSON.stringify(anthropicBody)
    });

    if (!anthropicRes.ok) {
      const body = await anthropicRes.text();
      throw new Error(`Anthropic API failed ${anthropicRes.status}: ${body}`);
    }

    const anthropicData = await anthropicRes.json();
    const textBlocks = (anthropicData.content || []).filter(b => b.type === 'text' && b.text);
    if (textBlocks.length === 0) throw new Error('No text content in response');
    replyText = textBlocks.map(b => b.text).join('\n\n');
  } catch (err) {
    replyText = `Claude encountered an error: ${err.message}`;
    isError = true;
    console.error('[processSingleInvocation] Anthropic error:', err);
  }

  // Post response (or error) as a second reply
  const replyRes = await fetch(
    `${DRIVE_API_BASE}/files/${docId}/comments/${commentId}/replies?fields=id`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: replyText })
    }
  );

  if (!replyRes.ok) {
    const body = await replyRes.text();
    throw new Error(`Post reply failed ${replyRes.status}: ${body}`);
  }

  const replyData = await replyRes.json();
  await markProcessed(docId, replyData.id, env);
  console.log(`[processSingleInvocation] reply posted for commentId=${commentId} isError=${isError}`);
}


async function processDoc(config, env) {
  console.log(`[processDoc] start docId=${config.docId}`);

  if (!config.activatedAt) {
    console.log('[processDoc] no activatedAt — orphaned channel, skipping');
    return;
  }

  const canonical = await env.DOC_CONFIGS.get(`canonical_${config.docId}`);
  if (canonical && canonical !== config.channelToken) {
    console.log(`[processDoc] not canonical channel, skipping`);
    return;
  }

  try {
    const accessToken = await getServiceAccountToken(env);
    console.log('[processDoc] got service account token');

    await new Promise(r => setTimeout(r, 2000)); // 2s: wait for Drive to propagate new comments before fetching
    let comments = await fetchAllComments(config.docId, accessToken);
    console.log(`[processDoc] fetched ${comments.length} comments, activatedAt=${new Date(config.activatedAt).toISOString()}`);

    const processedIds = await getProcessedIds(config.docId, env);
    console.log(`[processDoc] ${processedIds.size} already-processed IDs`);

    const allPending = [];
    for (const comment of comments) {
      if (comment.resolved) continue;
      const commentAge = new Date(comment.createdTime).getTime();
      const isNew = commentAge >= config.activatedAt;
      const hasAtClaude = /@claude/i.test(comment.content);
      if (hasAtClaude) {
        console.log(`[processDoc] @claude comment id=${comment.id} isNew=${isNew}`);
      }
      if (!isNew) continue;
      const pending = processComment(comment, processedIds);
      for (const p of pending) {
        allPending.push({ ...p, comment });
      }
    }

    console.log(`[processDoc] ${allPending.length} pending invocations`);

    for (const item of allPending) {
      const lockKey = `processing_${item.commentId}`;
      const locked = await env.DOC_CONFIGS.get(lockKey);
      if (locked) {
        console.log(`[processDoc] commentId=${item.commentId} already in-flight, skipping`);
        continue;
      }
      await env.DOC_CONFIGS.put(lockKey, '1', { expirationTtl: 60 }); // KV minimum is 60s; free plan wall-clock limit is 30s so lock outlives the worker by ~30s before retry

      console.log(`[processDoc] processing commentId=${item.commentId} prompt="${item.prompt.slice(0, 80)}"`);
      try {
        await processSingleInvocation(item, config.docId, config.anthropicApiKey, accessToken, env);
        console.log(`[processDoc] finished commentId=${item.commentId}`);
      } catch (err) {
        await env.DOC_CONFIGS.delete(lockKey);
        const msg = err.message || '';
        if (msg.includes('429')) {
          console.log(`[processDoc] rate limited — stopping this run, will retry on next webhook`);
          break;
        }
        console.error(`[processDoc] processSingleInvocation failed for commentId=${item.commentId}:`, err);
      }
    }
    console.log('[processDoc] done');
  } catch (err) {
    console.error('[processDoc] fatal error:', err);
  }
}
