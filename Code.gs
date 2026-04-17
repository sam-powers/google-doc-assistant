// ─── v2 Constants ─────────────────────────────────────────────────────────────
var SERVICE_ACCOUNT_EMAIL = 'claude-assistant@claude-doc-assistant.iam.gserviceaccount.com';
var WATCH_DURATION_MS = 6 * 24 * 60 * 60 * 1000; // 6 days in ms

function getServiceBaseUrl() {
  var url = PropertiesService.getScriptProperties().getProperty('SERVICE_BASE_URL');
  if (!url) throw new Error('SERVICE_BASE_URL script property is not set.');
  return url.replace(/\/$/, ''); // strip trailing slash
}

function getWorkerWebhookUrl()  { return getServiceBaseUrl() + '/webhook'; }
function getWorkerRegisterUrl() { return getServiceBaseUrl() + '/register'; }

// ─── Menu ────────────────────────────────────────────────────────────────────

function onOpen(e) {
  DocumentApp.getUi()
    .createAddonMenu()
    .addItem('Open Claude Assistant', 'showSidebar')
    .addToUi();
}

function onInstall(e) {
  onOpen(e);
}

function showSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Claude Assistant')
    .setWidth(350);
  DocumentApp.getUi().showSidebar(html);
}

// ─── Settings ────────────────────────────────────────────────────────────────

function getSettings() {
  var props = PropertiesService.getUserProperties();
  return {
    apiKey: props.getProperty('anthropicApiKey') || '',
    claudeEmail: SERVICE_ACCOUNT_EMAIL
  };
}

function saveSettings(apiKey) {
  var props = PropertiesService.getUserProperties();
  props.setProperty('anthropicApiKey', apiKey);
}

// ─── Watch Setup ──────────────────────────────────────────────────────────────

// ─── Per-doc watch helpers ────────────────────────────────────────────────────

function getDocWatch(docId) {
  var props = PropertiesService.getUserProperties();
  var channelId  = props.getProperty('watch_' + docId + '_channelId');
  var expiration = parseInt(props.getProperty('watch_' + docId + '_expiration') || '0', 10);
  if (!channelId || !expiration) return null;
  return {
    channelId:    channelId,
    channelToken: props.getProperty('watch_' + docId + '_channelToken'),
    resourceId:   props.getProperty('watch_' + docId + '_resourceId'),
    expiration:   expiration
  };
}

function setDocWatch(docId, channelId, channelToken, resourceId, expiration) {
  var props = PropertiesService.getUserProperties();
  props.setProperty('watch_' + docId + '_channelId',    channelId);
  props.setProperty('watch_' + docId + '_channelToken', channelToken);
  props.setProperty('watch_' + docId + '_resourceId',   resourceId);
  props.setProperty('watch_' + docId + '_expiration',   String(expiration));

  // Keep a list of all activated docIds for renewal trigger
  var raw = props.getProperty('watchDocIds');
  var ids = raw ? JSON.parse(raw) : [];
  if (ids.indexOf(docId) === -1) ids.push(docId);
  props.setProperty('watchDocIds', JSON.stringify(ids));
}

function clearDocWatch(docId) {
  var props = PropertiesService.getUserProperties();
  props.deleteProperty('watch_' + docId + '_channelId');
  props.deleteProperty('watch_' + docId + '_channelToken');
  props.deleteProperty('watch_' + docId + '_resourceId');
  props.deleteProperty('watch_' + docId + '_expiration');

  var raw = props.getProperty('watchDocIds');
  var ids = raw ? JSON.parse(raw) : [];
  ids = ids.filter(function(id) { return id !== docId; });
  props.setProperty('watchDocIds', JSON.stringify(ids));
}

// ─── Watch Setup ──────────────────────────────────────────────────────────────

