# Claude Assistant — Service Blueprint

---

## How to read this

Each flow is broken into steps across a timeline. For each step, five layers are documented:

| Layer | What it captures |
|---|---|
| **Physical Evidence** | What the user sees or touches |
| **User Action** | What the user does |
| **Frontstage** | System responses visible to the user |
| **Backstage** | System activity invisible to the user |
| **Support Processes** | External services and infrastructure involved |

**Scope labels** indicate where state lives:
- `[user]` — stored per-user, applies across all docs (Google Apps Script UserProperties)
- `[user × doc]` — stored per-user, scoped to this specific doc (UserProperties keyed by docId)
- `[doc]` — stored at the doc level, shared across all users (Cloudflare KV or Drive permissions)

---

## Flow 1: Activation

*Perspective: the user who enables Claude Assistant in a doc*

---

### Step 1 — Open the sidebar

| Layer | Detail |
|---|---|
| **Physical Evidence** | Google Doc. Extensions menu in the toolbar. |
| **User Action** | Opens the doc. Clicks Extensions → Claude Assistant → Open Claude Assistant. |
| **Frontstage** | Sidebar opens. Shows setup state: API key input field, Test button, disabled Activate button. |
| **Backstage** | `getWatchStatus()` runs on sidebar load. Checks UserProperties for `watch_{docId}_channelId` and `watch_{docId}_expiration`. `[user × doc]` |
| **Support Processes** | Google Apps Script runtime, HtmlService (sidebar render) |

If a watch already exists and hasn't expired → sidebar skips setup and shows active state directly. See Flow 1b (Reactivation).

---

### Step 2 — Enter and test the API key

| Layer | Detail |
|---|---|
| **Physical Evidence** | API key input field (password-masked). Test button. Status line below input. |
| **User Action** | Pastes Anthropic API key. Clicks Test. |
| **Frontstage** | Status line shows "Testing…" while in flight. On success: "✓ Key is valid" (green). On failure: "✗ [error message]" (red). Activate button enabled only on success. |
| **Backstage** | `testApiKey(key)` → calls Anthropic API with `claude-haiku-4-5`, `max_tokens: 10`, message "Hi". Returns `{ ok: true }` or `{ ok: false, error: "..." }`. Key is NOT saved at this step. `[user]` |
| **Support Processes** | Anthropic API (`/v1/messages`) |

---

### Step 3 — Activate

| Layer | Detail |
|---|---|
| **Physical Evidence** | Activate button. Spinner while in flight. |
| **User Action** | Clicks Activate. |
| **Frontstage** | Button shows "Activating…" spinner. On success: sidebar transitions to active state showing green dot, "Active in this document", and expiry date. On failure: red error banner appears inline. |
| **Backstage** | Four sequential operations run: |
| | **3a. Re-test key** — `testApiKey(key)` called again as a guard. `[—]` |
| | **3b. Save key** — `saveSettings(key)` stores key in UserProperties. `[user]` |
| | **3c. Set up doc** — `setupDoc()` runs three sub-steps (see below). |
| | **3d. Return status** — `setupDoc()` returns `{ expiresAt: "MM/DD/YYYY" }` to sidebar. |
| **Support Processes** | Anthropic API, Drive API v3, Cloudflare Worker |

**setupDoc() detail (Step 3c):**

| Sub-step | What happens | Scope |
|---|---|---|
| Share doc | `Drive.Permissions.create` — grants service account `claude-assistant@...` commenter access on this doc. Silent if already has access. | `[doc]` — permanent Drive permission until manually revoked |
| Stop old watch | If UserProperties has a prior `watch_{docId}_channelId` + `watch_{docId}_resourceId`, calls `Drive.Channels.stop`. Errors silently ignored (channel may have expired). | `[user × doc]` |
| Register watch | `Drive.Changes.watch` — registers a push notification channel pointing to the Cloudflare Worker. Returns `channelId`, `channelToken`, `resourceId`, `expiration` (6 days from now). | `[user × doc]` — watch is owned by this user's OAuth session |
| Register with worker | `POST /register` to Cloudflare Worker with `{ channelToken, channelId, docId, anthropicApiKey, activatedAt }`. Worker stores two KV entries: `channelToken → { docId, apiKey, channelId, activatedAt }` and `canonical_{docId} → channelToken`. Last-write-wins: if another user activates later, their channel becomes canonical. | `[doc]` — Cloudflare KV |
| Store watch metadata | `setDocWatch(docId, ...)` writes `watch_{docId}_channelId`, `watch_{docId}_channelToken`, `watch_{docId}_resourceId`, `watch_{docId}_expiration` to UserProperties. Also appends `docId` to `watchDocIds` list. | `[user × doc]` |
| Install renewal trigger | `installRenewalTrigger()` — removes any existing `renewWatch` trigger, installs a new daily time-based trigger. One trigger covers all docs activated by this user. | `[user]` |

