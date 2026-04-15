import { buildThreadHistory } from '../worker/index.js';

const CLAUDE_EMAIL = 'claude-assistant@claude-doc-assistant.iam.gserviceaccount.com';

function makeReply({ id = 'r1', content, email = 'user@example.com' } = {}) {
  return { id, content, author: { emailAddress: email } };
}

describe('buildThreadHistory', () => {
  it('turns top-level comment into a user message', () => {
    const comment = { content: '@claude hello', replies: [] };
    const messages = buildThreadHistory(comment, CLAUDE_EMAIL);
    expect(messages[0]).toEqual({ role: 'user', content: 'hello' });
  });

  it('assigns role=assistant to replies authored by Claude', () => {
    const comment = {
      content: '@claude question',
      replies: [makeReply({ content: 'my answer', email: CLAUDE_EMAIL })],
    };
    const messages = buildThreadHistory(comment, CLAUDE_EMAIL);
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('my answer');
  });

  it('assigns role=user to replies from non-Claude authors', () => {
    const comment = {
      content: '@claude question',
      replies: [makeReply({ content: 'follow up', email: 'user@example.com' })],
    };
    const messages = buildThreadHistory(comment, CLAUDE_EMAIL);
    expect(messages[1].role).toBe('user');
  });

  it('strips @claude from all messages', () => {
    const comment = {
      content: '@claude initial',
      replies: [makeReply({ content: '@claude follow', email: 'user@example.com' })],
    };
    const messages = buildThreadHistory(comment, CLAUDE_EMAIL);
    expect(messages[0].content).not.toContain('@claude');
    expect(messages[1].content).not.toContain('@claude');
  });

  it('matches Claude email case-insensitively', () => {
    const comment = {
      content: 'question',
      replies: [makeReply({ content: 'reply', email: CLAUDE_EMAIL.toUpperCase() })],
    };
    const messages = buildThreadHistory(comment, CLAUDE_EMAIL);
    expect(messages[1].role).toBe('assistant');
  });

  it('returns only one user message when there are no replies', () => {
    const comment = { content: '@claude alone', replies: [] };
    const messages = buildThreadHistory(comment, CLAUDE_EMAIL);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });

  it('produces correct role sequence for a multi-turn conversation', () => {
    const comment = {
      content: '@claude first',
      replies: [
        makeReply({ id: 'r1', content: 'response one', email: CLAUDE_EMAIL }),
        makeReply({ id: 'r2', content: '@claude second', email: 'user@example.com' }),
        makeReply({ id: 'r3', content: 'response two', email: CLAUDE_EMAIL }),
      ],
    };
    const messages = buildThreadHistory(comment, CLAUDE_EMAIL);
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});