function setupDoc() {
  var props = PropertiesService.getUserProperties();
  var apiKey = props.getProperty('anthropicApiKey');
  if (!apiKey) throw new Error('API key not saved. Please complete step 1 first.');

  var docId = DocumentApp.getActiveDocument().getId();

  // Step 1: Share doc with service account as commenter
  try {
    Drive.Permissions.create(
      { role: 'commenter', type: 'user', emailAddress: SERVICE_ACCOUNT_EMAIL },
      docId,
      { sendNotificationEmail: false, fields: 'id' }
    );
  } catch (e) {
    if (e.message && e.message.toLowerCase().indexOf('already') === -1 &&
        e.message.toLowerCase().indexOf('duplicate') === -1) {
      throw new Error('Could not share document with Claude: ' + e.message);
    }
  }

  // Stop any existing watch for this doc before registering a new one
  var existing = getDocWatch(docId);
  if (existing && existing.channelId && existing.resourceId) {
    try {
      Drive.Channels.stop({ id: existing.channelId, resourceId: existing.resourceId });
    } catch (e) {
      Logger.log('Could not stop old channel (may have already expired): ' + e.message);
    }
  }

  // Step 2: Register Drive Changes watch
  var channelId = Utilities.getUuid();
  var channelToken = Utilities.getUuid();
  var expiration = Date.now() + WATCH_DURATION_MS;

  var startPageToken = Drive.Changes.getStartPageToken().startPageToken;
  var watchResource = {
    id: channelId,
    type: 'web_hook',
    address: getWorkerWebhookUrl(),
    token: channelToken,
    expiration: String(expiration)
  };
  var watchResponse = Drive.Changes.watch(watchResource, startPageToken);
  var resourceId = watchResponse.resourceId;

  // Step 3: Register with Cloudflare Worker
  var registerSecret = PropertiesService.getScriptProperties().getProperty('REGISTER_SECRET');
  var response = UrlFetchApp.fetch(getWorkerRegisterUrl(), {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + registerSecret,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      channelToken: channelToken,
      channelId: channelId,
      docId: docId,
      anthropicApiKey: apiKey,
      activatedAt: Date.now()
    }),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('Worker registration failed: ' + response.getContentText());
  }

  // Step 4: Store watch metadata keyed by docId
  setDocWatch(docId, channelId, channelToken, resourceId, expiration);

  // Step 5: Install daily renewal trigger (one trigger covers all docs)
  installRenewalTrigger();

  return { success: true, expiresAt: new Date(expiration).toLocaleDateString() };
}

function renewWatch() {
  var props = PropertiesService.getUserProperties();
  var raw = props.getProperty('watchDocIds');
  if (!raw) return;
  var docIds = JSON.parse(raw);
  var now = Date.now();
  var twentyFourHours = 24 * 60 * 60 * 1000;

  for (var i = 0; i < docIds.length; i++) {
    var docId = docIds[i];
    var watch = getDocWatch(docId);
    if (!watch) continue;
    if (watch.expiration - now > twentyFourHours) continue;

    // Stop old channel
    if (watch.channelId && watch.resourceId) {
      try {
        Drive.Channels.stop({ id: watch.channelId, resourceId: watch.resourceId });
      } catch (e) {
        Logger.log('Could not stop old channel for ' + docId + ': ' + e.message);
      }
    }

    // Re-register — needs apiKey, but we can't open a doc by ID from a trigger context.
    // Clear the expired entry; user will need to reactivate from the sidebar.
    clearDocWatch(docId);
    Logger.log('Watch expired for docId=' + docId + ', cleared. User must reactivate.');
  }
}

function installRenewalTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'renewWatch') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('renewWatch')
    .timeBased()
    .everyDays(1)
    .create();
}

function getWatchStatus() {
  var docId = DocumentApp.getActiveDocument().getId();
  var watch = getDocWatch(docId);

  if (!watch) return { active: false };

  var now = Date.now();
  if (watch.expiration < now) {
    clearDocWatch(docId);
    return { active: false, expired: true };
  }

  return {
    active: true,
    expiresAt: new Date(watch.expiration).toLocaleDateString(),
    hoursRemaining: Math.floor((watch.expiration - now) / (1000 * 60 * 60))
  };
}

