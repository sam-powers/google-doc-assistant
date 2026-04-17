import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { kvGet, kvPut, kvDelete } from './firestore.js';

const SERVICE_ACCOUNT_EMAIL = 'claude-assistant@claude-doc-assistant.iam.gserviceaccount.com';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const ENABLE_WEB_SEARCH = true;

// ---------------------------------------------------------------------------
// KMS helpers — encrypt/decrypt Anthropic API keys at rest
// ---------------------------------------------------------------------------

let _kmsClient = null;
function getKmsClient() {
  if (!_kmsClient) _kmsClient = new KeyManagementServiceClient();
  return _kmsClient;
}

async function encryptApiKey(plaintext) {
  const keyName = process.env.KMS_KEY_NAME;
  if (!keyName) return plaintext; // no KMS configured — pass through (dev/test)

  const client = getKmsClient();
  const [result] = await client.encrypt({
    name: keyName,
    plaintext: Buffer.from(plaintext),
  });
  return Buffer.from(result.ciphertext).toString('base64');
}

async function decryptApiKey(ciphertext) {
  const keyName = process.env.KMS_KEY_NAME;
  if (!keyName) return ciphertext; // no KMS configured — pass through (dev/test)

  const client = getKmsClient();
  const [result] = await client.decrypt({
    name: keyName,
    ciphertext: Buffer.from(ciphertext, 'base64'),
  });
  return result.plaintext.toString('utf8');
}

const app = express();
app.use(express.json());

// Tracks pending deferred processDoc calls by docId so we don't stack up
// multiple redundant calls when several webhooks arrive during a cooldown.
const pendingDeferred = new Map();

app.post('/webhook',    (req, res) => handleWebhook(req, res));
app.post('/register',   (req, res) => handleRegister(req, res));
app.post('/unregister', (req, res) => handleUnregister(req, res));

const PORT = process.env.PORT || 8080;
/* c8 ignore next */
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
}

// ---------------------------------------------------------------------------
// HMAC request verification
// ---------------------------------------------------------------------------

// Verifies X-Timestamp and X-Signature headers on inbound requests from Apps Script.
// Signature = base64(HMAC-SHA256(REGISTER_SECRET, timestamp + "." + rawBody)).
// Rejects requests with timestamps more than 5 minutes old to prevent replay attacks.
function verifyHmac(req) {
  const secret = process.env.REGISTER_SECRET;
  if (!secret) return false;

  const timestamp = req.headers['x-timestamp'] || '';
  const signature = req.headers['x-signature'] || '';
  if (!timestamp || !signature) return false;

  // Reject stale requests (replay protection)
  const now = Math.floor(Date.now() / 1000);
  const ts  = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(now - ts) > 300) return false;

  const rawBody  = JSON.stringify(req.body);
  const message  = `${timestamp}.${rawBody}`;
  const expected = createHmac('sha256', secret).update(message).digest('base64');

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Endpoint handlers
// ---------------------------------------------------------------------------

async function handleRegister(req, res) {
  if (!verifyHmac(req)) {
    return res.status(401).send('Unauthorized');
  }

  const { channelToken, channelId, docId, anthropicApiKey, activatedAt } = req.body || {};
  if (!channelToken || !channelId || !docId || !anthropicApiKey) {
    return res.status(400).send('Missing required fields: channelToken, channelId, docId, anthropicApiKey');
  }

  const encryptedKey = await encryptApiKey(anthropicApiKey);
  await kvPut(channelToken, JSON.stringify({ docId, anthropicApiKey: encryptedKey, channelId, activatedAt }));
  await kvPut(`canonical_${docId}`, channelToken);
  return res.status(200).send('OK');
}

async function handleUnregister(req, res) {
  if (!verifyHmac(req)) {
    return res.status(401).send('Unauthorized');
  }

  const { channelToken, docId } = req.body || {};
  if (!channelToken || !docId) {
    return res.status(400).send('Missing required fields: channelToken, docId');
  }

  // Delete the channel config
  await kvDelete(channelToken);

  // Only delete the canonical pointer if it still points to this channel.
  // This guards against a confused deputy: a caller cannot wipe another user's
  // canonical channel by providing just a docId with a mismatched token.
  const canonical = await kvGet(`canonical_${docId}`);
  if (canonical === channelToken) {
    await kvDelete(`canonical_${docId}`);
  }

  return res.status(200).send('OK');
}

