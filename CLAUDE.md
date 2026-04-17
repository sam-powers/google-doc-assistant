# Claude Assistant — Project Context

## What this is

A Google Apps Script add-on that responds to `@claude` mentions in Google Doc comments. Replies appear under the "Claude Assistant" service account identity. BYOK — each activating user supplies their own Anthropic API key.

## Repo

https://github.com/sam-powers/google-doc-assistant

## Architecture

**Two components that must stay in sync:**

| Component | File | Deploy command |
|---|---|---|
| Google Apps Script | `Code.gs`, `Sidebar.html`, `appsscript.json` | `clasp push --force` |
| Cloud Run service | `cloud-run/index.js` | `gcloud run deploy` (see below) |

**Flow:** User activates → Apps Script registers a Drive Changes watch pointing at the Cloud Run service → user adds `@claude` comment → Drive fires webhook → Cloud Run fetches comments via service account, calls Anthropic (with web search), posts reply.

## Files

- `Code.gs` — Apps Script server-side logic: setup, watch management, deactivation, manual fallback
- `Sidebar.html` — Sidebar UI: two-state (setup → active)
- `appsscript.json` — Manifest with Drive v3 Advanced Service
- `cloud-run/index.js` — Cloud Run service: `/webhook`, `/register`, `/unregister` endpoints
- `cloud-run/firestore.js` — KV-compat wrapper over Firestore SDK
- `cloud-run/package.json`, `cloud-run/Dockerfile` — Node.js 20 container
- `worker/` — archived Cloudflare Worker (superseded, kept for reference)
- `.claspignore` — excludes `worker/`, `cloud-run/`, `tests/`, etc. from clasp push
- `docs/service-blueprint.md` — Full UX/timing documentation for all flows

## Deployment

**Apps Script:**
```
clasp push --force
```

**Cloud Run:**
```
gcloud run deploy claude-doc-assistant \
  --source cloud-run/ \
  --region us-central1 \
  --allow-unauthenticated \
  --timeout=900 \
  --set-secrets="SERVICE_ACCOUNT_KEY=SERVICE_ACCOUNT_KEY:latest,REGISTER_SECRET=REGISTER_SECRET:latest" \
  --project=claude-doc-assistant
```

**Script ID:** `1CoY1bgrCEDwEzqENNxZRrlTCWIDahCzqgHvWmdkEF--XS5yL9hGHsJox`
**Cloud Run URL:** `https://claude-doc-assistant-1076978511316.us-central1.run.app`

## Secrets

Never committed. Stored in GCP Secret Manager (`claude-doc-assistant` project):
- `SERVICE_ACCOUNT_KEY` — GCP service account JSON
- `REGISTER_SECRET` — shared secret (also set in Apps Script Script Properties as `REGISTER_SECRET`)

Mounted as env vars at deploy time via `--set-secrets`.

## Apps Script Script Properties

Set via Apps Script editor → Project Settings → Script Properties:
- `REGISTER_SECRET` — must match the value stored in GCP Secret Manager
- `SERVICE_BASE_URL` — Cloud Run base URL (e.g. `https://claude-doc-assistant-1076978511316.us-central1.run.app`). No hardcoded URLs in code — changing deployment target only requires updating this property.

## Firestore

**Project:** `claude-doc-assistant` (us-central1, Native mode)

Collection structure (mirrors old Cloudflare KV key schema):
- `channels/{channelToken}` → `{ docId, anthropicApiKey, channelId, activatedAt }`
- `canonical/{docId}` → `{ value: channelToken }`
- `processed/{docId}` → `{ value: JSON array of reply IDs, capped at 500 }`
- `locks/{commentId}` → `{ value: '1', expiresAt: Timestamp }` — in-flight lock, 120s TTL
- `context/{docId}` → `{ value: string, expiresAt: Timestamp }` — cached doc text/summary, 1hr TTL
- `cache/sa_token` → `{ value: token, expiresAt: Timestamp }` — service account OAuth token, 55min TTL

TTL policies are set on `locks`, `context`, and `cache` collections (Firestore TTL field: `expiresAt`). TTL deletes are eventually consistent — code checks `expiresAt > now` on read.

## Service Account