function deactivateDoc() {
  var docId = DocumentApp.getActiveDocument().getId();
  var watch = getDocWatch(docId);

  // Stop the Drive watch channel
  if (watch && watch.channelId && watch.resourceId) {
    try {
      Drive.Channels.stop({ id: watch.channelId, resourceId: watch.resourceId });
    } catch (e) {
      Logger.log('Could not stop channel (may have already expired): ' + e.message);
    }
  }

  // Tell the worker to clear the canonical entry for this doc
  if (watch && watch.channelToken) {
    try {
      var registerSecret = PropertiesService.getScriptProperties().getProperty('REGISTER_SECRET');
      var workerUnregisterUrl = getServiceBaseUrl() + '/unregister';
      UrlFetchApp.fetch(workerUnregisterUrl, {
        method: 'post',
        headers: {
          'Authorization': 'Bearer ' + registerSecret,
          'Content-Type': 'application/json'
        },
        payload: JSON.stringify({ channelToken: watch.channelToken, docId: docId }),
        muteHttpExceptions: true
      });
    } catch (e) {
      Logger.log('Could not unregister from worker: ' + e.message);
    }
  }

  // Clear watch state and API key for this doc's session
  clearDocWatch(docId);
  PropertiesService.getUserProperties().deleteProperty('anthropicApiKey');

  return { success: true };
}

// ─── Document Context ─────────────────────────────────────────────────────────

function getDocumentContext(docId) {
  var cache = CacheService.getUserCache();
  var cacheKey = 'doc_summary_' + docId;
  var cached = cache.get(cacheKey);
  if (cached !== null) {
    return cached;
  }

  var bodyText = DocumentApp.getActiveDocument().getBody().getText();
  var wordCount = bodyText.trim().split(/\s+/).length;

  var context;
  if (wordCount <= 1000) {
    context = bodyText;
  } else {
    var targetWords = Math.max(Math.round(wordCount * 0.1), 1000);
    context = summarizeWithHaiku(bodyText, targetWords);
    cache.put(cacheKey, context, 3600);
  }

  return context;
}

// ─── Summarization ────────────────────────────────────────────────────────────

function summarizeWithHaiku(text, targetWords) {
  var settings = getSettings();
  var payload = {
    model: 'claude-haiku-4-5',
    max_tokens: Math.ceil((targetWords / 0.75) * 1.1),
    messages: [
      {
        role: 'user',
        content: 'Summarize this document in approximately ' + targetWords + ' words. Focus on:\n- Overall structure and organization\n- A brief outline of main sections\n- Key points and arguments\n- Important quotes or specific language worth preserving\n- The document\'s tone and writing style (e.g. formal/informal, technical/conversational, persuasive/neutral, first/third person)\n\nDocument:\n\n' + text
      }
    ]
  };

  try {
    var response = callAnthropicApi(payload, settings.apiKey);
    var textBlocks = response.content.filter(function(b) { return b.type === 'text' && b.text; });
    if (textBlocks.length > 0) {
      return textBlocks.map(function(b) { return b.text; }).join('\n\n');
    }
  } catch (e) {
    Logger.log('summarizeWithHaiku error: ' + e.message);
  }

  return text.slice(0, 500);
}

// ─── Processed IDs ────────────────────────────────────────────────────────────

function getProcessedIds() {
  var props = PropertiesService.getUserProperties();
  var raw = props.getProperty('processedReplyIds');
  if (!raw) return new Set();
  try {
    var arr = JSON.parse(raw);
    return new Set(arr);
  } catch (e) {
    return new Set();
  }
}

function markProcessed(replyId) {
  var props = PropertiesService.getUserProperties();
  var raw = props.getProperty('processedReplyIds');
  var arr = [];
  if (raw) {
    try {
      arr = JSON.parse(raw);
    } catch (e) {
      arr = [];
    }
  }
  if (arr.indexOf(replyId) === -1) {
    arr.push(replyId);
  }
  if (arr.length > 200) {
    arr = arr.slice(arr.length - 200);
  }
  props.setProperty('processedReplyIds', JSON.stringify(arr));
}

// ─── Pending Invocations ──────────────────────────────────────────────────────

