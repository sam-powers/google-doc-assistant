import { buildThreadHistory } from '../cloud-run/index.js';

// Cloud Run uses author.me (boolean) for role detection — Drive API does not
// return emailAddress when fetched by a service account. author.me === true
// means the service account (Claude) wrote it.

function makeReply({ id = 'r1', content, isMe = false } = {}) {
  return { id, content, author: { me: isMe } };
}

describe('buildThreadHistory', () => {
  it('turns top-level comment into a user message', () => {
    const comment = { content: '@claude hello', replies: [] };
    const messages = buildThreadHistory(comment);
    expect(messages[0]).toEqual({ role: 'user', content: 'hello' });
  });

  it('assigns role=assistant to replies where author.me === true', () => {
    const comment = {
      content: '@claude question',
      replies: [makeReply({ content: 'my answer', isMe: true })],
    };
    const messages = buildThreadHistory(comment);
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('my answer');
  });

  it('assigns role=user to replies where author.me is falsy', () => {
    const comment = {
      content: '@claude question',
      replies: [makeReply({ content: 'follow up', isMe: false })],
    };
    const messages = buildThreadHistory(comment);
    expect(messages[1].role).toBe('user');
  });

  it('strips @claude from all messages', () => {
    const comment = {
      content: '@claude initial',
      replies: [makeReply({ content: '@claude follow', isMe: false })],
    };
    const messages = buildThreadHistory(comment);
    expect(messages[0].content).not.toContain('@claude');
    expect(messages[1].content).not.toContain('@claude');
  });

  it('returns only one user message when there are no replies', () => {
    const comment = { content: '@claude alone', replies: [] };
    const messages = buildThreadHistory(comment);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });

  it('produces correct role sequence for a multi-turn conversation', () => {
    const comment = {
      content: '@claude first',
      replies: [
        makeReply({ id: 'r1', content: 'response one', isMe: true }),
        makeReply({ id: 'r2', content: '@claude second', isMe: false }),
        makeReply({ id: 'r3', content: 'response two', isMe: true }),
      ],
    };
    const messages = buildThreadHistory(comment);
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});
