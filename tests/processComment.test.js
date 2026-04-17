import { processComment } from '../cloud-run/index.js';

function makeComment({ id = 'c1', content, replies = [], quotedValue = '' } = {}) {
  return {
    id,
    content,
    quotedFileContent: { value: quotedValue },
    replies,
  };
}

function makeReply({ id, content, email = 'user@example.com' } = {}) {
  return { id, content, author: { emailAddress: email } };
}

const CLAUDE_EMAIL = 'claude-assistant@claude-doc-assistant.iam.gserviceaccount.com';

describe('processComment', () => {
  describe('top-level @claude mention', () => {
    it('returns one pending item with replyId=null when no replies exist', () => {
      const comment = makeComment({ content: '@claude summarize this' });
      const result = processComment(comment, new Set());
      expect(result).toHaveLength(1);
      expect(result[0].replyId).toBeNull();
      expect(result[0].commentId).toBe('c1');
      expect(result[0].prompt).toBe('summarize this');
    });

    it('returns early and skips reply scan when top-level @claude is unanswered', () => {
      // reply also has @claude, but early return means only one result
      const comment = makeComment({
        content: '@claude top level',
        replies: [makeReply({ id: 'r1', content: '@claude follow-up' })],
      });
      const result = processComment(comment, new Set());
      expect(result).toHaveLength(1);
      expect(result[0].replyId).toBeNull();
    });

    it('returns [] when top-level @claude is answered via processedIds', () => {
      const comment = makeComment({
        content: '@claude question',
        replies: [makeReply({ id: 'r1', content: 'some reply' })],
      });
      const result = processComment(comment, new Set(['r1']));
      expect(result).toHaveLength(0);
    });

    it('returns [] when an intermediate reply (not the last) is in processedIds', () => {
      const comment = makeComment({
        content: '@claude question',
        replies: [
          makeReply({ id: 'r1', content: 'answer' }),
          makeReply({ id: 'r2', content: 'extra comment' }),
        ],
      });
      // r1 is processed — any subsequent item being processed counts as answered
      const result = processComment(comment, new Set(['r1']));
      expect(result).toHaveLength(0);
    });

    it('preserves full anchorText without truncation', () => {
      const longAnchor = 'a'.repeat(200);
      const comment = makeComment({ content: '@claude go', quotedValue: longAnchor });
      const result = processComment(comment, new Set());
      expect(result[0].anchorText).toBe(longAnchor);
    });
  });

  describe('reply-level @claude mention', () => {
    it('returns one pending item with correct replyId', () => {
      const comment = makeComment({
        content: 'no mention at top level',
        replies: [makeReply({ id: 'r1', content: '@claude help me' })],
      });
      const result = processComment(comment, new Set());
      expect(result).toHaveLength(1);
      expect(result[0].replyId).toBe('r1');
      expect(result[0].commentId).toBe('c1');
      expect(result[0].prompt).toBe('help me');
    });

    it('returns [] when reply-level @claude is answered via processedIds', () => {
      const comment = makeComment({
        content: 'no mention',
        replies: [
          makeReply({ id: 'r1', content: '@claude help' }),
          makeReply({ id: 'r2', content: 'already processed' }),
        ],
      });
      const result = processComment(comment, new Set(['r2']));
      expect(result).toHaveLength(0);
    });

    it('falls through to reply scan when top-level @claude is already answered', () => {
      const comment = makeComment({
        content: '@claude initial',
        replies: [
          makeReply({ id: 'r1', content: 'answered', email: CLAUDE_EMAIL }),
          makeReply({ id: 'r2', content: '@claude follow up' }),
        ],
      });
      // r1 is processed (marks top-level as answered), so we fall through to r2
      const result = processComment(comment, new Set(['r1']));
      expect(result).toHaveLength(1);
      expect(result[0].replyId).toBe('r2');
    });

    it('returns [] when no @claude mention anywhere', () => {
      const comment = makeComment({
        content: 'just a regular comment',
        replies: [makeReply({ id: 'r1', content: 'just a reply' })],
      });
      const result = processComment(comment, new Set());
      expect(result).toHaveLength(0);
    });
  });

  describe('@claude case insensitivity', () => {
    it('detects @Claude (capital C)', () => {
      const comment = makeComment({ content: '@Claude summarize' });
      const result = processComment(comment, new Set());
      expect(result).toHaveLength(1);
    });

    it('detects @CLAUDE (all caps)', () => {
      const comment = makeComment({ content: '@CLAUDE summarize' });
      const result = processComment(comment, new Set());
      expect(result).toHaveLength(1);
    });
  });
});
