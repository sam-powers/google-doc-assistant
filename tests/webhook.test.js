import workerDefault, { handleWebhook, handleRegister } from '../worker/index.js';

function makeRequest(method, pathname, headers = {}, body = null) {
  const url = `https://worker.example.com${pathname}`;
  const opts = { method, headers: new Headers(headers) };
  if (body !== null) opts.body = JSON.stringify(body);
  return new Request(url, opts);
}

function makeEnv(kvData = {}) {
  const store = new Map(Object.entries(kvData));
  return {
    DOC_CONFIGS: {
      get: vi.fn(async key => store.get(key) ?? null),
      put: vi.fn(async (key, val) => store.set(key, val)),
      delete: vi.fn(async key => store.delete(key)),
    },
    REGISTER_SECRET: 'secret123',
  };
}

describe('handleWebhook', () => {
  it('returns 200 immediately for sync ping without touching KV', async () => {
    const env = makeEnv();
    const req = makeRequest('POST', '/webhook', { 'X-Goog-Resource-State': 'sync' });
    const res = await handleWebhook(req, env, { waitUntil: vi.fn() });
    expect(res.status).toBe(200);
    expect(env.DOC_CONFIGS.get).not.toHaveBeenCalled();
  });

  it('returns 200 and does not touch KV when channelToken header is missing', async () => {
    const env = makeEnv();
    const req = makeRequest('POST', '/webhook', { 'X-Goog-Resource-State': 'change' });
    const res = await handleWebhook(req, env, { waitUntil: vi.fn() });
    expect(res.status).toBe(200);
    expect(env.DOC_CONFIGS.get).not.toHaveBeenCalled();
  });

  it('returns 200 when KV has no config for the token', async () => {
    const env = makeEnv(); // empty KV
    const req = makeRequest('POST', '/webhook', {
      'X-Goog-Resource-State': 'change',
      'X-Goog-Channel-Token': 'unknown-token',
      'X-Goog-Channel-ID': 'cid1',
    });
    const res = await handleWebhook(req, env, { waitUntil: vi.fn() });
    expect(res.status).toBe(200);
  });

  it('returns 200 and calls ctx.waitUntil when config matches channelId', async () => {
    const config = JSON.stringify({ docId: 'doc1', channelId: 'cid1', anthropicApiKey: 'key', activatedAt: Date.now() });
    const env = makeEnv({ 'my-token': config });
    const ctx = { waitUntil: vi.fn() };
    const req = makeRequest('POST', '/webhook', {
      'X-Goog-Resource-State': 'change',
      'X-Goog-Channel-Token': 'my-token',
      'X-Goog-Channel-ID': 'cid1',
    });
    const res = await handleWebhook(req, env, ctx);
    expect(res.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('returns 200 but does NOT call ctx.waitUntil when channelId mismatches', async () => {
    const config = JSON.stringify({ docId: 'doc1', channelId: 'correct-channel', anthropicApiKey: 'key', activatedAt: Date.now() });
    const env = makeEnv({ 'my-token': config });
    const ctx = { waitUntil: vi.fn() };
    const req = makeRequest('POST', '/webhook', {
      'X-Goog-Resource-State': 'change',
      'X-Goog-Channel-Token': 'my-token',
      'X-Goog-Channel-ID': 'wrong-channel',
    });
    const res = await handleWebhook(req, env, ctx);
    expect(res.status).toBe(200);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
});

describe('handleRegister', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const env = makeEnv();
    const req = makeRequest('POST', '/register', {});
    const res = await handleRegister(req, env);
    expect(res.status).toBe(401);
  });

  it('returns 401 when token does not match REGISTER_SECRET', async () => {
    const env = makeEnv();
    const req = makeRequest('POST', '/register', { Authorization: 'Bearer wrong-secret' });
    const res = await handleRegister(req, env);
    expect(res.status).toBe(401);
  });

  it('returns 200 and writes two KV entries on valid registration', async () => {
    const env = makeEnv();
    const req = makeRequest(
      'POST', '/register',
      { Authorization: 'Bearer secret123', 'Content-Type': 'application/json' },
      { channelToken: 'ct1', channelId: 'ci1', docId: 'di1', anthropicApiKey: 'ak1', activatedAt: 0 }
    );
    const res = await handleRegister(req, env);
    expect(res.status).toBe(200);
    // Writes channelToken key and canonical_docId key
    expect(env.DOC_CONFIGS.put).toHaveBeenCalledTimes(2);
    const keys = env.DOC_CONFIGS.put.mock.calls.map(c => c[0]);
    expect(keys).toContain('ct1');
    expect(keys).toContain('canonical_di1');
  });

  it('returns 400 when required fields are missing from the body', async () => {
    const env = makeEnv();
    const req = makeRequest(
      'POST', '/register',
      { Authorization: 'Bearer secret123', 'Content-Type': 'application/json' },
      { channelToken: 'ct1' } // missing channelId, docId, anthropicApiKey
    );
    const res = await handleRegister(req, env);
    expect(res.status).toBe(400);
  });
});

describe('default fetch handler routing', () => {
  it('returns 404 for unknown routes', async () => {
    const req = new Request('https://worker.example.com/unknown', { method: 'GET' });
    const res = await workerDefault.fetch(req, makeEnv(), { waitUntil: vi.fn() });
    expect(res.status).toBe(404);
  });
});
