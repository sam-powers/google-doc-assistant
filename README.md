# @claude in Google Docs

A Google Apps Script add-on + Cloud Run service that responds automatically to `@claude` mentions in Google Docs comment threads. Claude reads the document context, understands the highlighted text, and posts its reply directly back into the comment thread — including web search results when relevant. Replies appear under a dedicated "Claude Assistant" service account identity.

---

## Quickstart with clasp (recommended)

clasp is Google's official CLI for Apps Script. It lets you push code from this folder directly to Google without any copy-pasting. Once deployed as an **Editor Add-on**, it's available in **every Google Doc** on your account.

### 1. Install clasp and log in

```bash
npm install -g @google/clasp
clasp login
```

This opens a browser window to authorize clasp with your Google account.

### 2. Create a new Apps Script project

Run this from inside the `google-doc-assistant` folder:

```bash
clasp create --type standalone --title "Claude Assistant"
```

This creates a new standalone script project and generates a `.clasp.json` file with the project's `scriptId`. Standalone is correct here — it lets you deploy the add-on to all your docs, not just one.

### 3. Enable the Drive API Advanced Service

Apps Script needs explicit permission to use the Drive API. This can only be done in the browser:

1. Run `clasp open` to open your new project in the Apps Script editor
2. Click the **"+" next to Services** in the left panel
3. Search for **Drive API**, select **v3**, click **Add**
4. Save (⌘S or Ctrl+S)

### 4. Push your code

```bash
clasp push
```

This uploads `appsscript.json`, `Code.gs`, and `Sidebar.html` to Apps Script. Run this any time you make changes.

### 5. Deploy as an Editor Add-on

In the Apps Script editor (open with `clasp open`):

1. Click **Deploy → New deployment**
2. Click the gear icon next to "Select type" and choose **Editor Add-on**
3. Fill in a description (e.g. "v1")
4. Click **Deploy**
5. Copy the **Deployment ID** — you'll need it to install the add-on

### 6. Install the add-on on your Google account

1. Open any Google Doc
2. Go to **Extensions → Add-ons → Manage add-ons** (or visit [workspace.google.com/marketplace](https://workspace.google.com/marketplace))

   > **Note:** Private/unlisted add-ons can be installed directly via a URL. In your browser, navigate to:
   > `https://script.google.com/macros/d/YOUR_DEPLOYMENT_ID/usercallback`
   > and follow the authorization prompts.

   Alternatively, in the Apps Script editor go to **Deploy → Test deployments** to run it in a specific doc immediately (no install needed for testing).

3. Once installed, the add-on appears under **Extensions → Claude Assistant** in every Google Doc you open.

---

## Updating the code

After making any edits locally:

```bash
clasp push
clasp deploy --description "v2"   # creates a new versioned deployment
```

Or for quick iteration, use **Test deployments** (Deploy → Test deployments in the editor) which always runs against your latest pushed code without creating a new version.

---

## First-time Setup (in the sidebar)

The first time you open the sidebar in a doc, you'll be prompted to enter your **Anthropic API Key** — get yours at [console.anthropic.com](https://console.anthropic.com).

Click **Test** to verify the key, then **Activate**. The key is stored encrypted in Google UserProperties — each person who installs the add-on manages their own key.

If you see an "unverified app" authorization screen, click **Advanced → Go to [project name] (unsafe)** and approve. This is normal for private add-ons that haven't been through Google's Marketplace review.

---

## Usage

### Writing a @claude comment

1. Highlight any text in your document.
2. Insert a comment (⌘ + Option + M or Ctrl + Alt + M).
3. Type `@claude` followed by your question or instruction:

   > `@claude Can you rewrite this paragraph to be more concise?`

4. Post the comment. Claude will respond automatically — no sidebar interaction needed.

### Follow-up replies

Reply to an existing thread and include `@claude` again:

> `@claude Make it even shorter — one sentence only.`

Claude will see the full thread history before responding.

### How it works

When you post a `@claude` comment, Google Drive fires a webhook to the Cloud Run service. The service fetches the comment, calls Anthropic, and posts Claude's reply back to the thread under the "Claude Assistant" identity. Typical response time is 5–30 seconds (longer when web search is used).

---

## Manual installation (no clasp)

If you prefer not to use the CLI:

1. Open a Google Doc → **Extensions → Apps Script**
2. Delete any default content
3. Create three files: `appsscript.json`, `Code.gs`, `Sidebar.html`
4. Paste the contents of each file from this project
5. Click **"+" next to Services** → add **Drive API v3**
6. Save

This installs the add-on as a bound script — it only works in that one specific document.

---

## Script Properties (advanced)

Instead of the sidebar UI, set properties directly in the Apps Script editor:

1. **Project Settings** (gear icon) → **Script Properties**
2. Add:
   - `anthropicApiKey` → your Anthropic API key
   - `REGISTER_SECRET` → must match the value in GCP Secret Manager
   - `SERVICE_BASE_URL` → your Cloud Run service URL

---

## OAuth Scopes

| Scope | Reason |
|---|---|
| `documents.currentonly` | Read the active document's text to build context for Claude |
| `drive` | Register Drive Change watches via Drive API v3 |
| `script.external_request` | Make HTTPS requests to the Cloud Run service |
| `script.container.ui` | Display the sidebar inside Google Docs |

---

## Limits

- **Watch expiry** — Drive watches expire after 6 days. A daily Apps Script trigger checks all activated docs and notifies you by email if a watch is expiring. You'll need to reactivate from the sidebar to renew.
- **Cooldown dedup** — Drive fires webhooks on every file mutation (edits, autosaves), not just comment additions. The service coalesces bursts into a single Claude call with a 15-second cooldown window.
- **Document context cache** — Document summaries (for docs over 1,000 words) are cached in Firestore for 1 hour.

---

## Pricing

All costs billed to your Anthropic account.

| Model | Input | Output | When used |
|---|---|---|---|
| claude-sonnet-4-6 | ~$3/MTok | ~$15/MTok | Every invocation |
| claude-haiku-4-5 | ~$0.25/MTok | ~$1.25/MTok | Once per session, docs >1,000 words |
| Web search | varies | — | When Claude decides to search |

A typical comment + context + response is a few hundred to a couple thousand tokens — well under a cent for most uses.
