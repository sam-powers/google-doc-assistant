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
- `[doc]` — stored at the doc level, shared across all users (Firestore or Drive permissions)

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
| **Backstage** | `testApiKey(key)` → calls Anthropic API with `claude-haiku-4-5-20251001`, `max_tokens: 10`, message "Hi". Returns `{ ok: true }` or `{ ok: false, error: "..." }`. Key is NOT saved at this step. `[user]` |
| **Support Processes** | Anthropic API (`/v1/messages`) |

---

### Step 3 — Activate

| Layer | Detail |
|---|---|
| **Physical Evidence** | Activate button. Spinner while in flight. |
| **User Action** | Clicks Activate. |
| **Frontstage** | Button shows "Activating…" spinner. On success: sidebar transitions to active state showing green dot, "Active in this document", and expiry date. On failure: red error banner appears inline. |
| **Backstage** | Four sequential operations run: |
| | **3a. Save key** — `saveSettings(key)` stores key in UserProperties. `[user]` |
| | **3b. Set up doc** — `setupDoc()` runs three sub-steps (see below). |
| | **3c. Return status** — `setupDoc()` returns `{ expiresAt: "MM/DD/YYYY" }` to sidebar. |
| **Support Processes** | Anthropic API, Drive API v3, Cloud Run service |

**setupDoc() detail (Step 3c):**

| Sub-step | What happens | Scope |
|---|---|---|
| Share doc | `Drive.Permissions.create` — grants service account `claude-assistant@...` commenter access on this doc. Silent if already has access. | `[doc]` — permanent Drive permission until manually revoked |
| Stop old watch | If UserProperties has a prior `watch_{docId}_channelId` + `watch_{docId}_resourceId`, calls `Drive.Channels.stop`. Errors silently ignored (channel may have expired). | `[user × doc]` |
| Register watch | `Drive.Changes.watch` — registers a push notification channel pointing to the Cloud Run service. Returns `channelId`, `channelToken`, `resourceId`, `expiration` (6 days from now). | `[user × doc]` — watch is owned by this user's OAuth session |
| Register with service | `POST /register` to Cloud Run service with `{ channelToken, channelId, docId, anthropicApiKey, activatedAt }`. Service stores two Firestore entries: `channels/{channelToken}` and `canonical/{docId} → channelToken`. Last-write-wins: if another user activates later, their channel becomes canonical. | `[doc]` — Firestore |
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
| **Backstage** | Google Drive detects a change to the file. Fires a POST to the Cloud Run service at `/webhook` with headers: `X-Goog-Resource-State: update`, `X-Goog-Channel-Token: {channelToken}`, `X-Goog-Channel-ID: {channelId}`, `X-Goog-Resource-ID: {resourceId}`. Note: Drive fires for ALL changes to the doc (edits, comments, permission changes) — not just comment additions. | `[doc]` |
| **Support Processes** | Google Drive push notifications infrastructure |

*Timing note: Drive typically fires within 1–5 seconds of the change. This is not guaranteed.*

---

### Step 3 — Service receives webhook (~same time as Step 2)

| Layer | Detail |
|---|---|
| **Physical Evidence** | Nothing visible. |
| **User Action** | None. |
| **Frontstage** | Nothing visible. |
| **Backstage** | Service runs the following synchronously before returning 200 to Drive (must complete within ~10s or Drive retries): |
| | **Guard: sync ping** — if `X-Goog-Resource-State: sync`, return 200 immediately. No processing. |
| | **Guard: Firestore lookup** — looks up `channelToken` in Firestore `channels/` collection. If not found, return 200 silently (orphaned channel). |
| | **Guard: channelId match** — compares `X-Goog-Channel-ID` to stored `channelId`. Mismatch → return 200 silently (anti-spoofing). |
| | **Dispatch** — calls `res.status(200).end()` to satisfy Drive's 10s window, then continues processing async via `processDoc(config).catch(...)`. Cloud Run's 900s timeout gives plenty of runway. |
| **Support Processes** | Cloud Run (us-central1), Firestore |

