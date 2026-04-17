import { summarizeWithHaiku } from '../cloud-run/index.js';

describe('summarizeWithHaiku', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the text block content on success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'Summary text here.' }] }),
    });
    const result = await summarizeWithHaiku('long document text', 'sk-ant-test', 100);
    expect(result).toBe('Summary text here.');
  });

  it('joins multiple text blocks with double newline', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          { type: 'text', text: 'Part one.' },
          { type: 'text', text: 'Part two.' },
        ],
      }),
    });
    const result = await summarizeWithHaiku('text', 'key', 100);
    expect(result).toBe('Part one.\n\nPart two.');
  });

  it('falls back to text.slice(0, 5000) when fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('network error'));
    const text = 'x'.repeat(6000);
    const result = await summarizeWithHaiku(text, 'key', 100);
    expect(result).toBe('x'.repeat(5000));
  });

  it('falls back to text.slice(0, 5000) when response is not ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const text = 'y'.repeat(6000);
    const result = await summarizeWithHaiku(text, 'key', 100);
    expect(result).toBe('y'.repeat(5000));
  });

  it('falls back to text.slice(0, 5000) when content array is empty', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ content: [] }),
    });
    const text = 'z'.repeat(6000);
    const result = await summarizeWithHaiku(text, 'key', 100);
    expect(result).toBe('z'.repeat(5000));
  });

  it('sends max_tokens = Math.ceil((targetWords / 0.75) * 1.1) in the request body', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    const targetWords = 1000;
    await summarizeWithHaiku('text', 'key', targetWords);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(Math.ceil((targetWords / 0.75) * 1.1)); // 1467
  });

  it('sends the correct model in the request body', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    await summarizeWithHaiku('text', 'key', 100);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('claude-haiku-4-5-20251001');
  });
});
