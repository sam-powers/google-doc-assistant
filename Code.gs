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
    apiKey: props.getProperty('anthropicApiKey') || ''
  };
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

function activate(apiKey) {
  if (!apiKey || !apiKey.trim()) throw new Error('API key is required.');
  apiKey = apiKey.trim();

  var props = PropertiesService.getUserProperties();
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

  // Step 3: Register with Cloud Run service (HMAC-signed)
  var activatedAt = Date.now();
  var body = JSON.stringify({
    channelToken: channelToken,
    channelId: channelId,
    docId: docId,
    anthropicApiKey: apiKey,
    activatedAt: activatedAt
  });
  var registerSecret = PropertiesService.getScriptProperties().getProperty('REGISTER_SECRET');
  var timestamp = String(Math.floor(activatedAt / 1000));
  var signature = computeHmacSignature(registerSecret, timestamp, body);

  var response = UrlFetchApp.fetch(getWorkerRegisterUrl(), {
    method: 'post',
    headers: {
      'X-Timestamp': timestamp,
      'X-Signature': signature,
      'Content-Type': 'application/json'
    },
    payload: body,
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('Worker registration failed: ' + response.getContentText());
  }

  // Step 4: Save API key and watch metadata now that registration succeeded
  props.setProperty('anthropicApiKey', apiKey);
  setDocWatch(docId, channelId, channelToken, resourceId, expiration);

  // Step 5: Install daily renewal trigger (one trigger covers all docs)
  installRenewalTrigger();

  return { success: true, expiresAt: new Date(expiration).toLocaleDateString() };
}

// ─── HMAC-SHA256 request signing ──────────────────────────────────────────────
// Signs outbound requests to Cloud Run so the service can verify they originated
// from Apps Script and were not replayed. Format: HMAC-SHA256(secret, timestamp + "." + body).

function computeHmacSignature(secret, timestamp, body) {
  var message = timestamp + '.' + body;
  var signatureBytes = Utilities.computeHmacSha256Signature(message, secret);
  return Utilities.base64Encode(signatureBytes);
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

    // Notify the user so they know to reactivate
    try {
      var userEmail = Session.getActiveUser().getEmail();
      if (userEmail) {
        MailApp.sendEmail({
          to: userEmail,
          subject: 'Claude Assistant: reactivation required',
          body: 'Your Claude Assistant session for document ' + docId + ' has expired.\n\n' +
                'Open the document and click "Open Claude Assistant" in the Extensions menu to reactivate.\n\n' +
                'This is a one-time notification — Claude will not respond to @claude comments until you reactivate.'
        });
      }
    } catch (e) {
      Logger.log('Could not send expiry notification email: ' + e.message);
    }
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
      var unregBody = JSON.stringify({ channelToken: watch.channelToken, docId: docId });
      var timestamp = String(Math.floor(Date.now() / 1000));
      var signature = computeHmacSignature(registerSecret, timestamp, unregBody);
      var unregResponse = UrlFetchApp.fetch(workerUnregisterUrl, {
        method: 'post',
        headers: {
          'X-Timestamp': timestamp,
          'X-Signature': signature,
          'Content-Type': 'application/json'
        },
        payload: unregBody,
        muteHttpExceptions: true
      });
      if (unregResponse.getResponseCode() !== 200) {
        Logger.log('Unregister failed (' + unregResponse.getResponseCode() + '): ' + unregResponse.getContentText());
      }
    } catch (e) {
      Logger.log('Could not unregister from worker: ' + e.message);
    }
  }

  // Clear watch state and API key for this doc's session
  clearDocWatch(docId);
  PropertiesService.getUserProperties().deleteProperty('anthropicApiKey');

  return { success: true };
}

// ─── API Key Validation ───────────────────────────────────────────────────────

function testApiKey(apiKey) {
  var options = {
    method: 'post',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Hi' }]
    }),
    muteHttpExceptions: true
  };

  try {
    var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', options);
    if (response.getResponseCode() === 200) return { ok: true };
    var body = response.getContentText();
    try {
      var parsed = JSON.parse(body);
      return { ok: false, error: (parsed.error && parsed.error.message) || body };
    } catch (e) {
      return { ok: false, error: body };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
