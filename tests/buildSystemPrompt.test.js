import { buildSystemPrompt } from '../cloud-run/index.js';

describe('buildSystemPrompt', () => {
  it('includes the document context', () => {
    const prompt = buildSystemPrompt('This is the doc summary.', 'some anchor');
    expect(prompt).toContain('This is the doc summary.');
  });

  it('includes the anchor text', () => {
    const prompt = buildSystemPrompt('doc', 'highlighted passage here');
    expect(prompt).toContain('highlighted passage here');
  });

  it('includes the persona preamble', () => {
    const prompt = buildSystemPrompt('doc', 'anchor');
    expect(prompt).toContain('You are an assistant embedded in a Google Doc');
  });

  it('wraps docContext and anchorText in XML tags', () => {
    const prompt = buildSystemPrompt('my context', 'my anchor');
    expect(prompt).toContain('<document_context>');
    expect(prompt).toContain('my context');
    expect(prompt).toContain('</document_context>');
    expect(prompt).toContain('<highlighted_text>');
    expect(prompt).toContain('my anchor');
    expect(prompt).toContain('</highlighted_text>');
  });

  it('includes web search instruction when ENABLE_WEB_SEARCH is true', () => {
    // ENABLE_WEB_SEARCH is hardcoded true in cloud-run/index.js
    const prompt = buildSystemPrompt('doc', 'anchor');
    expect(prompt).toContain('If you search the web');
  });
});
