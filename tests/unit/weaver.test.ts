import { describe, it, expect } from 'vitest';
import { buildTitleIndex, weaveLinks, notePreview, type NoteRef } from '../../src/lib/weave/weaver';

// FR-LINK-001/002 · OBSIDIAN-DNA §5.2. Pure, deterministic auto-wikilink weaving.

const notes: NoteRef[] = [
  { docId: 'notes/apollo.md', title: 'Apollo', summary: 'The Apollo launch plan.' },
  { docId: 'notes/ml.md', title: 'Machine Learning', aliases: ['ML'] },
  { docId: 'notes/machines.md', title: 'Machines' }
];

const index = buildTitleIndex(notes);

/** Convenience: only the linked surface texts, in order. */
const links = (text: string, opts = {}) =>
  weaveLinks(text, index, opts)
    .filter((s) => s.link)
    .map((s) => ({ text: s.text, docId: s.link!.docId }));

describe('weaveLinks', () => {
  it('wraps note titles and is lossless (segments rejoin to the input)', () => {
    const text = 'The Apollo plan uses Machine Learning heavily.';
    const segs = weaveLinks(text, index);
    expect(segs.map((s) => s.text).join('')).toBe(text); // nothing lost/duplicated
    expect(links(text)).toEqual([
      { text: 'Apollo', docId: 'notes/apollo.md' },
      { text: 'Machine Learning', docId: 'notes/ml.md' }
    ]);
  });

  it('prefers the longest match (Machine Learning, not Machines)', () => {
    expect(links('We study Machine Learning today.')[0]).toEqual({
      text: 'Machine Learning',
      docId: 'notes/ml.md'
    });
  });

  it('respects word boundaries (does not match inside another word)', () => {
    // "Apollos" must NOT match "Apollo"; "submachine" must NOT match "Machine"/"Machines"
    expect(links('Apollos and submachine guns.')).toEqual([]);
  });

  it('is case-insensitive and links aliases', () => {
    expect(links('apollo and ML rule.')).toEqual([
      { text: 'apollo', docId: 'notes/apollo.md' },
      { text: 'ML', docId: 'notes/ml.md' }
    ]);
  });

  it('never links inside code spans, fenced blocks, or existing links', () => {
    expect(links('Use `Apollo` in code.')).toEqual([]);
    expect(links('```\nApollo here\n```')).toEqual([]);
    expect(links('See [[Apollo]] already.')).toEqual([]);
    expect(links('See [Apollo](notes/apollo.md) already.')).toEqual([]);
  });

  it('once: links only the first occurrence per target', () => {
    const text = 'Apollo then Apollo again.';
    expect(links(text).length).toBe(2); // default: link all
    expect(links(text, { once: true }).length).toBe(1);
  });
});

describe('notePreview', () => {
  it('prefers the summary, else truncates the body with an ellipsis', () => {
    expect(notePreview({ summary: 'Short summary.' })).toBe('Short summary.');
    const long = 'x'.repeat(500);
    const p = notePreview({ body: long }, 200);
    expect(p.length).toBe(201); // 200 chars + ellipsis
    expect(p.endsWith('…')).toBe(true);
  });

  it('collapses whitespace', () => {
    expect(notePreview({ body: '  a\n\n  b  ' })).toBe('a b');
  });
});
