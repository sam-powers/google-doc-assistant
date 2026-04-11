const SERVICE_ACCOUNT_EMAIL = 'claude-assistant@claude-doc-assistant.iam.gserviceaccount.com';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/webhook') return handleWebhook(request, env, ctx);
    if (request.method === 'POST' && url.pathname === '/register') return handleRegister(request, env);
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

  const { channelToken, channelId, docId, anthropicApiKey } = body;
  if (!channelToken || !channelId || !docId || !anthropicApiKey) {
    return new Response('Missing required fields: channelToken, channelId, docId, anthropicApiKey', { status: 400 });
  }

  await env.DOC_CONFIGS.put(channelToken, JSON.stringify({ docId, anthropicApiKey, channelId }));
  return new Response('OK', { status: 200 });
}

async function handleWebhook(request, env, ctx) {
  const resourceState = request.headers.get('X-Goog-Resource-State');
  if (resourceState === 'sync') {
    return new Response('OK', { status: 200 });
  }

  const channelToken = request.headers.get('X-Goog-Channel-Token');
  const channelId = request.headers.get('X-Goog-Channel-ID');

  if (!channelToken) {
    return new Response('OK', { status: 200 });
  }

  const raw = await env.DOC_CONFIGS.get(channelToken);
  if (!raw) {
    return new Response('OK', { status: 200 });
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return new Response('OK', { status: 200 });
  }

  if (config.channelId !== channelId) {
    return new Response('OK', { status: 200 });
  }

  ctx.waitUntil(processDoc(config, env));
  return new Response('OK', { status: 200 });
}

async function getServiceAccountToken(env) {
  const cached = await env.DOC_CONFIGS.get('sa_token_cache');
  if (cached) {
    return cached;
  }

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
    throw new Error(`Failed to obtain service account token: ${JSON.stringify(tokenData)}`);
  }

  await env.DOC_CONFIGS.put('sa_token_cache', tokenData.access_token, { expirationTtl: 3300 });
  return tokenData.access_token;
}

async function fetchAllComments(docId, accessToken) {
  const comments = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      pageSize: '100',
      fields: 'comments(id,content,quotedFileContent,author,resolved,replies(id,content,author)),nextPageToken',
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

function processComment(comment, claudeEmail, processedIds) {
  const pending = [];
  const replies = comment.replies || [];
  const anchorText = comment.quotedFileContent?.value || '';

  if (containsAtClaude(comment.content)) {
    const lastReply = replies.length > 0 ? replies[replies.length - 1] : null;
    const alreadyAnswered =
      lastReply &&
      (lastReply.author.emailAddress.toLowerCase() === claudeEmail.toLowerCase() ||
        processedIds.has(lastReply.id));

    if (!alreadyAnswered) {
      pending.push({
        commentId: comment.id,
        replyId: null,
        anchorText: truncate(anchorText, 60),
        prompt: stripAtClaude(comment.content)
      });
      return pending;
    }
  }

  for (let i = 0; i < replies.length; i++) {
    const reply = replies[i];
    if (containsAtClaude(reply.content)) {
      const nextReply = replies[i + 1] || null;
      const replyAlreadyAnswered =
        nextReply &&
        (nextReply.author.emailAddress.toLowerCase() === claudeEmail.toLowerCase() ||
          processedIds.has(nextReply.id));

      if (!replyAlreadyAnswered) {
        pending.push({
          commentId: comment.id,
          replyId: reply.id,
          anchorText: truncate(anchorText, 60),
          prompt: stripAtClaude(reply.content)
        });
      }
    }
  }

  return pending;
}

function buildThreadHistory(comment, claudeEmail) {
  const messages = [];

  messages.push({
    role: 'user',
    content: stripAtClaude(comment.content)
  });

  const replies = comment.replies || [];
  for (const reply of replies) {
    const role =
      reply.author.emailAddress.toLowerCase() === claudeEmail.toLowerCase()
        ? 'assistant'
        : 'user';
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
Help with whatever the user asks — research, editing, rewriting, brainstorming, etc.
Be concise. If you search the web, include sources at the end of your reply.

Document context:
"${docContext}"

Highlighted text:
"${anchorText}"`;
}

async function summarizeWithHaiku(text, apiKey) {
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
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content: `Summarize this document in 2-3 sentences for context:\n\n${text}`
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
    return text.slice(0, 500);
  } catch (err) {
    console.error('summarizeWithHaiku error:', err);
    return text.slice(0, 500);
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
  const words = fullText.trim().split(/\s+/);
  const wordCount = words.length;

  let context;
  if (wordCount <= 500) {
    context = fullText;
  } else {
    const excerpt = words.slice(0, 2000).join(' ');
    context = await summarizeWithHaiku(excerpt, anthropicApiKey);
  }

  await env.DOC_CONFIGS.put(cacheKey, context, { expirationTtl: 21600 });
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

  let messages = buildThreadHistory(comment, SERVICE_ACCOUNT_EMAIL);
  messages = normalizeMessages(messages);

  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    return;
  }

  const docContext = await getDocContext(docId, accessToken, anthropicApiKey, env);
  const systemPrompt = buildSystemPrompt(docContext, anchorText);

  const payload = {
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages
  };

  const anthropicRes = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!anthropicRes.ok) {
    const body = await anthropicRes.text();
    throw new Error(`Anthropic API failed ${anthropicRes.status}: ${body}`);
  }

  const anthropicData = await anthropicRes.json();
  const textBlocks = (anthropicData.content || []).filter(b => b.type === 'text' && b.text);
  if (textBlocks.length === 0) {
    return;
  }
  const replyText = textBlocks.map(b => b.text).join('\n\n');

  const replyRes = await fetch(
    `${DRIVE_API_BASE}/files/${docId}/comments/${commentId}/replies?fields=id`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content: replyText })
    }
  );

  if (!replyRes.ok) {
    const body = await replyRes.text();
    throw new Error(`Post reply failed ${replyRes.status}: ${body}`);
  }

  const replyData = await replyRes.json();
  await markProcessed(docId, replyData.id, env);
}

async function processDoc(config, env) {
  const accessToken = await getServiceAccountToken(env);
  const comments = await fetchAllComments(config.docId, accessToken);
  const processedIds = await getProcessedIds(config.docId, env);

  const allPending = [];
  for (const comment of comments) {
    if (comment.resolved) continue;
    const pending = processComment(comment, SERVICE_ACCOUNT_EMAIL, processedIds);
    for (const p of pending) {
      allPending.push({ ...p, comment });
    }
  }

  for (const item of allPending) {
    try {
      await processSingleInvocation(item, config.docId, config.anthropicApiKey, accessToken, env);
    } catch (err) {
      console.error('processSingleInvocation error:', err);
    }
  }
}
