import { describe, it, expect } from 'vitest';
import { renderMarkdown, escapeHtml } from '../../src/lib/render/markdown';

// FR-UI-002 (preview) · OBSIDIAN-DNA §5.10 · ADR-016. Safe-subset Markdown renderer.

const resolveLink = (target: string) =>
  target.toLowerCase() === 'apollo' ? { docId: 'notes/apollo.md', title: 'Apollo' } : null;

describe('escapeHtml', () => {
  it('escapes the five significant chars', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;'
    );
  });
});

describe('renderMarkdown — security (escape-first)', () => {
  it('escapes raw HTML in note text (no XSS)', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes an img/onerror payload as text', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).toContain('&lt;img');
  });

  it('blocks javascript: links, keeping the text', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('click');
    expect(html).not.toContain('<a href');
  });

  it('allows http(s) links with rel=noopener', () => {
    const html = renderMarkdown('[site](https://example.com)');
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a>'
    );
  });
});

describe('renderMarkdown — blocks', () => {
  it('renders headings, emphasis, and code spans', () => {
    expect(renderMarkdown('# Title')).toBe('<h1>Title</h1>');
    expect(renderMarkdown('a **bold** and *italic* and ~~gone~~')).toBe(
      '<p>a <strong>bold</strong> and <em>italic</em> and <del>gone</del></p>'
    );
    expect(renderMarkdown('use `code` here')).toBe('<p>use <code>code</code> here</p>');
  });

  it('does not format inside inline code or fenced code', () => {
    expect(renderMarkdown('`**not bold**`')).toBe('<p><code>**not bold**</code></p>');
    expect(renderMarkdown('```\n<b>&\n```')).toBe('<pre><code>&lt;b&gt;&amp;</code></pre>');
  });

  it('renders unordered, ordered, nested, and task lists', () => {
    expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderMarkdown('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
    expect(renderMarkdown('- a\n  - a1')).toBe('<ul><li>a<ul><li>a1</li></ul></li></ul>');
    const tasks = renderMarkdown('- [ ] todo\n- [x] done');
    expect(tasks).toContain('<input type="checkbox" disabled> todo');
    expect(tasks).toContain('<input type="checkbox" disabled checked> done');
  });

  it('renders blockquotes and horizontal rules', () => {
    expect(renderMarkdown('> quoted')).toBe('<blockquote><p>quoted</p></blockquote>');
    expect(renderMarkdown('---')).toBe('<hr>');
  });

  it('renders a GFM table', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>1</td>');
  });
});

describe('renderMarkdown — wikilinks', () => {
  it('renders resolved links as clickable, broken ones dimmed, aliases as display', () => {
    const html = renderMarkdown('See [[Apollo]] and [[Apollo|the project]] and [[Ghost]].', {
      resolveLink
    });
    expect(html).toContain('<a class="wikilink" data-doc="notes/apollo.md"');
    expect(html).toContain('>the project</a>'); // alias display
    expect(html).toContain('<span class="broken-link">Ghost</span>');
  });

  it('does not treat a [[link]] inside code as a wikilink', () => {
    const html = renderMarkdown('`[[Apollo]]`', { resolveLink });
    expect(html).toContain('<code>[[Apollo]]</code>');
    expect(html).not.toContain('class="wikilink"');
  });
});
