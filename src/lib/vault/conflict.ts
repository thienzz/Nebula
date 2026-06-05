// Edit-conflict resolution (FR-DATA-004). Pure decision logic over three hashes:
//   base   — body hash when the note was loaded into the editor
//   disk   — body hash currently on disk (may have changed externally, e.g. Obsidian)
//   editor — body hash of the current in-app content
//
// THE ON-DISK FILE IS THE SOURCE OF TRUTH AND IS NEVER CLOBBERED WITHOUT CONSENT.
// On divergence (local edits AND external edits) we preserve BOTH by writing a
// timestamped `*.conflict.md` copy and prompting — neither version is lost.

export type ConflictPlan =
  | { action: 'noop' } // nothing changed
  | { action: 'save' } // only in-app edits → safe to write editor → disk
  | { action: 'reload' } // only external edits → take the on-disk version
  | { action: 'conflict'; conflictPath: string; conflictContent: string }; // both → preserve both

export interface ConflictInput {
  path: string; // the note path, e.g. 'notes/x.md'
  baseHash: string;
  diskHash: string;
  editorHash: string;
  editorContent: string; // preserved into the .conflict.md copy
}

/** Build the timestamped sibling path: `notes/x.md` → `notes/x.<stamp>.conflict.md`. */
export function conflictPathFor(path: string, stamp: string): string {
  const safe = stamp.replace(/[:.]/g, '-');
  return path.endsWith('.md')
    ? `${path.slice(0, -3)}.${safe}.conflict.md`
    : `${path}.${safe}.conflict.md`;
}

/**
 * Decide how to reconcile in-app vs on-disk state. `now` is injectable so the
 * conflict filename is deterministic in tests.
 */
export function resolveEditConflict(
  input: ConflictInput,
  now: () => string = () => new Date().toISOString()
): ConflictPlan {
  const externalChange = input.diskHash !== input.baseHash;
  const localDirty = input.editorHash !== input.baseHash;

  if (externalChange && localDirty) {
    return {
      action: 'conflict',
      conflictPath: conflictPathFor(input.path, now()),
      conflictContent: input.editorContent
    };
  }
  if (externalChange) return { action: 'reload' };
  if (localDirty) return { action: 'save' };
  return { action: 'noop' };
}
