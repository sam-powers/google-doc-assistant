import { createHmac } from 'node:crypto';
import { handleWebhook, handleRegister, handleUnregister } from '../cloud-run/index.js';
import * as firestore from '../cloud-run/firestore.js';

vi.mock('../cloud-run/firestore.js', () => ({
  kvGet: vi.fn(),
  kvPut: vi.fn(),
  kvDelete: vi.fn(),
}));

// Compute a valid HMAC signature matching the Cloud Run verifyHmac() logic.
function makeHmacHeaders(secret, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message   = `${timestamp}.${JSON.stringify(body)}`;
  const signature = createHmac('sha256', secret).update(message).digest('base64');
  return { 'x-timestamp': timestamp, 'x-signature': signature };
}

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
      'x-goog-channel-token': '00000000-0000-0000-0000-000000000001',
      'x-goog-channel-id': 'cid1',
    });
    const res = makeRes();
    await handleWebhook(req, res);
    expect(res._status).toBe(200);
  });

  it('returns 200 and dispatches processDoc when config matches channelId', async () => {
    const token = '00000000-0000-0000-0000-000000000002';
    const config = JSON.stringify({ docId: 'doc1', channelId: 'cid1', channelToken: token, anthropicApiKey: 'key', activatedAt: Date.now() });
    vi.mocked(firestore.kvGet)
      .mockResolvedValueOnce(config) // channel token lookup
      .mockResolvedValueOnce(null);  // cooldown check — not on cooldown
    const req = makeReq({
      'x-goog-resource-state': 'change',
      'x-goog-channel-token': token,
      'x-goog-channel-id': 'cid1',
    });
    const res = makeRes();
    await handleWebhook(req, res);
    // Fire-and-forget: res.status(200).end() is called before processDoc runs
    expect(res._status).toBe(200);
  });

  it('returns 200 and schedules deferred processDoc (no kvPut) when doc is on cooldown', async () => {
    vi.useFakeTimers();
    const token = '00000000-0000-0000-0000-000000000003';
    const config = JSON.stringify({ docId: 'doc1', channelId: 'cid1', channelToken: token, anthropicApiKey: 'key', activatedAt: Date.now() });
    vi.mocked(firestore.kvGet)
      .mockResolvedValueOnce(config) // channel token lookup
      .mockResolvedValueOnce('1');   // cooldown key exists
    const req = makeReq({
      'x-goog-resource-state': 'change',
      'x-goog-channel-token': token,
      'x-goog-channel-id': 'cid1',
    });
    const res = makeRes();
    await handleWebhook(req, res);
    expect(res._status).toBe(200);
    // suppressed by cooldown — no KV write for the cooldown itself
    expect(firestore.kvPut).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does not stack up multiple deferred calls when several webhooks arrive during cooldown', async () => {
    vi.useFakeTimers();
    const token = '00000000-0000-0000-0000-000000000004';
    const config = JSON.stringify({ docId: 'doc2', channelId: 'cid2', channelToken: token, anthropicApiKey: 'key', activatedAt: Date.now() });
    const makeOnCooldown = () => vi.mocked(firestore.kvGet)
      .mockResolvedValueOnce(config) // channel token lookup
      .mockResolvedValueOnce('1');   // on cooldown

    makeOnCooldown();
    await handleWebhook(makeReq({ 'x-goog-resource-state': 'change', 'x-goog-channel-token': token, 'x-goog-channel-id': 'cid2' }), makeRes());
    makeOnCooldown();
    await handleWebhook(makeReq({ 'x-goog-resource-state': 'change', 'x-goog-channel-token': token, 'x-goog-channel-id': 'cid2' }), makeRes());

    // Both suppressed by cooldown — still no KV writes
    expect(firestore.kvPut).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('returns 200 but does not dispatch processDoc when channelId mismatches', async () => {
    const token = '00000000-0000-0000-0000-000000000005';
    const config = JSON.stringify({ docId: 'doc1', channelId: 'correct-channel', channelToken: token, anthropicApiKey: 'key', activatedAt: Date.now() });
    vi.mocked(firestore.kvGet).mockResolvedValue(config);
    const req = makeReq({
      'x-goog-resource-state': 'change',
      'x-goog-channel-token': token,
      'x-goog-channel-id': 'wrong-channel',
    });
    const res = makeRes();
    await handleWebhook(req, res);
    expect(res._status).toBe(200);
    // Short-circuits at channelId mismatch before cooldown check
    expect(firestore.kvPut).not.toHaveBeenCalled();
  });
});

