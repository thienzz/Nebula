import { describe, it, expect } from 'vitest';
import { buildFileTree, flattenFiles } from '../../src/lib/nav/tree';

describe('buildFileTree with empty folders', () => {
  it('still builds the file tree unchanged when no extra folders are given', () => {
    const tree = buildFileTree(['notes/a.md', 'notes/sub/b.md']);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('notes');
    // Folders sort before files, so the nested `sub/b.md` flattens ahead of the sibling `a.md`.
    expect(flattenFiles(tree)).toEqual(['notes/sub/b.md', 'notes/a.md']);
  });

  it('materializes an explicit empty folder that holds no notes', () => {
    const tree = buildFileTree(['notes/a.md'], ['projects/empty']);
    const names = tree.map((n) => n.name);
    expect(names).toContain('projects');
    const projects = tree.find((n) => n.name === 'projects')!;
    expect(projects.children.map((c) => c.name)).toEqual(['empty']);
    expect(projects.children[0].kind).toBe('folder');
    expect(projects.children[0].children).toEqual([]);
  });

  it('does not duplicate a folder that already exists from a note path', () => {
    const tree = buildFileTree(['notes/a.md'], ['notes']);
    expect(tree.filter((n) => n.name === 'notes')).toHaveLength(1);
  });

  it('keeps folders before files, both alphabetical', () => {
    const tree = buildFileTree(['z.md', 'notes/a.md'], ['aaa']);
    // folders (aaa, notes) sort before the root file z.md
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual([
      'folder:aaa',
      'folder:notes',
      'file:z.md'
    ]);
  });
});
