# GCP Migration Plan — Cloudflare Workers → Cloud Run + Firestore

## Why migrate

| Current constraint | Impact |
|---|---|
| Cloudflare free plan 30s wall-clock limit | Web search disabled — calls frequently exceed 30s and the worker is killed silently |
| `ENABLE_WEB_SEARCH = false` | Claude cannot look anything up; degrades response quality for factual/research queries |
| Opaque failure mode | When the worker is killed mid-flight the 60s KV lock blocks retries for a minute with no user-visible feedback |

Cloud Run removes the wall-clock cap (up to 15 min per request, configurable). Web search becomes safe to re-enable.

---

## Target architecture

```
Drive webhook
     │
     ▼
Cloud Run service (us-central1)
  ├── POST /webhook   → returns 200 immediately, processes async
  ├── POST /register  → writes to Firestore
  └── POST /unregister → deletes from Firestore
     │
     ├── Firestore (state store — replaces Cloudflare KV)
     ├── Google Drive API (fetch comments, post replies)
     └── Anthropic API (claude-sonnet-4-6 + web_search enabled)
```

**What does NOT change:** The three HTTP endpoints and their request/response shapes stay identical. Apps Script only needs a one-line URL update.

---

## Service mapping

| What | Current | New |
|---|---|---|
| HTTP runtime | Cloudflare Workers | Cloud Run (Node.js, Express) |
| State store | Cloudflare KV | Firestore (Native mode) |
| Secrets | `wrangler secret put` | GCP Secret Manager |
| Observability | Cloudflare logs dashboard | Cloud Logging + Cloud Monitoring |
| Deploy command | `wrangler deploy` | `gcloud run deploy` |

---

## State store mapping

Every Cloudflare KV key maps to a Firestore collection/document. TTL is handled via a per-document `expiresAt` Timestamp field plus a Firestore TTL policy on that field.

| Cloudflare KV key | Firestore path | TTL |
|---|---|---|
| `{channelToken}` | `channels/{channelToken}` | none (deleted on unregister) |
| `canonical_{docId}` | `canonical/{docId}` | none |
| `processed_{docId}` | `processed/{docId}` → `{ ids: string[] }` | none (rolling cap of 500) |
| `processing_{commentId}` | `locks/{commentId}` → `{ expiresAt: Timestamp }` | 60s (checked in-process) |
| `doc_context_{docId}` | `context/{docId}` → `{ text: string, expiresAt: Timestamp }` | 1h |
| `sa_token_cache` | `cache/sa_token` → `{ token: string, expiresAt: Timestamp }` | 55min |

**TTL note:** Firestore TTL deletes are eventually consistent (up to 24h delay). For locks and cache entries the code must check `expiresAt > now` on read — not just document existence.

---

## Runtime model change

**Cloudflare:**
```js
ctx.waitUntil(processDoc(config, env));  // background up to 30s
return new Response('OK', { status: 200 });
```

**Cloud Run (Node.js):**
```js
res.status(200).end();                    // return 200 to Drive immediately
processDoc(config, env).catch(console.error); // fire-and-forget; container stays alive
```

Cloud Run containers are not terminated between requests. Background work continues past the HTTP response with no cap (up to the Cloud Run max timeout, set to 900s). This eliminates the need for `ctx.waitUntil` entirely.

---

## File layout

New directory alongside the existing `worker/`:

```
cloud-run/
  index.js          # Express app — direct port of worker/index.js
  firestore.js      # Thin wrapper: get/put/delete/putWithTTL over Firestore SDK
  package.json      # express, @google-cloud/firestore, node-fetch (or native fetch)
  Dockerfile
  .gcloudignore
```

`worker/` is kept in place until the Cloud Run deployment is validated end-to-end, then archived.

---

## Key code changes in `cloud-run/index.js`

### 1. Entry point

Replace Cloudflare module export with Express:

```js
// Before (Cloudflare)
export default {
  async fetch(request, env, ctx) { ... }
};

// After (Express)
import express from 'express';
const app = express();
app.use(express.json());
app.post('/webhook',    handleWebhook);
app.post('/register',   handleRegister);
app.post('/unregister', handleUnregister);
app.listen(process.env.PORT || 8080);
```

### 2. Environment / secrets

Replace `env.FOO` with `process.env.FOO`. Secrets are mounted as env vars from Secret Manager at deploy time.

```js
const REGISTER_SECRET      = process.env.REGISTER_SECRET;
const SERVICE_ACCOUNT_KEY  = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
```

### 3. KV → Firestore wrapper (`firestore.js`)

Expose a KV-like interface so `index.js` diffs stay minimal:

```js
export async function kvGet(key)                        // → string | null
export async function kvPut(key, value, ttlSeconds)     // ttlSeconds optional
export async function kvDelete(key)
```

Internally maps each key prefix to the right Firestore collection (see state mapping table above).

### 4. Background processing

```js
async function handleWebhook(req, res) {
  // ... guards ...
  res.status(200).end();                          // satisfy Drive's 10s window
  processDoc(config).catch(console.error);        // continues after response
}
```

### 5. Web search — re-enable

```js
const ENABLE_WEB_SEARCH = true;
```

No other changes needed — the Anthropic call already has the conditional wiring.

### 6. `buildThreadHistory` — fix email-based role detection