async function handleWebhook(req, res) {
  const resourceState = req.headers['x-goog-resource-state'];
  const channelToken  = req.headers['x-goog-channel-token'];
  const channelId     = req.headers['x-goog-channel-id'];
  const resourceId    = req.headers['x-goog-resource-id'];

  console.log(`[webhook] state=${resourceState} token=${channelToken} channelId=${channelId} resourceId=${resourceId}`);

  if (resourceState === 'sync') {
    console.log('[webhook] sync ping received — watch registration confirmed');
    return res.status(200).send('OK');
  }

  if (!channelToken) {
    console.log('[webhook] no channel token, ignoring');
    return res.status(200).send('OK');
  }

  // Reject malformed tokens before hitting Firestore — valid tokens are UUIDs
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(channelToken)) {
    console.log(`[webhook] token failed UUID validation: ${channelToken}`);
    return res.status(200).send('OK');
  }

  const raw = await kvGet(channelToken);
  if (!raw) {
    console.log(`[webhook] no config for token=${channelToken}`);
    return res.status(200).send('OK');
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    console.error('[webhook] failed to parse config:', err);
    return res.status(200).send('OK');
  }

  console.log(`[webhook] config found: docId=${config.docId} storedChannelId=${config.channelId}`);

  if (config.channelId !== channelId) {
    console.log(`[webhook] channelId mismatch: got=${channelId} stored=${config.channelId}`);
    return res.status(200).send('OK');
  }

  // Cooldown dedup — Drive fires on every file mutation (edits, autosaves, cursor
  // moves), not just comment additions. We coalesce bursts into a single processDoc
  // call. When a webhook is suppressed by the cooldown, we schedule a deferred call
  // so that an @claude mention added during the cooldown is never permanently missed.
  const COOLDOWN_SECONDS = 15;
  const cooldownKey = `cooldown_${config.docId}`;
  config.channelToken = channelToken;

  const onCooldown = await kvGet(cooldownKey);
  if (onCooldown) {
    console.log(`[webhook] docId=${config.docId} on cooldown — scheduling deferred processDoc`);
    res.status(200).end();

    if (!pendingDeferred.has(config.docId)) {
      const timer = setTimeout(() => {
        pendingDeferred.delete(config.docId);
        processDoc(config).catch(err => console.error('[webhook] deferred processDoc error:', err));
      }, COOLDOWN_SECONDS * 1000);
      pendingDeferred.set(config.docId, timer);
    }
    return;
  }

  // Not on cooldown — cancel any pending deferred call (this webhook will cover it)
  // and set a fresh cooldown before dispatching.
  const existing = pendingDeferred.get(config.docId);
  if (existing) {
    clearTimeout(existing);
    pendingDeferred.delete(config.docId);
  }
  await kvPut(cooldownKey, '1', COOLDOWN_SECONDS);

  console.log(`[webhook] dispatching processDoc for docId=${config.docId}`);

  // Return 200 to Drive immediately, then process in the background.
  // Cloud Run keeps the container alive past the HTTP response — no wall-clock cap.
  res.status(200).end();
  processDoc(config).catch(err => console.error('[webhook] processDoc error:', err));
}

// ---------------------------------------------------------------------------
// Service account token
// ---------------------------------------------------------------------------

async function getServiceAccountToken() {
  const cached = await kvGet('sa_token_cache');
  if (cached) {
    console.log('[getServiceAccountToken] returning cached token');
    return cached;
  }
  console.log('[getServiceAccountToken] cache miss, signing new JWT');

  const key = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
  const now = Math.floor(Date.now() / 1000);

  const header  = { alg: 'RS256', typ: 'JWT' };
  const claim   = {
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
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  const headerB64  = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(claim));
  const signingInput = `${headerB64}.${payloadB64}`;

  const pemBody = key.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '');

  const keyData   = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyData.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${base64urlFromUint8Array(signatureBuffer)}`;

  const tokenRes  = await fetch('https://oauth2.googleapis.com/token', {
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
  await kvPut('sa_token_cache', tokenData.access_token, 3300);
  return tokenData.access_token;
}

// ---------------------------------------------------------------------------
// Drive helpers
// ---------------------------------------------------------------------------

async function fetchAllComments(docId, accessToken) {
  const comments = [];
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      pageSize: '100',
      fields: 'comments(id,content,createdTime,quotedFileContent,author(displayName,me),resolved,replies(id,content,createdTime,author(displayName,me))),nextPageToken',
      includeDeleted: 'false'
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`${DRIVE_API_BASE}/files/${docId}/comments?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`fetchAllComments failed ${res.status}: ${body}`);
    }

    const data = await res.json();
    if (data.comments?.length > 0) comments.push(...data.comments);
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return comments;
}

