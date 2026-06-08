// Folder operations over the path-derived vault (FR-NAV-002 · FR-NOTE-007/008). Nebula has no
// separate "folder" record — folders are a pure derivation of note paths (`clients/acme/x.md`).
// So creating, renaming, moving, and deleting folders is path math: this module owns that math,
// pure and deterministic, so the page just applies the results (re-key chunks, persist notes).
// Empty folders the user creates are tracked separately by the caller (ui-prefs); these helpers
// only compute the path rewrites a folder mutation implies.

import { slugify, normalizeFolder } from '$lib/vault/note-crud';

/** The folder portion of a docId (`clients/acme/x.md` → `clients/acme`; root file → ''). */
export function folderOf(docId: string): string {
  const i = docId.lastIndexOf('/');
  return i >= 0 ? docId.slice(0, i) : '';
}

/** True if `docId` (a file) or `path` (a folder) lives at or under `folder`. */
export function isUnder(path: string, folder: string): boolean {
  if (!folder) return true;
  return path === folder || path.startsWith(folder + '/');
}

/** docIds of every note inside `folder`, recursively (deterministic order preserved from input). */
export function notesUnderFolder(docIds: Iterable<string>, folder: string): string[] {
  const prefix = folder.endsWith('/') ? folder : folder + '/';
  return [...docIds].filter((d) => d.startsWith(prefix));
}

/**
 * The docId a note takes when its containing folder moves from `oldFolder` to `newFolder`
 * (a prefix swap that preserves the sub-path below the folder). Notes not under `oldFolder`
 * are returned unchanged.
 */
export function repathUnderFolder(docId: string, oldFolder: string, newFolder: string): string {
  if (docId === oldFolder) return newFolder; // a folder path itself (for empty-folder bookkeeping)
  const op = oldFolder.endsWith('/') ? oldFolder : oldFolder + '/';
  if (!docId.startsWith(op)) return docId;
  const np = newFolder ? (newFolder.endsWith('/') ? newFolder : newFolder + '/') : '';
  return np + docId.slice(op.length);
}

/**
 * Derive a collision-free child-folder path `<parent>/<slug(name)>` (FR-NOTE-007 sibling). `parent`
 * may be '' (vault root → defaults to `notes`). If a folder OR a note's folder already occupies the
 * path, suffix `-2`, `-3`, … so a new folder never silently merges into an existing one.
 */
export function deriveChildFolder(
  parent: string,
  name: string,
  existingFolders: Iterable<string> = []
): string {
  const base = normalizeFolder(parent) || 'notes';
  const seg = slugify(name);
  const taken = new Set(existingFolders);
  let candidate = `${base}/${seg}`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}/${seg}-${n}`;
    n++;
  }
  return candidate;
}

/** Rename the LAST segment of a folder path, keeping its parent (`a/b/c` renamed "D" → `a/b/d`). */
export function renamedFolderPath(folder: string, newName: string): string {
  const slash = folder.lastIndexOf('/');
  const parent = slash >= 0 ? folder.slice(0, slash) : '';
  const seg = slugify(newName);
  return parent ? `${parent}/${seg}` : seg;
}

/** Every folder prefix implied by a set of note docIds + explicit empty folders, sorted, deduped. */
export function allFolders(
  docIds: Iterable<string>,
  emptyFolders: Iterable<string> = []
): string[] {
  const set = new Set<string>();
  const addPrefixes = (segs: string[]): void => {
    let p = '';
    for (const seg of segs) {
      p = p ? `${p}/${seg}` : seg;
      set.add(p);
    }
  };
  for (const docId of docIds) {
    const segs = docId.split('/').filter(Boolean);
    segs.pop(); // drop the file leaf — keep its folder chain
    addPrefixes(segs);
  }
  // Empty folders contribute their OWN ancestor chain too (so a `projects/empty` surfaces `projects`).
  for (const folder of emptyFolders) addPrefixes(folder.split('/').filter(Boolean));
  return [...set].filter(Boolean).sort();
}