function getPendingInvocations() {
  var settings = getSettings();
  if (!settings.apiKey || !settings.claudeEmail) {
    return { needsSetup: true };
  }

  var docId = DocumentApp.getActiveDocument().getId();
  var processedIds = getProcessedIds();
  var pending = [];
  var pageToken = null;

  do {
    var params = {
      pageSize: 100,
      fields: 'comments(id,content,quotedFileContent,author,resolved,replies(id,content,author)),nextPageToken',
      includeDeleted: false
    };
    if (pageToken) {
      params.pageToken = pageToken;
    }

    var result = Drive.Comments.list(docId, params);
    var comments = result.comments || [];

    for (var i = 0; i < comments.length; i++) {
      var comment = comments[i];
      if (!comment.resolved) {
        processComment(comment, settings.claudeEmail, processedIds, pending);
      }
    }

    pageToken = result.nextPageToken || null;
  } while (pageToken);

  return { pending: pending, needsSetup: false };
}

// ─── processComment ───────────────────────────────────────────────────────────

function processComment(comment, claudeEmail, processedIds, pending) {
  var anchorText = (comment.quotedFileContent && comment.quotedFileContent.value) || '';
  var replies = comment.replies || [];

  // Check top-level comment for @claude mention
  if (/@claude/i.test(comment.content)) {
    var alreadyAnswered = false;
    if (replies.length > 0) {
      var lastReply = replies[replies.length - 1];
      var lastReplyAuthorEmail = (lastReply.author && lastReply.author.emailAddress)
        ? lastReply.author.emailAddress.toLowerCase()
        : '';
      if (lastReplyAuthorEmail === claudeEmail || processedIds.has(lastReply.id)) {
        alreadyAnswered = true;
      }
    }
    if (!alreadyAnswered) {
      pending.push({
        commentId: comment.id,
        replyId: null,
        anchorText: anchorText,
        prompt: comment.content.replace(/@claude/gi, '').trim()
      });
      return; // Top-level @claude not yet answered — don't also scan replies
    }
    // Top-level @claude already answered — fall through to check reply-level @claude invocations
  }

  // Check each reply for @claude mention
  for (var i = 0; i < replies.length; i++) {
    var reply = replies[i];
    if (/@claude/i.test(reply.content)) {
      var nextReply = replies[i + 1] || null;
      var replyAlreadyAnswered = false;
      if (nextReply) {
        var nextAuthorEmail = (nextReply.author && nextReply.author.emailAddress)
          ? nextReply.author.emailAddress.toLowerCase()
          : '';
        if (nextAuthorEmail === claudeEmail || processedIds.has(nextReply.id)) {
          replyAlreadyAnswered = true;
        }
      }
      if (!replyAlreadyAnswered) {
        pending.push({
          commentId: comment.id,
          replyId: reply.id,
          anchorText: anchorText,
          prompt: reply.content.replace(/@claude/gi, '').trim()
        });
      }
    }
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '\u2026';
}

// ─── Thread History ───────────────────────────────────────────────────────────

function buildThreadHistory(comment, claudeEmail) {
  var messages = [];

  // Top-level comment is always the user's initial message
  var topContent = comment.content.replace(/@claude/gi, '').trim();
  messages.push({ role: 'user', content: topContent });

  var replies = comment.replies || [];
  for (var i = 0; i < replies.length; i++) {
    var reply = replies[i];
    var replyAuthorEmail = (reply.author && reply.author.emailAddress)
      ? reply.author.emailAddress.toLowerCase()
      : '';
    var role = replyAuthorEmail === claudeEmail ? 'assistant' : 'user';
    var content = reply.content.replace(/@claude/gi, '').trim();
    messages.push({ role: role, content: content });
  }

  return messages;
}

function normalizeMessages(messages) {
  if (!messages || messages.length === 0) return [];
  var normalized = [];
  var current = { role: messages[0].role, content: messages[0].content };

  for (var i = 1; i < messages.length; i++) {
    var msg = messages[i];
    if (msg.role === current.role) {
      current.content = current.content + '\n\n' + msg.content;
    } else {
      normalized.push(current);
      current = { role: msg.role, content: msg.content };
    }
  }
  normalized.push(current);
  return normalized;
}

// ─── Anthropic API ────────────────────────────────────────────────────────────

function callAnthropicApi(payload, apiKey) {
  var options = {
    method: 'post',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code !== 200) {
    var errMsg = 'Anthropic API error ' + code;
    try {
      var parsed = JSON.parse(body);
      if (parsed.error && parsed.error.message) {
        errMsg += ': ' + parsed.error.message;
      } else {
        errMsg += ': ' + body;
      }
    } catch (e) {
      errMsg += ': ' + body;
    }
    throw new Error(errMsg);
  }

  return JSON.parse(body);
}

// ─── System Prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(docContext, anchorText) {
  return 'You are an assistant embedded in a Google Doc.\n\n' +
    'If the request is about research, facts, or questions: respond concisely and directly.\n' +
    'If the request is about writing, editing, or rewriting: match the document\'s tone and style as described in the document context below.\n\n' +
    'If you search the web, include sources at the end of your reply.\n\n' +
    'Document context:\n"' + docContext + '"\n\n' +
    'Highlighted text:\n"' + anchorText + '"';
}