---

### Step 1b — Opening the sidebar when already active (Reactivation / status check)

| Layer | Detail |
|---|---|
| **Physical Evidence** | Sidebar in active state. |
| **User Action** | Opens sidebar on a doc where they previously activated. |
| **Frontstage** | Sidebar loads directly into active state. Shows green dot, "Active in this document", expiry date (e.g., "Active until 4/18/2026"). Deactivate button visible. |
| **Backstage** | `getWatchStatus()` reads UserProperties. If `watch_{docId}_expiration` < now: clears the stale entry and returns `{ active: false, expired: true }` → sidebar shows setup state instead. `[user × doc]` |
| **Support Processes** | None |

---

## Flow 2: Commenting to ping Claude

*Two perspectives: the activating user, and a collaborator in the same doc.*

---

### Step 1 — Write the comment

| Layer | Detail |
|---|---|
| **Physical Evidence** | Google Doc. Comment thread. |
| **User Action (Activating user)** | Highlights text (optional). Opens comment. Types "@claude [question]". Submits. |
| **User Action (Collaborator)** | Same — types "@claude [question]" in any comment or reply in this doc. |
| **Frontstage** | Comment appears in the doc thread immediately. No indication that anything is happening. |
| **Backstage** | Nothing yet. Drive has not fired the webhook. |
| **Support Processes** | Google Docs comment system |

---

### Step 2 — Drive fires the webhook (~0–5s after comment)

| Layer | Detail |
|---|---|
| **Physical Evidence** | Nothing visible. |
| **User Action** | None. |
| **Frontstage** | Nothing visible. |
| **Backstage** | Google Drive detects a change to the file. Fires a POST to the Cloudflare Worker at `/webhook` with headers: `X-Goog-Resource-State: update`, `X-Goog-Channel-Token: {channelToken}`, `X-Goog-Channel-ID: {channelId}`, `X-Goog-Resource-ID: {resourceId}`. Note: Drive fires for ALL changes to the doc (edits, comments, permission changes) — not just comment additions. | `[doc]` |
| **Support Processes** | Google Drive push notifications infrastructure |

*Timing note: Drive typically fires within 1–5 seconds of the change. This is not guaranteed.*

---

### Step 3 — Worker receives webhook (~same time as Step 2)

| Layer | Detail |
|---|---|
| **Physical Evidence** | Nothing visible. |
| **User Action** | None. |
| **Frontstage** | Nothing visible. |
| **Backstage** | Worker runs the following synchronously before returning 200 to Drive (must complete within ~10s or Drive retries): |
| | **Guard: sync ping** — if `X-Goog-Resource-State: sync`, return 200 immediately. No processing. |
| | **Guard: KV lookup** — looks up `channelToken` in Cloudflare KV. If not found, return 200 silently (orphaned channel). |
| | **Guard: channelId match** — compares `X-Goog-Channel-ID` to stored `channelId`. Mismatch → return 200 silently (anti-spoofing). |
| | **Guard: canonical check** — reads `canonical_{docId}` from KV. If this `channelToken` doesn't match the canonical value, returns 200 silently. Only the canonical (most recently activated) channel processes. `[doc]` |
| | **Dispatch** — calls `ctx.waitUntil(processDoc(...))`. Returns 200 to Drive immediately. Processing continues async. |
| **Support Processes** | Cloudflare Workers runtime, Cloudflare KV |