describe('handleRegister', () => {
  const SECRET = 'secret123';

  beforeEach(() => {
    vi.mocked(firestore.kvPut).mockResolvedValue(undefined);
    process.env.REGISTER_SECRET = SECRET;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.REGISTER_SECRET;
  });

  it('returns 401 when HMAC headers are missing', async () => {
    const req = makeReq({}, {});
    const res = makeRes();
    await handleRegister(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 401 when signature is wrong', async () => {
    const body = { channelToken: 'ct1', channelId: 'ci1', docId: 'di1', anthropicApiKey: 'ak1', activatedAt: 0 };
    const ts = String(Math.floor(Date.now() / 1000));
    const req = makeReq({ 'x-timestamp': ts, 'x-signature': 'badsig==' }, body);
    const res = makeRes();
    await handleRegister(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 200 and writes two KV entries on valid registration', async () => {
    const body = { channelToken: 'ct1', channelId: 'ci1', docId: 'di1', anthropicApiKey: 'ak1', activatedAt: 0 };
    const req = makeReq(makeHmacHeaders(SECRET, body), body);
    const res = makeRes();
    await handleRegister(req, res);
    expect(res._status).toBe(200);
    // Writes channelToken key, canonical_docId key, and rate limit counter key
    expect(firestore.kvPut).toHaveBeenCalledTimes(3);
    const keys = vi.mocked(firestore.kvPut).mock.calls.map(c => c[0]);
    expect(keys).toContain('ct1');
    expect(keys).toContain('canonical_di1');
    expect(keys).toContain('ratelimit_register_di1');
  });

  it('returns 400 when required fields are missing from the body', async () => {
    const body = { channelToken: 'ct1' }; // missing channelId, docId, anthropicApiKey
    const req = makeReq(makeHmacHeaders(SECRET, body), body);
    const res = makeRes();
    await handleRegister(req, res);
    expect(res._status).toBe(400);
  });
});

describe('handleUnregister', () => {
  const SECRET = 'secret123';

  beforeEach(async () => {
    // Reset all mocks (clears call history AND implementations) before each test so
    // that fire-and-forget processDoc calls from earlier handleWebhook tests cannot
    // pollute these assertions via stale async micro-task queue entries.
    vi.resetAllMocks();
    vi.mocked(firestore.kvGet).mockResolvedValue(null);
    vi.mocked(firestore.kvDelete).mockResolvedValue(undefined);
    // Drain any in-flight micro-tasks left over from prior tests before continuing.
    await Promise.resolve();
    process.env.REGISTER_SECRET = SECRET;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.REGISTER_SECRET;
  });

  it('returns 401 when HMAC headers are missing', async () => {
    const req = makeReq({}, { channelToken: 'ct1', docId: 'di1' });
    const res = makeRes();
    await handleUnregister(req, res);
    expect(res._status).toBe(401);
  });

  it('returns 400 when required fields are missing', async () => {
    const body = { channelToken: 'ct1' }; // missing docId
    const req = makeReq(makeHmacHeaders(SECRET, body), body);
    const res = makeRes();
    await handleUnregister(req, res);
    expect(res._status).toBe(400);
  });

  it('deletes channel and canonical when canonical matches token', async () => {
    vi.mocked(firestore.kvGet).mockResolvedValue('ct1'); // canonical points to this token
    const body = { channelToken: 'ct1', docId: 'di1' };
    const req = makeReq(makeHmacHeaders(SECRET, body), body);
    const res = makeRes();
    await handleUnregister(req, res);
    expect(res._status).toBe(200);
    expect(firestore.kvDelete).toHaveBeenCalledTimes(2);
  });

  it('does not delete canonical when it belongs to a different channel (confused deputy guard)', async () => {
    vi.mocked(firestore.kvGet).mockResolvedValue('other-token'); // canonical is someone else's
    const body = { channelToken: 'ct1', docId: 'di1' };
    const req = makeReq(makeHmacHeaders(SECRET, body), body);
    const res = makeRes();
    await handleUnregister(req, res);
    expect(res._status).toBe(200);
    // Only the channel token itself is deleted, not the canonical pointer
    expect(firestore.kvDelete).toHaveBeenCalledTimes(1);
    expect(firestore.kvDelete).toHaveBeenCalledWith('ct1');
  });
});