The current implementation uses `authorEmail(reply) === lowerClaude` for role detection (assistant vs. user). Service account email is not returned by the Drive API when fetching as a service account — this already falls back to `author.me`. Confirm `author.me` is the sole role signal and remove the email parameter entirely:

```js
function buildThreadHistory(comment) {
  // use reply.author.me === true for 'assistant' role
}
```

---

## Firestore setup

```bash
# Create database (Native mode, us-central1 to co-locate with Cloud Run)
gcloud firestore databases create --location=us-central1

# Enable TTL on the locks collection (expiresAt field)
gcloud firestore fields ttls update expiresAt \
  --collection-group=locks \
  --enable-ttl

# Enable TTL on context and cache collections
gcloud firestore fields ttls update expiresAt \
  --collection-group=context \
  --enable-ttl

gcloud firestore fields ttls update expiresAt \
  --collection-group=cache \
  --enable-ttl
```

---

## Secrets setup

```bash
# Service account key (same JSON used with wrangler today)
gcloud secrets create SERVICE_ACCOUNT_KEY \
  --data-file=path/to/sa-key.json

# Shared register secret (same value as current REGISTER_SECRET Script Property)
echo -n "your-secret-here" | gcloud secrets create REGISTER_SECRET --data-file=-
```

Grant the Cloud Run service account access:
```bash
gcloud secrets add-iam-policy-binding SERVICE_ACCOUNT_KEY \
  --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding REGISTER_SECRET \
  --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

---

## Deployment

```bash
gcloud run deploy claude-doc-assistant \
  --source cloud-run/ \
  --region us-central1 \
  --allow-unauthenticated \
  --timeout=900 \
  --set-secrets="SERVICE_ACCOUNT_KEY=SERVICE_ACCOUNT_KEY:latest,REGISTER_SECRET=REGISTER_SECRET:latest"
```

Note `--allow-unauthenticated`: Drive webhooks are unauthenticated HTTP POSTs. The existing `REGISTER_SECRET` bearer token is the auth mechanism for `/register` and `/unregister`. `/webhook` is validated by the KV/Firestore channel token lookup + channelId guard.

---

## Apps Script change (`Code.gs`)

One line:

```js
// Before
const WORKER_URL = 'https://claude-doc-assistant.samueldarinpowers.workers.dev';

// After
const WORKER_URL = 'https://claude-doc-assistant-XXXX-uc.a.run.app';  // Cloud Run URL
```

---

## Cost estimate

| Service | Usage | Est. cost/month |
|---|---|---|
| Cloud Run | ~few hundred invocations/day, <1s idle, 0 min-instances | < $1 (likely free tier) |
| Firestore | reads/writes proportional to comment volume | < $1 at low volume |
| Secret Manager | 2 secrets, few accesses/day | < $0.10 |
| **With min-instances=1** | Eliminates cold starts (~200ms) | ~$5–7/month |

Cold starts on Cloud Run (Node.js + Firestore SDK) are typically 500ms–1s. Given Drive's 10s response window and the fact that we return 200 immediately before processing, cold starts are unlikely to cause Drive retries. Setting `--min-instances=1` is optional.

---

## Migration checklist

### Phase 1 — Build
- [ ] Create `cloud-run/package.json` (express, `@google-cloud/firestore`)
- [ ] Create `cloud-run/firestore.js` (KV-compat wrapper)
- [ ] Port `worker/index.js` to `cloud-run/index.js` (Express, Firestore, `ENABLE_WEB_SEARCH = true`)
- [ ] Create `cloud-run/Dockerfile`
- [ ] Fix `buildThreadHistory` to use `author.me` only (remove email parameter)

### Phase 2 — Infrastructure
- [ ] Create Firestore database (us-central1, Native mode)
- [ ] Configure TTL policies on `locks`, `context`, `cache` collections
- [ ] Add secrets to Secret Manager
- [ ] Grant Cloud Run service account access to secrets and Firestore

### Phase 3 — Deploy & validate
- [ ] Deploy Cloud Run service
- [ ] Test `/register` and `/unregister` endpoints directly (curl)
- [ ] Update `WORKER_URL` in `Code.gs` to Cloud Run URL
- [ ] Reactivate in sidebar (registers new channel pointing at Cloud Run)
- [ ] Add `@claude` comment → verify reply appears with web search active
- [ ] Verify deactivation flow clears Firestore state correctly
- [ ] Verify watch renewal still works (trigger fires → still calls Apps Script, no worker change needed)

### Phase 4 — Cutover
- [ ] Update `CLAUDE.md` deploy section (`gcloud run deploy` replaces `wrangler deploy`)
- [ ] Update `docs/service-blueprint.md` to reflect Firestore state store
- [ ] Archive `worker/` (keep for reference; remove from CI if any)
- [ ] Update `WORKER_URL` Script Property in deployed Apps Script

---

## Resolved decisions

1. **GCP project** — No existing project. A new project (`claude-doc-assistant`) needs to be created. Setup instructions are included in the migration checklist.
2. **Drive webhook URL stability** — Redeploying to the same service name (`claude-doc-assistant`) in the same region preserves the URL. Active users do not need to reactivate on redeploys.
3. **Firestore region** — `us-central1` confirmed. Cannot be changed after creation.
4. **`--min-instances`** — Use `0` (free, accept cold starts). Cold starts are invisible to users because the 200 response is returned to Drive before any heavy processing begins.
