import { describe, it, expect } from 'vitest';
import { buildProxyNote, proxyNotePath } from '../../src/lib/ingest/proxy';
import { serializeNote } from '../../src/lib/vault/note';

// FR-ING-012 · OBSIDIAN-DNA §5.1, DATA-MODEL §1. Markdown Proxy Note for imported documents.

describe('proxyNotePath', () => {
  it('maps a source binary to its notes/ proxy', () => {
    expect(proxyNotePath('sources/report.pdf')).toBe('notes/report.md');
    expect(proxyNotePath('sources/Q3 data.csv')).toBe('notes/Q3 data.md');
    expect(proxyNotePath('noext')).toBe('notes/noext.md');
  });
});

describe('buildProxyNote', () => {
  it('creates a proxy with a source backlink + AI frontmatter, body preserved', () => {
    const note = buildProxyNote({
      sourcePath: 'sources/report.pdf',
      body: 'Extracted PDF text.',
      meta: { title: 'Q3 Report', type: 'report', tags: ['finance'], summary: 'Revenue up.' },
      now: '2026-06-05'
    });
    expect(note.frontmatter.source).toBe('sources/report.pdf'); // backlink to the untouched original
    expect(note.frontmatter.title).toBe('Q3 Report');
    expect(note.frontmatter.type).toBe('report');
    expect(note.frontmatter.tags).toEqual(['finance']);
    expect(note.frontmatter.date_ingested).toBe('2026-06-05');
    expect(note.body).toBe('Extracted PDF text.');
    // round-trips to a valid .md the way Obsidian reads it
    expect(serializeNote(note)).toContain('source: sources/report.pdf');
  });

  it('native note (no sourcePath) carries no source key', () => {
    const note = buildProxyNote({ body: 'A hand-written note.', now: '2026-06-05' });
    expect(note.frontmatter.source).toBeUndefined();
    expect(note.frontmatter.date_ingested).toBe('2026-06-05');
  });

  it('no model → flags taggable_later, no AI keys, still keeps the source backlink', () => {
    const note = buildProxyNote({
      sourcePath: 'sources/data.csv',
      body: '| a | b |',
      now: '2026-06-05',
      taggableLater: true
    });
    expect(note.frontmatter.source).toBe('sources/data.csv');
    expect(note.frontmatter.taggable_later).toBe(true);
    expect(note.frontmatter.title).toBeUndefined();
  });

  it('never clobbers pre-existing user frontmatter (FR-ING-006 override)', () => {
    const note = buildProxyNote({
      sourcePath: 'sources/report.pdf',
      body: 'x',
      meta: { title: 'AI Title', type: 'report', tags: [] },
      now: '2026-06-05',
      frontmatter: { title: 'My Title' }
    });
    expect(note.frontmatter.title).toBe('My Title'); // user wins
    expect(note.frontmatter.type).toBe('report'); // filled
  });
});
