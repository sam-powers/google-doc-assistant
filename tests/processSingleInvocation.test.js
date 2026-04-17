import { processSingleInvocation } from '../cloud-run/index.js';
import * as firestore from '../cloud-run/firestore.js';

vi.mock('../cloud-run/firestore.js', () => ({
  kvGet: vi.fn(),
  kvPut: vi.fn(),
  kvDelete: vi.fn(),
}));

const DOC_ID = 'doc-abc';
const API_KEY = 'sk-ant-test';
const ACCESS_TOKEN = 'at-test';

// A simple comment with one @claude mention and no replies
function makeItem({ commentId = 'c1', anchorText = 'anchor text' } = {}) {
  return {
    comment: {
      content: '@claude explain this',
      replies: [],
      quotedFileContent: { value: anchorText },
    },
    commentId,
    anchorText,
  };
}

// Mock sequence for happy path (short doc, cache miss):
// call 0: POST placeholder
// call 1: GET Drive export (getDocContext)
// call 2: POST Anthropic
// call 3: POST real reply
function mockHappyPath(fetchMock, { replyId = 'real-reply-id', anthropicText = 'Claude says hi' } = {}) {
  fetchMock
    .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'placeholder-id' }) }) // placeholder
    .mockResolvedValueOnce({ ok: true, text: async () => 'short doc text' })            // Drive export
    .mockResolvedValueOnce({                                                             // Anthropic
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: anthropicText }] }),
    })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ id: replyId }) });          // real reply
}

describe('processSingleInvocation', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // cache miss by default
    vi.mocked(firestore.kvGet).mockResolvedValue(null);
    vi.mocked(firestore.kvPut).mockResolvedValue(undefined);
    vi.mocked(firestore.kvDelete).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('posts a placeholder reply before calling Anthropic', async () => {
    mockHappyPath(fetchMock);
    await processSingleInvocation(makeItem(), DOC_ID, API_KEY, ACCESS_TOKEN);

    // First fetch call should be the placeholder POST
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain(`/comments/c1/replies`);
    const body = JSON.parse(opts.body);
    expect(body.content).toContain('Claude is responding');
  });

  it('posts the Anthropic reply text as a second Drive reply', async () => {
    mockHappyPath(fetchMock, { anthropicText: 'Here is my answer' });
    await processSingleInvocation(makeItem(), DOC_ID, API_KEY, ACCESS_TOKEN);

    // Last fetch call is the real reply POST
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    const body = JSON.parse(lastCall[1].body);
    expect(body.content).toBe('Here is my answer');
  });

  it('calls markProcessed with the real reply ID (not the placeholder ID)', async () => {
    mockHappyPath(fetchMock, { replyId: 'real-reply-xyz' });
    await processSingleInvocation(makeItem(), DOC_ID, API_KEY, ACCESS_TOKEN);

    const putCalls = vi.mocked(firestore.kvPut).mock.calls;
    const processedCall = putCalls.find(c => c[0].startsWith('processed_'));
    expect(processedCall).toBeDefined();
    const stored = JSON.parse(processedCall[1]);
    expect(stored).toContain('real-reply-xyz');
    expect(stored).not.toContain('placeholder-id');
  });

  it('returns early without any fetch calls when last message role is assistant', async () => {
    // A comment thread whose last reply is from Claude (author.me === true) → last message is assistant
    const item = {
      comment: {
        content: '@claude question',
        replies: [{ id: 'r1', content: 'answer', author: { me: true } }],
      },
      commentId: 'c1',
      anchorText: '',
    };
    await processSingleInvocation(item, DOC_ID, API_KEY, ACCESS_TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts an error reply (does not throw) when Anthropic call fails', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'placeholder-id' }) }) // placeholder
      .mockResolvedValueOnce({ ok: true, text: async () => 'short doc' })                 // Drive export
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' }) // Anthropic fails
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'error-reply-id' }) });  // error reply

    await expect(
      processSingleInvocation(makeItem(), DOC_ID, API_KEY, ACCESS_TOKEN)
    ).resolves.toBeUndefined(); // does not throw

    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    const body = JSON.parse(lastCall[1].body);
    expect(body.content).toContain('Claude encountered an error');
  });

  it('throws when the placeholder POST fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 403, text: async () => 'Forbidden',
    });

    await expect(
      processSingleInvocation(makeItem(), DOC_ID, API_KEY, ACCESS_TOKEN)
    ).rejects.toThrow('403');

    // No further fetch calls after placeholder failure
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