*`ctx.waitUntil` is critical: it allows the worker to return 200 (satisfying Drive's 10s window) while continuing to process in the background. Without it, Drive would retry on timeout.*

---

### Step 4 — Worker processes the doc (~4s sleep + API calls)

| Layer | Detail |
|---|---|
| **Physical Evidence** | Nothing visible yet. |
| **User Action** | None — user is waiting. No loading indicator exists. |
| **Frontstage** | Nothing visible. |
| **Backstage** | `processDoc()` runs the following sequence: |
| | **4a. Sleep 4s** — waits for Drive's comment indexing lag before fetching. Comments added to the doc may not appear in the Drive API immediately. |
| | **4b. Fetch comments** — `fetchAllComments(docId, serviceAccountToken)` — paginated Drive API call using service account credentials. Returns all unresolved comments with full reply threads. Author identity returned as `{ displayName, me }` — email addresses are not returned when fetched by a service account. `[doc]` |
| | **4c. Filter comments** — skips resolved comments. Skips comments created before `activatedAt` (timestamp stored at activation). Only processes comments newer than activation. `[doc]` |
| | **4d. Find pending invocations** — `processComment()` checks each comment for `@claude` in the body or replies. "Already answered" = last reply has `author.me === true` (service account's own reply) OR reply ID is in the processed set. If already answered, skips. |
| | **4e. Per-comment lock** — for each pending comment, reads `processing_{commentId}` from KV. If key exists (set within the last 5 min), skips (another webhook is already handling it). If not, writes the lock key with 5min TTL. `[doc]` |
| | **4f. Doc context** — `getDocContext()` reads `doc_context_{docId}` from KV cache (6hr TTL). On cache miss: exports doc as plain text via Drive export API, then either uses full text (≤500 words) or summarizes with `claude-haiku-4-5` (>500 words). `[doc]` |
| | **4g. Build thread history** — `buildThreadHistory()` + `normalizeMessages()` — reconstructs the full comment thread as an Anthropic messages array, with service account replies as `assistant` role and everything else as `user`. |
| | **4h. Call Anthropic** — `POST /v1/messages` with model `claude-sonnet-4-6`, system prompt (doc context + highlighted text), thread history, `web_search` tool enabled, `max_tokens: 4096`. Uses the API key stored at activation time (the activating user's key, not the commenter's). `[user × doc]` — key belongs to activating user |
| | **4i. Post reply** — `POST /drive/v3/files/{docId}/comments/{commentId}/replies` using service account OAuth token. Reply content = all text blocks from Anthropic response joined with double newline. |
| | **4j. Mark processed** — stores reply ID in `processed_{docId}` KV array, capped at 500 entries. `[doc]` |
| **Support Processes** | Cloudflare KV, Drive API v3, Anthropic API |

---

### Step 5 — Reply appears in doc (~10–30s after original comment)

| Layer | Detail |
|---|---|
| **Physical Evidence** | Comment thread in Google Doc. |
| **User Action (Activating user)** | Sees the reply appear under "Claude Assistant" display name. |
| **User Action (Collaborator)** | Sees the same reply appear under "Claude Assistant". |
| **Frontstage** | Reply appears as a normal Google Doc comment reply from the account "Claude Assistant". No other UI feedback. |
| **Backstage** | Nothing additional. |
| **Support Processes** | Google Docs real-time sync (shows the reply to all viewers) |

**Timing breakdown (approximate):**

| Phase | Time |
|---|---|
| User submits comment | T+0 |
| Drive fires webhook | T+0 to T+5s |
| Worker receives, dispatches | T+5s (±) |
| Drive indexing sleep | T+5s to T+9s |
| Fetch comments | T+9s |
| Anthropic call (simple query) | T+9s to T+15s |
| Anthropic call (web search) | T+9s to T+25s |
| Reply appears | T+15s to T+30s |

---

### Conversation continuation (follow-up @claude in a reply)

The most common usage pattern after the first exchange:

| Layer | Detail |
|---|---|
| **User Action** | Types "@claude [follow-up]" as a reply in the same thread. |
| **Backstage** | Entire Flow 2 repeats. `buildThreadHistory()` reconstructs the full thread — all prior messages including Claude's previous replies — before calling Anthropic. Claude has full conversation context. |
| **Scope note** | Thread history is reconstructed live from Drive on each invocation. Nothing is persisted per-thread beyond processed reply IDs. `[doc]` |

---

## Flow 3: Deactivation

*Perspective: the user who activated*

---

### Step 1 — Deactivate

| Layer | Detail |
|---|---|
| **Physical Evidence** | Sidebar in active state. Deactivate button. |
| **User Action** | Clicks Deactivate. |
| **Frontstage** | Button shows "Deactivating…" spinner. On success: sidebar transitions to setup state. Input is cleared. Key status is cleared. Activate button disabled. API key is NOT pre-filled (never surfaced again after setup). |
| **Backstage** | `deactivateDoc()` runs four steps: |
| | **1. Stop Drive watch** — `Drive.Channels.stop({ id: channelId, resourceId: resourceId })`. Errors silently ignored (may have expired). `[user × doc]` |
| | **2. Unregister from worker** — `POST /unregister` with `{ channelToken, docId }`. Worker deletes `channelToken` KV entry. If this token matches `canonical_{docId}`, deletes that entry too. Future Drive events for this doc will be silently ignored. `[doc]` |
| | **3. Clear watch state** — `clearDocWatch(docId)` deletes all `watch_{docId}_*` UserProperties. Removes docId from `watchDocIds`. `[user × doc]` |
| | **4. Delete API key** — `deleteProperty('anthropicApiKey')` from UserProperties. `[user]` |
| **Support Processes** | Drive API v3, Cloudflare Worker + KV |

**What deactivation does NOT do:**
- Does not remove the service account's commenter permission on the doc (Drive permission persists)
- Does not delete processed reply IDs from Cloudflare KV (they expire naturally)
- Does not affect other users' views of the doc's comment history

---

## Background Flow: Watch Renewal

*Runs automatically, invisible to the user*

Drive push notification channels expire after 6 days. A daily trigger attempts renewal.

| Step | What happens | Scope |
|---|---|---|
| Daily trigger fires `renewWatch()` | Reads `watchDocIds` from UserProperties — list of all docIds this user has activated. | `[user]` |
| For each docId: check expiry | Reads `watch_{docId}_expiration`. If expiring within 24 hours: | `[user × doc]` |
| Stop old channel | `Drive.Channels.stop` — errors silently ignored. | `[user × doc]` |
| Clear watch state | `clearDocWatch(docId)` — removes all `watch_{docId}_*` properties. | `[user × doc]` |
| No auto-renewal | The trigger cannot call `setupDoc()` — that requires an active doc session and the user's OAuth token. The doc's canonical channel entry in Cloudflare KV is NOT cleared. | — |
| User must reactivate | Next time the user opens the sidebar for that doc, `getWatchStatus()` returns `{ active: false }`. Sidebar shows setup state. User re-enters key and re-activates. | — |

**Gap window:** After the watch expires and before the user reactivates, `@claude` comments in the doc go unanswered silently. No notification is sent to the user.

---

## Collaborator Perspective: Opening the Sidebar on an Active Doc

*User B opens the sidebar on a doc where User A has already activated*

| Step | What User B sees | What's actually happening |
|---|---|---|
| Opens sidebar | **Setup state** — API key input, no indication that Claude is active | `getWatchStatus()` checks User B's UserProperties. User B has no `watch_{docId}_*` entries → returns `{ active: false }`. Sidebar shows setup state. |
| Types `@claude` in a comment | Comment is added | Drive fires webhook. Worker looks up `canonical_{docId}` → finds User A's channelToken. Processes using **User A's stored API key**. |
| Claude replies | Reply appears under "Claude Assistant" | Normal reply flow, identical to Flow 2 from User A's perspective. |
| User B activates | Sidebar shows active state for User B | User B's `setupDoc()` runs. Worker stores a new `canonical_{docId}` → User B's channelToken. **User A's channel is still alive in Drive and KV, but is no longer canonical.** User A's webhook events will be silently skipped. User A has no indication this happened. |

**Known limitation:** There is no mechanism to detect from the sidebar whether another user has already activated Claude on this doc. User B sees "setup" even though Claude is fully working. Fixing this would require a worker `/status` endpoint that checks `canonical_{docId}` in KV and returns whether the doc is active.

---

## State Storage Summary

| Data | Where stored | Scope | Lifetime |
|---|---|---|---|
| Anthropic API key | Google UserProperties (`anthropicApiKey`) | Per user | Until deactivation |
| Watch channel metadata | Google UserProperties (`watch_{docId}_*`) | Per user × per doc | Until deactivation or expiry |
| All activated docIds | Google UserProperties (`watchDocIds`) | Per user | Updated on activate/deactivate |
| Canonical channel pointer | Cloudflare KV (`canonical_{docId}`) | Per doc | Until deactivate or overwrite |
| Channel config + API key | Cloudflare KV (`{channelToken}`) | Per channel | Until deactivate |
| Processed reply IDs | Cloudflare KV (`processed_{docId}`) | Per doc | Rolling window, capped at 500 |
| In-flight lock | Cloudflare KV (`processing_{commentId}`) | Per comment | 5-minute TTL |
| Doc context cache | Cloudflare KV (`doc_context_{docId}`) | Per doc | 6-hour TTL |
| Service account token | Cloudflare KV (`sa_token_cache`) | Global | 55-minute TTL |
| Service account permission | Google Drive permission on file | Per doc | Permanent (until manually revoked) |
| Renewal trigger | Apps Script time-based trigger | Per user | Until user uninstalls add-on |