`claude-assistant@claude-doc-assistant.iam.gserviceaccount.com`

Granted commenter access on each doc at activation time. Permission persists after deactivation — this is intentional (removing it would require owner-level access that the user may not want to grant).

## Key Design Decisions

**`Drive.Changes.watch` not `Drive.Files.watch`** — only Changes fires for comment additions.

**Canonical channel** — only the most recently activated user's channel processes comments. Prevents duplicate responses from multiple active channels. Last-write-wins when two users activate on the same doc (known limitation — no UI warning).

**`activatedAt` filter** — ignores `@claude` comments created before activation. Prevents responding to historical comments on activation.

**Fire-and-forget after `res.status(200).end()`** — Drive requires a response within 10s. Cloud Run returns 200 immediately and continues processing async via `processDoc(config).catch(...)`. Cloud Run's 900s timeout gives plenty of runway.

**No email filter** — Drive API does not return `author.emailAddress` for comment authors when fetched by a service account. Dedup relies on `author.me` (boolean) and processed reply IDs instead.

**`processComment` takes no `claudeEmail` arg** — the flat-loop refactor removed all email-based logic from `processComment`. It takes `(comment, processedIds)` only. The call site passes `SERVICE_ACCOUNT_EMAIL` nowhere near `processComment`. Do not re-add a `claudeEmail` parameter; it is unused and passing it in the wrong position caused a prior bug where `processedIds` was `undefined`.

**In-flight lock TTL is 120 seconds** — Firestore TTL is eventually consistent; code checks `expiresAt > now` on read. 120s gives web search enough runway (web search adds 15–30s on top of the base Anthropic call).

**Web search is enabled** — `ENABLE_WEB_SEARCH = true` in `cloud-run/index.js`. Cloud Run's 900s timeout accommodates web search comfortably. The archived `worker/index.js` still has `ENABLE_WEB_SEARCH = false` because the Cloudflare free plan's 30s wall-clock limit made it unsafe.

**BYOK** — API key is stored in the activating user's Google UserProperties. Deleted on deactivation. Never exposed in the UI after entry.

## Watch Expiry

Drive watches expire after 6 days. A daily Apps Script trigger (`renewWatch`) checks all activated docs. If expiring within 24h, it clears the local watch state — the user must reactivate from the sidebar. The watch cannot be auto-renewed from a trigger (requires an active doc session).

## Known Issues

- **No UI feedback while Claude is processing** — user adds `@claude` comment and waits silently for ~10–60s (longer with web search)
- **No structural location in prompt** — Claude knows the highlighted anchor text but not where in the doc it lives (e.g. which section/heading). The Google Docs API (`docs.googleapis.com/v1/documents/{id}`) could provide this by walking the element tree and tracking the heading stack at the point of the quoted text (~100–300ms extra per call, not cacheable). Deferred — only valuable for docs with clear heading structure.
- **Collaborator sidebar shows setup state** even when Claude is active (activated by someone else). No `/status` endpoint on Cloud Run to check canonical channel from the sidebar.
- **Multiplayer conflict** — if User B activates on a doc User A already activated, B's channel becomes canonical with no warning to A
- **Watch renewal requires manual reactivation** — not seamless
- **`pendingDeferred` is process-level** — if Cloud Run scales to multiple instances each has its own `pendingDeferred` Map. A cooldown set by one instance won't suppress another's deferred timer; both can run `processDoc` concurrently. The per-comment Firestore lock prevents duplicate replies, but Anthropic calls are wasted during scale-out. Acceptable at current scale.
- **No rate limiting on `/register` and `/unregister`** — HMAC is the only gate. A caller with a valid (or replayed) HMAC can call these endpoints repeatedly. Mitigated by the 60s replay window and the non-guessable Cloud Run URL.
- **Drive webhooks are not signed by Google** — the UUID format check prevents garbage tokens but cannot prove a webhook originated from Google. A network-adjacent attacker who discovers the Cloud Run URL can spoof a webhook. Impact: wasted Anthropic call + false placeholder reply. Google does not provide a signing mechanism for Drive webhooks; the Cloud Run URL's non-guessability is the mitigation.

## Post-Push Checklist

1. If testing: Reactivate in sidebar to refresh the channel
