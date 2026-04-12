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
| Cloudflare Worker | `worker/index.js` | `cd worker && wrangler deploy` |

**Flow:** User activates → Apps Script registers a Drive Changes watch pointing at the Worker → user adds `@claude` comment → Drive fires webhook → Worker fetches comments via service account, calls Anthropic, posts reply.

## Files

- `Code.gs` — Apps Script server-side logic: setup, watch management, deactivation, manual fallback
- `Sidebar.html` — Sidebar UI: two-state (setup → active)
- `appsscript.json` — Manifest with Drive v3 Advanced Service
- `worker/index.js` — Cloudflare Worker: `/webhook`, `/register`, `/unregister` endpoints
- `worker/wrangler.toml` — KV namespace binding
- `.claspignore` — excludes `worker/` from clasp push
- `docs/service-blueprint.md` — Full UX/timing documentation for all flows

## Deployment

**Apps Script:**
```
clasp push --force
```

**Cloudflare Worker:**
```
cd worker && wrangler deploy
```

**Script ID:** `1CoY1bgrCEDwEzqENNxZRrlTCWIDahCzqgHvWmdkEF--XS5yL9hGHsJox`
**Worker URL:** `https://claude-doc-assistant.samueldarinpowers.workers.dev`

## Secrets

Never committed. Set via:
- `wrangler secret put SERVICE_ACCOUNT_KEY` — GCP service account JSON
- `wrangler secret put REGISTER_SECRET` — shared secret (also set in Apps Script Script Properties as `REGISTER_SECRET`)

## Cloudflare KV

**Namespace:** `ba63db417c5f41c5863eb84c9b3e94d5`

Key structure:
- `{channelToken}` → `{ docId, anthropicApiKey, channelId, activatedAt }`
- `canonical_{docId}` → `channelToken` (which user's channel is active for this doc)
- `processed_{docId}` → JSON array of reply IDs (dedup, capped at 500)
- `processing_{commentId}` → in-flight lock, 5min TTL
- `doc_context_{docId}` → cached doc text/summary, 1hr TTL
- `sa_token_cache` → service account OAuth token, 55min TTL

## Service Account

`claude-assistant@claude-doc-assistant.iam.gserviceaccount.com`

Granted commenter access on each doc at activation time. Permission persists after deactivation — this is intentional (removing it would require owner-level access that the user may not want to grant).

## Key Design Decisions

**`Drive.Changes.watch` not `Drive.Files.watch`** — only Changes fires for comment additions.

**Canonical channel** — only the most recently activated user's channel processes comments. Prevents duplicate responses from multiple active channels. Last-write-wins when two users activate on the same doc (known limitation — no UI warning).

**`activatedAt` filter** — ignores `@claude` comments created before activation. Prevents responding to historical comments on activation.

**`ctx.waitUntil`** — Drive requires a response within 10s. Worker returns 200 immediately and processes async.

**No email filter** — Drive API does not return `author.emailAddress` for comment authors when fetched by a service account. Dedup relies on `author.me` (boolean) and processed reply IDs instead.

**BYOK** — API key is stored in the activating user's Google UserProperties. Deleted on deactivation. Never exposed in the UI after entry.

## Watch Expiry

Drive watches expire after 6 days. A daily Apps Script trigger (`renewWatch`) checks all activated docs. If expiring within 24h, it clears the local watch state — the user must reactivate from the sidebar. The watch cannot be auto-renewed from a trigger (requires an active doc session).

## Known Issues

- **No UI feedback while Claude is processing** — user adds `@claude` comment and waits silently for ~10–30s
- **No structural location in prompt** — Claude knows the highlighted anchor text but not where in the doc it lives (e.g. which section/heading). The Google Docs API (`docs.googleapis.com/v1/documents/{id}`) could provide this by walking the element tree and tracking the heading stack at the point of the quoted text (~100–300ms extra per call, not cacheable). Deferred — only valuable for docs with clear heading structure.
- **Collaborator sidebar shows setup state** even when Claude is active (activated by someone else). No `/status` endpoint on the worker to check canonical channel from the sidebar.
- **Multiplayer conflict** — if User B activates on a doc User A already activated, B's channel becomes canonical with no warning to A
- **Watch renewal requires manual reactivation** — not seamless

## Post-Push Checklist

1. If testing: Reactivate in sidebar to refresh the channel
