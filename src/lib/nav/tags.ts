// Tag index (FR-NAV-003) · OBSIDIAN-DNA §5.9.
//
// Obsidian's Tag pane lets you browse/filter by `tags:` frontmatter — Nebula already writes that
// frontmatter via AI auto-tagging (FR-ING-006) and manual notes, so the tag index is a pure
// aggregation of it. Tags are normalized (lowercased, leading `#` stripped) and counted across
// the vault, sorted by count then name. ALGORITHMS §17.

export interface TagEntry {
  tag: string; // normalized, no leading '#'
  count: number;
  docIds: string[];
}

export interface TaggedNote {
  docId: string;
  tags?: unknown; // frontmatter.tags — string[] | string | undefined (tolerant)
}

/** Normalize a single tag: trim, drop a leading `#`, lowercase. Empty → null (skip). */
function normTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().replace(/^#/, '').toLowerCase();
  return t || null;
}

/** Coerce a frontmatter `tags` value (array, comma/space string, or single) to a string[]. */
export function coerceTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(normTag).filter((t): t is string => t !== null);
  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map(normTag)
      .filter((t): t is string => t !== null);
  }
  return [];
}

/**
 * Extract inline `#hashtags` from a note body (Obsidian counts these alongside frontmatter
 * `tags:`). A tag starts at a word boundary, begins with a letter/`_`, and may contain
 * `\w`, `-`, `/` (nested tags). Normalized like frontmatter tags. Pure.
 */
export function extractInlineTags(body: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s(])#([A-Za-z_][\w/-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const t = normTag(m[1]);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Build the vault tag index (FR-NAV-003): each distinct tag with its count and the docIds that
 * carry it, sorted by descending count then tag name. A note's tags are deduped within the note
 * so a repeated tag doesn't inflate the count.
 */
export function buildTagIndex(notes: TaggedNote[]): TagEntry[] {
  const map = new Map<string, Set<string>>();
  for (const note of notes) {
    const tags = new Set(coerceTags(note.tags));
    for (const tag of tags) {
      if (!map.has(tag)) map.set(tag, new Set());
      map.get(tag)!.add(note.docId);
    }
  }
  const entries: TagEntry[] = [...map].map(([tag, docs]) => ({
    tag,
    count: docs.size,
    docIds: [...docs].sort()
  }));
  entries.sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  return entries;
}

/** The docIds tagged with `tag` (normalized match). */
export function notesForTag(notes: TaggedNote[], tag: string): string[] {
  const want = normTag(tag);
  if (!want) return [];
  return notes.filter((n) => coerceTags(n.tags).includes(want)).map((n) => n.docId);
}
