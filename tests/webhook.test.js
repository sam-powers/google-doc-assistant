import { handleWebhook, handleRegister } from '../cloud-run/index.js';
import * as firestore from '../cloud-run/firestore.js';

vi.mock('../cloud-run/firestore.js', () => ({
  kvGet: vi.fn(),
  kvPut: vi.fn(),
  kvDelete: vi.fn(),
}));

// Minimal Express-style req/res helpers
function makeReq(headers = {}, body = {}) {
  return { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), body };
}

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    send(body) { this._body = body; return this; },
    end() { return this; },
  };
  return res;
}

describe('handleWebhook', () => {
  beforeEach(() => {
    vi.mocked(firestore.kvGet).mockResolvedValue(null);
    vi.mocked(firestore.kvPut).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 immediately for sync ping without touching KV', async () => {
    const req = makeReq({ 'x-goog-resource-state': 'sync' });
    const res = makeRes();
    await handleWebhook(req, res);
    expect(res._status).toBe(200);
    expect(firestore.kvGet).not.toHaveBeenCalled();
  });

  it('returns 200 and does not touch KV when channelToken header is missing', async () => {
    const req = makeReq({ 'x-goog-resource-state': 'change' });
    const res = makeRes();
    await handleWebhook(req, res);
    expect(res._status).toBe(200);
    expect(firestore.kvGet).not.toHaveBeenCalled();
  });

  it('returns 200 when KV has no config for the token', async () => {
    vi.mocked(firestore.kvGet).mockResolvedValue(null);
    const req = makeReq({
      'x-goog-resource-state': 'change',
      'x-goog-channel-token': 'unknown-token',
      'x-goog-channel-id': 'cid1',
    });
    const res = makeRes();
    await handleWebhook(req, res);
    expect(res._status).toBe(200);
  });

  it('returns 200 and dispatches processDoc when config matches channelId', async () => {
    const config = JSON.stringify({ docId: 'doc1', channelId: 'cid1', anthropicApiKey: 'key', activatedAt: Date.now() });
    vi.mocked(firestore.kvGet).mockResolvedValue(config);
    const req = makeReq({
      'x-goog-resource-state': 'change',
      'x-goog-channel-token': 'my-token',
      'x-goog-channel-id': 'cid1',
    });
    const res = makeRes();
    await handleWebhook(req, res);
    // Fire-and-forget: res.status(200).end() is called before processDoc runs
    expect(res._status).toBe(200);
  });

  it('returns 200 but does not dispatch processDoc when channelId mismatches', async () => {
    const config = JSON.stringify({ docId: 'doc1', channelId: 'correct-channel', anthropicApiKey: 'key', activatedAt: Date.now() });
    vi.mocked(firestore.kvGet).mockResolvedValue(config);
    const req = makeReq({
      'x-goog-resource-state': 'change',
      'x-goog-channel-token': 'my-token',
      'x-goog-channel-id': 'wrong-channel',
    });
    const res = makeRes();
    await handleWebhook(req, res);
    expect(res._status).toBe(200);
    // Only one kvGet call (for the token lookup), no second call for canonical check
    expect(firestore.kvGet).toHaveBeenCalledTimes(1);
  });
});

describe('handleRegister', () => {
  beforeEach(() => {
    vi.mocked(firestore.kvPut).mockResolvedValue(undefined);
    process.env.REGISTER_SECRET = 'secret123';
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.REGISTER_SECRET;
  });

  it('returns 401 when Authorization header is missing', async () => {
    const req = makeReq({}, {});
    const res = makeRes();
    await handleRegister(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 401 when token does not match REGISTER_SECRET', async () => {
    const req = makeReq({ authorization: 'Bearer wrong-secret' }, {});
    const res = makeRes();
    await handleRegister(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 200 and writes two KV entries on valid registration', async () => {
    const req = makeReq(
      { authorization: 'Bearer secret123' },
      { channelToken: 'ct1', channelId: 'ci1', docId: 'di1', anthropicApiKey: 'ak1', activatedAt: 0 }
    );
    const res = makeRes();
    await handleRegister(req, res);
    expect(res._status).toBe(200);
    // Writes channelToken key and canonical_docId key
    expect(firestore.kvPut).toHaveBeenCalledTimes(2);
    const keys = vi.mocked(firestore.kvPut).mock.calls.map(c => c[0]);
    expect(keys).toContain('ct1');
    expect(keys).toContain('canonical_di1');
  });

  it('returns 400 when required fields are missing from the body', async () => {
    const req = makeReq(
      { authorization: 'Bearer secret123' },
      { channelToken: 'ct1' } // missing channelId, docId, anthropicApiKey
    );
    const res = makeRes();
    await handleRegister(req, res);
    expect(res._status).toBe(400);
  });
});