// ---------------------------------------------------------------------------
// Comment processing helpers
// ---------------------------------------------------------------------------

function stripAtClaude(content) {
  return content.replace(/@claude/gi, '').trim();
}

function containsAtClaude(content) {
  return /@claude/i.test(content);
}

function processComment(comment, processedIds) {
  const replies    = comment.replies || [];
  const anchorText = comment.quotedFileContent?.value || '';

  const items = [
    { content: comment.content, id: null },
    ...replies.map(r => ({ content: r.content, id: r.id }))
  ];

  for (let i = 0; i < items.length; i++) {
    if (!containsAtClaude(items[i].content)) continue;

    const alreadyAnswered = items.slice(i + 1).some(r => r.id && processedIds.has(r.id));
    if (alreadyAnswered) continue;

    return [{ commentId: comment.id, replyId: items[i].id, anchorText, prompt: stripAtClaude(items[i].content) }];
  }

  return [];
}

// Use author.me (boolean) for role detection — Drive API does not return
// emailAddress when fetched by a service account, so email-based detection
// is unreliable. author.me === true means the service account (Claude) wrote it.
function buildThreadHistory(comment) {
  const messages = [];

  messages.push({ role: 'user', content: stripAtClaude(comment.content) });

  for (const reply of (comment.replies || [])) {
    const role = reply.author?.me === true ? 'assistant' : 'user';
    messages.push({ role, content: stripAtClaude(reply.content) });
  }

  return messages;
}

function normalizeMessages(messages) {
  if (messages.length === 0) return messages;

  const normalized = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    const current = messages[i];
    const last    = normalized[normalized.length - 1];
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

// ---------------------------------------------------------------------------
// Doc context (cached)
// ---------------------------------------------------------------------------

async function summarizeWithHaiku(text, apiKey, targetWords) {
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: Math.ceil((targetWords / 0.75) * 1.1),
        messages: [{
          role: 'user',
          content: `Summarize this document in approximately ${targetWords} words. Focus on:\n- Overall structure and organization\n- A brief outline of main sections\n- Key points and arguments\n- Important quotes or specific language worth preserving\n- The document's tone and writing style (e.g. formal/informal, technical/conversational, persuasive/neutral, first/third person)\n\nDocument:\n\n${text}`
        }]
      })
    });

    if (!res.ok) throw new Error(`Haiku summarize failed: ${res.status}`);

    const data       = await res.json();
    const textBlocks = (data.content || []).filter(b => b.type === 'text' && b.text);
    return textBlocks.length > 0 ? textBlocks.map(b => b.text).join('\n\n') : text.slice(0, 5000);
  } catch (err) {
    console.error('summarizeWithHaiku error:', err);
    return text.slice(0, 5000);
  }
}

async function getDocContext(docId, accessToken, anthropicApiKey) {
  const cacheKey = `doc_context_${docId}`;
  const cached   = await kvGet(cacheKey);
  if (cached) return cached;

  const exportRes = await fetch(
    `${DRIVE_API_BASE}/files/${docId}/export?mimeType=text%2Fplain`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!exportRes.ok) {
    const body = await exportRes.text();
    throw new Error(`getDocContext export failed ${exportRes.status}: ${body}`);
  }

  const fullText  = await exportRes.text();
  const wordCount = fullText.trim().split(/\s+/).length;

  let context;
  if (wordCount <= 1000) {
    context = fullText;
  } else {
    const targetWords = Math.max(Math.round(wordCount * 0.1), 1000);
    context = await summarizeWithHaiku(fullText, anthropicApiKey, targetWords);
  }

  await kvPut(cacheKey, context, 3600);
  return context;
}

// ---------------------------------------------------------------------------
// Processed-IDs store
// ---------------------------------------------------------------------------

