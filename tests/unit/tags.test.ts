import { describe, it, expect } from 'vitest';
import { coerceTags, buildTagIndex, notesForTag, extractInlineTags } from '../../src/lib/nav/tags';

// FR-NAV-003 · OBSIDIAN-DNA §5.9. Tag index over frontmatter.

describe('coerceTags', () => {
  it('handles arrays, strings, and #-prefixes; lowercases', () => {
    expect(coerceTags(['Finance', '#Q3'])).toEqual(['finance', 'q3']);
    expect(coerceTags('alpha, #Beta gamma')).toEqual(['alpha', 'beta', 'gamma']);
    expect(coerceTags(undefined)).toEqual([]);
    expect(coerceTags(42)).toEqual([]);
  });
});

describe('extractInlineTags', () => {
  it('pulls #hashtags from body text, normalized, ignoring non-tags', () => {
    expect(
      extractInlineTags('Plan for #Q3 and #finance/eu. Email a@b.com costs $5#notatag')
    ).toEqual(['q3', 'finance/eu']);
    expect(extractInlineTags('starts #here (#paren) too')).toEqual(['here', 'paren']);
    expect(extractInlineTags('no tags here')).toEqual([]);
  });
});

describe('buildTagIndex', () => {
  const notes = [
    { docId: 'notes/a.md', tags: ['finance', 'q3'] },
    { docId: 'notes/b.md', tags: ['finance', '#Q3'] }, // dup tag across notes
    { docId: 'notes/c.md', tags: 'idea' },
    { docId: 'notes/d.md' } // untagged
  ];

  it('counts distinct tags across the vault, sorted by count then name', () => {
    const idx = buildTagIndex(notes);
    expect(idx[0]).toMatchObject({ tag: 'finance', count: 2 });
    expect(idx.find((e) => e.tag === 'q3')).toMatchObject({ count: 2 });
    expect(idx.find((e) => e.tag === 'idea')).toMatchObject({ count: 1 });
    // sorted: finance(2)/q3(2) before idea(1); finance before q3 alphabetically
    expect(idx.map((e) => e.tag)).toEqual(['finance', 'q3', 'idea']);
  });

  it('dedupes a repeated tag within one note', () => {
    const idx = buildTagIndex([{ docId: 'notes/x.md', tags: ['a', 'A', '#a'] }]);
    expect(idx).toEqual([{ tag: 'a', count: 1, docIds: ['notes/x.md'] }]);
  });
});

describe('notesForTag', () => {
  it('returns docIds carrying the (normalized) tag', () => {
    const notes = [
      { docId: 'notes/a.md', tags: ['finance'] },
      { docId: 'notes/b.md', tags: ['#Finance'] },
      { docId: 'notes/c.md', tags: ['idea'] }
    ];
    expect(notesForTag(notes, '#FINANCE').sort()).toEqual(['notes/a.md', 'notes/b.md']);
    expect(notesForTag(notes, 'missing')).toEqual([]);
  });
});
