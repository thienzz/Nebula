// File/folder tree (FR-NAV-002) · OBSIDIAN-DNA §5.9.
//
// Obsidian's File Explorer is table-stakes navigation. Nebula stores every note at a vault path
// (`notes/foo.md`, `notes/daily/2026-06-06.md`), so the tree is a pure derivation of those paths
// — no separate structure to maintain. Folders sort before files, both alphabetical. ALGORITHMS §17.

export interface TreeNode {
  name: string; // this segment's display name (folder name, or file stem+ext)
  path: string; // folder path (e.g. "notes/daily") or the file's docId
  kind: 'folder' | 'file';
  docId?: string; // present for files — the full path used everywhere downstream
  children: TreeNode[];
}

function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1; // folders first
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  for (const n of nodes) if (n.kind === 'folder') sortNodes(n.children);
}

/**
 * Build a nested folder tree from a flat list of note paths (FR-NAV-002). Each path's segments
 * become nested folders; the last segment is a file leaf carrying its `docId`. `extraFolders` adds
 * folders that hold no notes yet — the EMPTY folders a user explicitly created (FR-NOTE-007) — so
 * they still appear in the tree. Pure and deterministic: folders before files, both alphabetical.
 */
export function buildFileTree(docIds: string[], extraFolders: string[] = []): TreeNode[] {
  const roots: TreeNode[] = [];
  const folderByPath = new Map<string, TreeNode>();

  // Materialize a folder path (and every ancestor), returning its deepest node. Idempotent.
  const ensureFolder = (path: string): TreeNode | null => {
    const segs = path.split('/').filter(Boolean);
    let level = roots;
    let prefix = '';
    let node: TreeNode | null = null;
    for (const seg of segs) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      let folder = folderByPath.get(prefix);
      if (!folder) {
        folder = { name: seg, path: prefix, kind: 'folder', children: [] };
        folderByPath.set(prefix, folder);
        level.push(folder);
      }
      level = folder.children;
      node = folder;
    }
    return node;
  };

  for (const docId of docIds) {
    const segs = docId.split('/').filter(Boolean);
    if (segs.length === 0) continue;
    const file = segs[segs.length - 1];
    const parentPath = segs.slice(0, -1).join('/');
    const level = parentPath ? (ensureFolder(parentPath)?.children ?? roots) : roots;
    level.push({ name: file, path: docId, kind: 'file', docId, children: [] });
  }
  for (const folder of extraFolders) ensureFolder(folder);

  sortNodes(roots);
  return roots;
}

/** Flatten a tree to its file leaves' docIds, in display order (handy for tests / keyboard nav). */
export function flattenFiles(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: TreeNode[]) => {
    for (const n of ns) {
      if (n.kind === 'file' && n.docId) out.push(n.docId);
      else walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