// ─── Process a Single Invocation ─────────────────────────────────────────────

function processInvocation(commentId, replyId) {
  var settings = getSettings();
  if (!settings.apiKey || !settings.claudeEmail) {
    throw new Error('Missing API key or Claude email. Please complete setup.');
  }

  var docId = DocumentApp.getActiveDocument().getId();

  var comment = Drive.Comments.get(docId, commentId, {
    fields: 'id,content,quotedFileContent,author,resolved,replies(id,content,author)'
  });

  var docContext = getDocumentContext(docId);
  var anchorText = (comment.quotedFileContent && comment.quotedFileContent.value) || '';

  var messages = buildThreadHistory(comment, settings.claudeEmail);
  messages = normalizeMessages(messages);

  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    throw new Error('Last message in thread is not from user. Nothing to respond to.');
  }

  var systemPrompt = buildSystemPrompt(docContext, anchorText);

  var payload = {
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    system: systemPrompt,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: messages
  };

  var response = callAnthropicApi(payload, settings.apiKey);

  var textBlocks = response.content.filter(function(b) { return b.type === 'text' && b.text; });

  if (textBlocks.length === 0) {
    throw new Error('No text content in Anthropic response.');
  }

  var replyText = textBlocks.map(function(b) { return b.text; }).join('\n\n');

  var posted = Drive.Replies.create(
    { content: replyText },
    docId,
    commentId,
    { fields: 'id' }
  );

  markProcessed(posted.id);

  return { success: true };
}

// ─── Process All Invocations ──────────────────────────────────────────────────

function processAllInvocations() {
  var result = getPendingInvocations();

  if (result.needsSetup || !result.pending || result.pending.length === 0) {
    return { processed: 0, errors: [] };
  }

  var processed = 0;
  var errors = [];

  for (var i = 0; i < result.pending.length; i++) {
    var item = result.pending[i];
    try {
      processInvocation(item.commentId, item.replyId);
      processed++;
    } catch (e) {
      errors.push({ commentId: item.commentId, error: e.message });
    }
  }

  return { processed: processed, errors: errors };
}

// ─── API Key Validation ───────────────────────────────────────────────────────

function testApiKey(apiKey) {
  try {
    var payload = {
      model: 'claude-haiku-4-5',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Hi' }]
    };
    callAnthropicApi(payload, apiKey);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function testGetPending() {
  var result = getPendingInvocations();
  Logger.log(JSON.stringify(result));
}

function testAnthropicCall() {
  var settings = getSettings();
  var payload = {
    model: 'claude-haiku-4-5',
    max_tokens: 50,
    messages: [{ role: 'user', content: 'Say hello.' }]
  };
  var response = callAnthropicApi(payload, settings.apiKey);
  Logger.log(JSON.stringify(response));
}

function testDriveList() {
  var docId = DocumentApp.getActiveDocument().getId();
  var result = Drive.Comments.list(docId, { fields: '*', pageSize: 5 });
  Logger.log(JSON.stringify(result));
}
