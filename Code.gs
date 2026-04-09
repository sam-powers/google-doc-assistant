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
    claudeEmail: props.getProperty('claudeEmail') || ''
  };
}

function saveSettings(apiKey, claudeEmail) {
  var props = PropertiesService.getUserProperties();
  props.setProperty('anthropicApiKey', apiKey);
  props.setProperty('claudeEmail', claudeEmail.toLowerCase().trim());
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
  var words = bodyText.split(/\s+/).filter(function(w) { return w.length > 0; });
  var wordCount = words.length;

  var context;
  if (wordCount <= 500) {
    context = bodyText;
  } else {
    var excerpt = words.slice(0, 2000).join(' ');
    context = summarizeWithHaiku(excerpt);
    cache.put(cacheKey, context, 21600);
  }

  return context;
}

// ─── Summarization ────────────────────────────────────────────────────────────

function summarizeWithHaiku(text) {
  var settings = getSettings();
  var payload = {
    model: 'claude-haiku-4-5',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: 'Summarize this document in 2-3 sentences for context:\n\n' + text
      }
    ]
  };

  try {
    var response = callAnthropicApi(payload, settings.apiKey);
    var textBlocks = response.content.filter(function(b) { return b.type === 'text'; });
    var lastBlock = textBlocks.pop();
    if (lastBlock && lastBlock.text) {
      return lastBlock.text;
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
        anchorText: truncate(anchorText, 60),
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
          anchorText: truncate(anchorText, 60),
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
  return 'You are an assistant embedded in a Google Doc.\n' +
    'Help with whatever the user asks \u2014 research, editing, rewriting, brainstorming, etc.\n' +
    'Be concise. If you search the web, include sources at the end of your reply.\n\n' +
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
    max_tokens: 1024,
    system: systemPrompt,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: messages
  };

  var response = callAnthropicApi(payload, settings.apiKey);

  var textBlocks = response.content.filter(function(b) { return b.type === 'text'; });
  var lastTextBlock = textBlocks.pop();

  if (!lastTextBlock || !lastTextBlock.text) {
    throw new Error('No text content in Anthropic response.');
  }

  var replyText = lastTextBlock.text;

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
