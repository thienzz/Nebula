// Lightweight, browser-native UI preferences (localStorage) — distinct from the vault Settings
// store (settings/store.ts), which holds retrieval/ingestion params persisted to the vault. These
// are pure UI affordances that should survive a refresh WITHOUT touching the SurrealDB schema:
//   • which chat model the user picked at the startup model gate (FR-MDL-005, the onboarding),
//   • whether that one-time model gate has been shown,
//   • explicit (possibly empty) folders the user created in the file tree (FR-NAV-002 / FR-NOTE-007),
//   • the last workspace view (Files vs Graph).
// Every accessor is guarded: no `window`/`localStorage` (SSR, locked-down webview) → safe defaults,
// never a throw. The app must work even when storage is unavailable — these are conveniences.

const NS = 'nebula.ui';
const K_MODEL = `${NS}.model`;
const K_ONBOARDED = `${NS}.onboarded`;
const K_FOLDERS = `${NS}.emptyFolders`;
const K_VIEW = `${NS}.view`;

function store(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    // Some embeddings throw on access (privacy mode, sandboxed iframe) rather than returning null.
    return null;
  }
}

function read(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    store()?.setItem(key, value);
  } catch {
    /* storage full / denied — a lost UI pref is non-fatal */
  }
}

function remove(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** The chat model the user chose at the startup gate, or null if never chosen. */
export function getModelPref(): string | null {
  const v = read(K_MODEL);
  return v && v.trim() ? v : null;
}
export function setModelPref(modelId: string): void {
  if (modelId && modelId.trim()) write(K_MODEL, modelId);
}

/** Has the one-time startup model gate been completed (picked or skipped)? */
export function isOnboarded(): boolean {
  return read(K_ONBOARDED) === '1';
}
export function setOnboarded(done = true): void {
  if (done) write(K_ONBOARDED, '1');
  else remove(K_ONBOARDED);
}

/** Explicit folders the user created in the tree — kept so EMPTY folders survive a refresh. */
export function getEmptyFolders(): string[] {
  const raw = read(K_FOLDERS);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
export function setEmptyFolders(folders: Iterable<string>): void {
  const uniq = [...new Set([...folders])].filter((f) => f && f.trim()).sort();
  write(K_FOLDERS, JSON.stringify(uniq));
}

export type WorkspaceView = 'files' | 'graph';
export function getView(): WorkspaceView {
  return read(K_VIEW) === 'graph' ? 'graph' : 'files';
}
export function setView(view: WorkspaceView): void {
  write(K_VIEW, view);
}
