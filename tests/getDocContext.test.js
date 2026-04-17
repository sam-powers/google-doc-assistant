import { getDocContext } from '../cloud-run/index.js';
import * as firestore from '../cloud-run/firestore.js';

vi.mock('../cloud-run/firestore.js', () => ({
  kvGet: vi.fn(),
  kvPut: vi.fn(),
  kvDelete: vi.fn(),
}));

describe('getDocContext', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(firestore.kvGet).mockResolvedValue(null);
    vi.mocked(firestore.kvPut).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('returns cached value without calling fetch when cache hits', async () => {
    vi.mocked(firestore.kvGet).mockResolvedValue('cached summary');
    const result = await getDocContext('doc1', 'token', 'apikey');
    expect(result).toBe('cached summary');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns full text unchanged when word count is <= 1000', async () => {
    const shortText = 'word '.repeat(500).trim(); // 500 words
    fetchMock.mockResolvedValue({ ok: true, text: async () => shortText });

    const result = await getDocContext('doc1', 'token', 'apikey');
    expect(result).toBe(shortText);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only Drive export, no Haiku
  });

  it('passes exactly 1000 words through verbatim (boundary)', async () => {
    const text1000 = 'word '.repeat(1000).trim(); // exactly 1000 words
    fetchMock.mockResolvedValue({ ok: true, text: async () => text1000 });

    const result = await getDocContext('doc1', 'token', 'apikey');
    expect(result).toBe(text1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('calls summarizeWithHaiku when word count is > 1000', async () => {
    const longText = 'word '.repeat(1001).trim(); // 1001 words
    fetchMock
      .mockResolvedValueOnce({ ok: true, text: async () => longText })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: 'Haiku summary.' }] }),
      });

    const result = await getDocContext('doc1', 'token', 'apikey');
    expect(result).toBe('Haiku summary.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('computes targetWords as Math.max(Math.round(wordCount * 0.1), 1000)', async () => {
    // 5000 words: 5000 * 0.1 = 500, clamped to 1000
    const text5000 = 'word '.repeat(5000).trim();
    fetchMock
      .mockResolvedValueOnce({ ok: true, text: async () => text5000 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: 'summary' }] }),
      });

    await getDocContext('doc1', 'token', 'apikey');
    const haikuBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    const expectedTargetWords = Math.max(Math.round(5000 * 0.1), 1000); // 1000
    const expectedMaxTokens = Math.ceil((expectedTargetWords / 0.75) * 1.1);
    expect(haikuBody.max_tokens).toBe(expectedMaxTokens);
  });

  it('stores result in Firestore with TTL 3600', async () => {
    const text = 'short '.repeat(10).trim();
    fetchMock.mockResolvedValue({ ok: true, text: async () => text });

    await getDocContext('doc1', 'token', 'apikey');
    expect(firestore.kvPut).toHaveBeenCalledWith('doc_context_doc1', text, 3600);
  });

  it('throws when Drive export returns a non-ok status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'Forbidden' });

    await expect(getDocContext('doc1', 'token', 'apikey')).rejects.toThrow('403');
  });
});