async function getProcessedIds(docId) {
  try {
    const raw = await kvGet(`processed_${docId}`);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

async function markProcessed(docId, replyId) {
  const key = `processed_${docId}`;
  let arr   = [];
  try {
    const raw = await kvGet(key);
    if (raw) arr = JSON.parse(raw);
  } catch {
    arr = [];
  }

  if (!arr.includes(replyId)) arr.push(replyId);
  if (arr.length > 500) arr = arr.slice(arr.length - 500);

  await kvPut(key, JSON.stringify(arr));
}

// ---------------------------------------------------------------------------
// Core processing
// ---------------------------------------------------------------------------

async function processSingleInvocation(item, docId, anthropicApiKey, accessToken) {
  const { comment, commentId, anchorText } = item;

  let messages = buildThreadHistory(comment);
  messages     = normalizeMessages(messages);

  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') return;

  // Post placeholder immediately so the user knows Claude is working
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

  const docContext   = await getDocContext(docId, accessToken, anthropicApiKey);
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

    const anthropicBody = { model: CLAUDE_MODEL, max_tokens: MAX_TOKENS, system: systemPrompt, messages };
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
    const textBlocks    = (anthropicData.content || []).filter(b => b.type === 'text' && b.text);
    if (textBlocks.length === 0) throw new Error('No text content in response');
    replyText = textBlocks.map(b => b.text).join('\n\n');
  } catch (err) {
    replyText = `Claude encountered an error: ${err.message}`;
    isError   = true;
    console.error('[processSingleInvocation] Anthropic error:', err);
  }

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
  await markProcessed(docId, replyData.id);
  console.log(`[processSingleInvocation] reply posted for commentId=${commentId} isError=${isError}`);
}

async function processDoc(config) {
  console.log(`[processDoc] start docId=${config.docId}`);

  if (!config.activatedAt) {
    console.log('[processDoc] no activatedAt — orphaned channel, skipping');
    return;
  }

  // Decrypt API key — no-op when KMS_KEY_NAME is unset (dev/test)
  config = { ...config, anthropicApiKey: await decryptApiKey(config.anthropicApiKey) };

  const canonical = await kvGet(`canonical_${config.docId}`);
  if (canonical && canonical !== config.channelToken) {
    console.log('[processDoc] not canonical channel, skipping');
    return;
  }

  try {
    const accessToken = await getServiceAccountToken();
    console.log('[processDoc] got service account token');

    await new Promise(r => setTimeout(r, 2000)); // wait for Drive comment indexing
    const comments = await fetchAllComments(config.docId, accessToken);
    console.log(`[processDoc] fetched ${comments.length} comments, activatedAt=${new Date(config.activatedAt).toISOString()}`);

    const processedIds = await getProcessedIds(config.docId);
    console.log(`[processDoc] ${processedIds.size} already-processed IDs`);

    const allPending = [];
    for (const comment of comments) {
      if (comment.resolved) continue;
      const commentAge = new Date(comment.createdTime).getTime();
      const isNew      = commentAge >= config.activatedAt;
      const allContent = [comment.content, ...(comment.replies || []).map(r => r.content)];
      const hasAtClaude = allContent.some(c => /@claude/i.test(c));
      if (hasAtClaude) console.log(`[processDoc] @claude comment id=${comment.id} isNew=${isNew}`);
      if (!isNew) continue;
      const pending = processComment(comment, processedIds);
      for (const p of pending) allPending.push({ ...p, comment });
    }

    console.log(`[processDoc] ${allPending.length} pending invocations`);

    for (const item of allPending) {
      const lockKey = `processing_${item.commentId}`;
      const locked  = await kvGet(lockKey);
      if (locked) {
        console.log(`[processDoc] commentId=${item.commentId} already in-flight, skipping`);
        continue;
      }
      // 120s lock — gives web search enough runway (web search adds 15–30s)
      await kvPut(lockKey, '1', 120);

      console.log(`[processDoc] processing commentId=${item.commentId} prompt="${item.prompt.slice(0, 80)}"`);
      try {
        await processSingleInvocation(item, config.docId, config.anthropicApiKey, accessToken);
        await kvDelete(lockKey);
        console.log(`[processDoc] finished commentId=${item.commentId}`);
      } catch (err) {
        await kvDelete(lockKey);
        const msg = err.message || '';
        if (msg.includes('429')) {
          console.log('[processDoc] rate limited — stopping this run, will retry on next webhook');
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

export {
  processComment, buildThreadHistory, normalizeMessages,
  buildSystemPrompt, summarizeWithHaiku, getDocContext,
  processSingleInvocation, handleWebhook, handleRegister, handleUnregister,
  stripAtClaude, containsAtClaude,
};
