// Quick switcher — fuzzy note jump (FR-NAV-001) · OBSIDIAN-DNA §5.7.
//
// Obsidian's most-used built-in is the Command Palette / Quick Switcher: type a few letters,
// jump to a note. This is the pure ranking core — a subsequence fuzzy matcher over note titles
// (falling back to the docId path), scoring consecutive runs and word-boundary hits higher so
// "apl" ranks "Apollo" above an incidental "a…p…l". No GPU/DB; ALGORITHMS §15.

export interface SwitchItem {
  docId: string;
  title: string;
}

export interface SwitchResult extends SwitchItem {
  score: number;
  field: 'title' | 'docId'; // which field produced the match (for highlight/debug)
}

const BOUNDARY = /[\s/\-_.]/;

/**
 * Subsequence fuzzy score of `query` against `target` (case-insensitive). Returns null when
 * not all query chars appear in order. Higher is better: consecutive matches and matches right
 * after a word boundary score more; longer targets are penalized slightly as a tiebreak.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase();
  if (q === '') return 0;
  let qi = 0;
  let score = 0;
  let lastMatch = -2;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    let s = 1;
    if (lastMatch === ti - 1) {
      streak += 1;
      s += streak * 2; // reward consecutive runs
    } else {
      streak = 0;
    }
    if (ti === 0 || BOUNDARY.test(t[ti - 1])) s += 3; // reward word-boundary starts
    score += s;
    lastMatch = ti;
    qi += 1;
  }
  if (qi < q.length) return null; // query not fully consumed → no match
  return score - t.length * 0.01;
}

/**
 * Rank items for the quick switcher (FR-NAV-001). Matches `query` against each item's title and
 * its docId path, keeping the better of the two. An empty query returns items in their original
 * order (recency/insertion is the caller's responsibility). Ties break by shorter title.
 */
export function quickSwitch(items: SwitchItem[], query: string, limit = 10): SwitchResult[] {
  const q = query.trim();
  if (q === '') {
    return items.slice(0, limit).map((it) => ({ ...it, score: 0, field: 'title' as const }));
  }
  const scored: SwitchResult[] = [];
  for (const it of items) {
    const titleScore = fuzzyScore(q, it.title);
    const docScore = fuzzyScore(q, it.docId);
    if (titleScore === null && docScore === null) continue;
    const useTitle = (titleScore ?? -Infinity) >= (docScore ?? -Infinity);
    scored.push({
      ...it,
      score: useTitle ? (titleScore as number) : (docScore as number),
      field: useTitle ? 'title' : 'docId'
    });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.title.length - b.title.length ||
      (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)
  );
  return scored.slice(0, limit);
}
