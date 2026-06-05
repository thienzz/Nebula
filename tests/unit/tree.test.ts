import { describe, it, expect } from 'vitest';
import { buildFileTree, flattenFiles } from '../../src/lib/nav/tree';

// FR-NAV-002 · OBSIDIAN-DNA §5.9. File/folder tree from note paths.

describe('buildFileTree', () => {
  it('nests folders from path segments with files as leaves', () => {
    const tree = buildFileTree([
      'notes/apollo.md',
      'notes/daily/2026-06-06.md',
      'notes/daily/2026-06-05.md',
      'sources/report.pdf'
    ]);
    // top level: folders "notes" and "sources" (alpha), both folders
    expect(tree.map((n) => n.name)).toEqual(['notes', 'sources']);
    const notes = tree.find((n) => n.name === 'notes')!;
    // inside notes: folder "daily" before file "apollo.md"
    expect(notes.children.map((n) => `${n.kind}:${n.name}`)).toEqual([
      'folder:daily',
      'file:apollo.md'
    ]);
    const daily = notes.children.find((n) => n.name === 'daily')!;
    expect(daily.children.map((n) => n.name)).toEqual(['2026-06-05.md', '2026-06-06.md']);
    expect(daily.children[0].docId).toBe('notes/daily/2026-06-05.md');
  });

  it('reuses a folder node across multiple files (no duplicate folders)', () => {
    const tree = buildFileTree(['notes/a.md', 'notes/b.md']);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((n) => n.name)).toEqual(['a.md', 'b.md']);
  });

  it('flattens files in display order', () => {
    const tree = buildFileTree(['notes/z.md', 'notes/sub/a.md', 'notes/m.md']);
    // folder "sub" first, then files m.md, z.md
    expect(flattenFiles(tree)).toEqual(['notes/sub/a.md', 'notes/m.md', 'notes/z.md']);
  });
});