*Returning 200 immediately is critical: it satisfies Drive's 10s window. Cloud Run continues processing after the response is sent.*

---

### Step 4 — Service processes the doc (~4s sleep + API calls)

| Layer | Detail |
|---|---|
| **Physical Evidence** | Nothing visible yet. |
| **User Action** | None — user is waiting. No loading indicator exists. |
| **Frontstage** | Nothing visible. |
| **Backstage** | `processDoc()` runs the following sequence: |
| | **4a. Canonical check** — reads `canonical/{docId}` from Firestore. If this `channelToken` doesn't match the canonical value, returns immediately. Only the most recently activated channel processes. `[doc]` |
| | **4b. Sleep 2s** — waits for Drive's comment indexing lag before fetching (configurable via `DRIVE_INDEX_DELAY_MS` env var, default 2000ms). Comments added to the doc may not appear in the Drive API immediately. |
| | **4c. Fetch comments** — `fetchAllComments(docId, serviceAccountToken)` — paginated Drive API call using service account credentials. Returns all unresolved comments with full reply threads. Author identity returned as `{ displayName, me }` — email addresses are not returned when fetched by a service account. `[doc]` |
| | **4d. Filter comments** — skips resolved comments. Skips comments created before `activatedAt` (timestamp stored at activation). Only processes comments newer than activation. `[doc]` |
| | **4e. Find pending invocations** — `processComment()` checks each comment for `@claude` in the body or any reply. "Already answered" = last reply has `author.me === true` (service account's own reply) OR reply ID is in the processed set. If already answered, skips. |
| | **4f. Per-comment lock** — for each pending comment, reads `locks/{commentId}` from Firestore. If key exists and `expiresAt > now`, skips (another webhook is already handling it). If not, writes the lock with 120s TTL. `[doc]` |
| | **4g. Doc context** — `getDocContext()` reads `context/{docId}` from Firestore cache (1hr TTL). On cache miss: exports doc as plain text via Drive export API, then either uses full text (≤1,000 words) or summarizes with `claude-haiku-4-5-20251001` (>1,000 words). `[doc]` |
| | **4h. Build thread history** — `buildThreadHistory()` + `normalizeMessages()` — reconstructs the full comment thread as an Anthropic messages array, with service account replies as `assistant` role and everything else as `user`. |
| | **4i. Call Anthropic** — `POST /v1/messages` with model `claude-sonnet-4-6`, system prompt (doc context + highlighted text), thread history, `web_search` tool enabled, `max_tokens: 4096`. Uses the API key stored at activation time (the activating user's key, not the commenter's). `[user × doc]` — key belongs to activating user |
| | **4j. Post placeholder** — immediately posts a brief placeholder reply ("Claude is responding…") under the service account while Anthropic processes. `[doc]` |
| | **4k. Post reply** — `POST /drive/v3/files/{docId}/comments/{commentId}/replies` using service account OAuth token. Reply content = all text blocks from Anthropic response joined with double newline. Replaces placeholder. |
| | **4l. Mark processed** — stores reply ID in `processed/{docId}` Firestore document (JSON array, capped at 500 entries). Releases lock by deleting `locks/{commentId}`. `[doc]` |
| **Support Processes** | Firestore, Drive API v3, Anthropic API (with web search tool) |

---

### Step 5 — Reply appears in doc (~10–60s after original comment)

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
| Service receives, dispatches | T+5s (±) |
| Drive indexing sleep | T+5s to T+7s |
| Fetch comments | T+7s |
| Anthropic call (simple query, no web search) | T+7s to T+20s |
| Anthropic call (with web search) | T+7s to T+45s |
| Reply appears | T+20s to T+60s |

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
| | **2. Unregister from service** — `POST /unregister` with `{ channelToken, docId }`. Service deletes `channels/{channelToken}` from Firestore. If this token matches `canonical/{docId}`, deletes that entry too. Future Drive events for this doc will be silently ignored. `[doc]` |
| | **3. Clear watch state** — `clearDocWatch(docId)` deletes all `watch_{docId}_*` UserProperties. Removes docId from `watchDocIds`. `[user × doc]` |
| | **4. Delete API key** — `deleteProperty('anthropicApiKey')` from UserProperties. `[user]` |
| **Support Processes** | Drive API v3, Cloud Run service + Firestore |

**What deactivation does NOT do:**
- Does not remove the service account's commenter permission on the doc (Drive permission persists)
- Does not delete processed reply IDs from Firestore (they remain until manually cleared)
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
| No auto-renewal | The trigger cannot call `setupDoc()` — that requires an active doc session and the user's OAuth token. The doc's canonical channel entry in Firestore is NOT cleared. | — |
| User must reactivate | Next time the user opens the sidebar for that doc, `getWatchStatus()` returns `{ active: false }`. Sidebar shows setup state. User re-enters key and re-activates. | — |

**Gap window:** After the watch expires and before the user reactivates, `@claude` comments in the doc go unanswered silently. The `renewWatch()` trigger sends an email notification to the user when a watch is cleared due to impending expiry.

---

## Collaborator Perspective: Opening the Sidebar on an Active Doc

*User B opens the sidebar on a doc where User A has already activated*

| Step | What User B sees | What's actually happening |
|---|---|---|
| Opens sidebar | **Setup state** — API key input, no indication that Claude is active | `getWatchStatus()` checks User B's UserProperties. User B has no `watch_{docId}_*` entries → returns `{ active: false }`. Sidebar shows setup state. |
| Types `@claude` in a comment | Comment is added | Drive fires webhook. Service looks up `canonical/{docId}` → finds User A's channelToken. Processes using **User A's stored API key**. |
| Claude replies | Reply appears under "Claude Assistant" | Normal reply flow, identical to Flow 2 from User A's perspective. |
| User B activates | Sidebar shows active state for User B | User B's `setupDoc()` runs. Service stores a new `canonical/{docId}` → User B's channelToken. **User A's channel is still alive in Drive and Firestore, but is no longer canonical.** User A's webhook events will be silently skipped. User A has no indication this happened. |

**Known limitation:** There is no mechanism to detect from the sidebar whether another user has already activated Claude on this doc. User B sees "setup" even though Claude is fully working. Fixing this would require a `/status` endpoint that checks `canonical/{docId}` in Firestore and returns whether the doc is active.

---

## State Storage Summary

| Data | Where stored | Scope | Lifetime |
|---|---|---|---|
| Anthropic API key | Google UserProperties (`anthropicApiKey`) | Per user | Until deactivation |
| Watch channel metadata | Google UserProperties (`watch_{docId}_*`) | Per user × per doc | Until deactivation or expiry |
| All activated docIds | Google UserProperties (`watchDocIds`) | Per user | Updated on activate/deactivate |
| Canonical channel pointer | Firestore `canonical/{docId}` | Per doc | Until deactivate or overwrite |
| Channel config + API key | Firestore `channels/{channelToken}` | Per channel | Until deactivate |
| Processed reply IDs | Firestore `processed/{docId}` | Per doc | Rolling window, capped at 500 |
| In-flight lock | Firestore `locks/{commentId}` | Per comment | 120s TTL (TTL policy on `locks` collection) |
| Doc context cache | Firestore `context/{docId}` | Per doc | 1-hour TTL (TTL policy on `context` collection) |
| Service account token | Firestore `cache/sa_token` | Global | 45-minute TTL / 2700s (TTL policy on `cache` collection) |
| Service account permission | Google Drive permission on file | Per doc | Permanent (until manually revoked) |
| Renewal trigger | Apps Script time-based trigger | Per user | Until user uninstalls add-on |
