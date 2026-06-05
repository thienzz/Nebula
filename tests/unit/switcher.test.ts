import { describe, it, expect } from 'vitest';
import { fuzzyScore, quickSwitch, type SwitchItem } from '../../src/lib/nav/switcher';

// FR-NAV-001 · OBSIDIAN-DNA §5.7. Quick switcher fuzzy ranking.

describe('fuzzyScore', () => {
  it('returns null when not all query chars appear in order', () => {
    expect(fuzzyScore('xyz', 'Apollo')).toBeNull();
    expect(fuzzyScore('opa', 'Apollo')).toBeNull(); // wrong order
  });

  it('matches subsequences and scores word-boundary + consecutive higher', () => {
    expect(fuzzyScore('apo', 'Apollo')).not.toBeNull();
    // consecutive prefix "road" should beat scattered match of same letters
    expect(fuzzyScore('road', 'Roadmap')!).toBeGreaterThan(fuzzyScore('road', 'Railroad Aboard')!);
  });

  it('empty query scores 0 (matches anything)', () => {
    expect(fuzzyScore('', 'whatever')).toBe(0);
  });
});

describe('quickSwitch', () => {
  const items: SwitchItem[] = [
    { docId: 'notes/apollo.md', title: 'Apollo' },
    { docId: 'notes/roadmap.md', title: 'Roadmap' },
    { docId: 'notes/refund-policy.md', title: 'Refund Policy' },
    { docId: 'notes/security.md', title: 'Security' }
  ];

  it('ranks the closest title first', () => {
    const r = quickSwitch(items, 'apo');
    expect(r[0].docId).toBe('notes/apollo.md');
  });

  it('falls back to matching the docId path when the title misses', () => {
    const r = quickSwitch(items, 'refund-pol');
    expect(r[0].docId).toBe('notes/refund-policy.md');
    expect(r[0].field).toBe('docId');
  });

  it('drops non-matches and respects the limit', () => {
    const r = quickSwitch(items, 'zzz');
    expect(r).toHaveLength(0);
    expect(quickSwitch(items, 'e', 2).length).toBeLessThanOrEqual(2);
  });

  it('empty query returns items in original order up to limit', () => {
    const r = quickSwitch(items, '', 2);
    expect(r.map((x) => x.docId)).toEqual(['notes/apollo.md', 'notes/roadmap.md']);
  });
});
