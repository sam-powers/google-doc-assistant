import { normalizeMessages } from '../worker/index.js';

describe('normalizeMessages', () => {
  it('returns [] for an empty array', () => {
    expect(normalizeMessages([])).toEqual([]);
  });

  it('returns a single message unchanged', () => {
    const input = [{ role: 'user', content: 'hello' }];
    const result = normalizeMessages(input);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('hello');
  });

  it('merges two consecutive user messages with double newline', () => {
    const result = normalizeMessages([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe('first\n\nsecond');
  });

  it('merges two consecutive assistant messages', () => {
    const result = normalizeMessages([
      { role: 'assistant', content: 'part1' },
      { role: 'assistant', content: 'part2' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('part1\n\npart2');
  });

  it('does not merge alternating roles', () => {
    const result = normalizeMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q2' },
    ]);
    expect(result).toHaveLength(3);
  });

  it('merges a run of three same-role messages into one', () => {
    const result = normalizeMessages([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('a\n\nb\n\nc');
  });
});
