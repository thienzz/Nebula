import { describe, it, expect } from 'vitest';
import {
  folderOf,
  isUnder,
  notesUnderFolder,
  repathUnderFolder,
  deriveChildFolder,
  renamedFolderPath,
  allFolders
} from '../../src/lib/nav/folders';

describe('folderOf', () => {
  it('returns the directory of a docId, or "" at the root', () => {
    expect(folderOf('clients/acme/x.md')).toBe('clients/acme');
    expect(folderOf('notes/x.md')).toBe('notes');
    expect(folderOf('x.md')).toBe('');
  });
});

describe('isUnder / notesUnderFolder', () => {
  const docs = ['clients/acme/a.md', 'clients/acme/sub/b.md', 'clients/beta/c.md', 'notes/d.md'];
  it('matches a folder and its descendants only', () => {
    expect(isUnder('clients/acme/a.md', 'clients/acme')).toBe(true);
    expect(isUnder('clients/acme', 'clients/acme')).toBe(true);
    expect(isUnder('clients/beta/c.md', 'clients/acme')).toBe(false);
  });
  it('collects every note under a folder, recursively', () => {
    expect(notesUnderFolder(docs, 'clients/acme')).toEqual([
      'clients/acme/a.md',
      'clients/acme/sub/b.md'
    ]);
    expect(notesUnderFolder(docs, 'clients')).toHaveLength(3);
  });
});

describe('repathUnderFolder', () => {
  it('swaps the folder prefix, preserving the sub-path', () => {
    expect(repathUnderFolder('clients/acme/sub/b.md', 'clients/acme', 'archive/acme')).toBe(
      'archive/acme/sub/b.md'
    );
  });
  it('rewrites the folder path itself (empty-folder bookkeeping)', () => {
    expect(repathUnderFolder('clients/acme', 'clients/acme', 'archive/acme')).toBe('archive/acme');
  });
  it('leaves notes outside the folder untouched', () => {
    expect(repathUnderFolder('notes/d.md', 'clients/acme', 'archive/acme')).toBe('notes/d.md');
  });
});

describe('deriveChildFolder', () => {
  it('slugifies the name under the parent', () => {
    expect(deriveChildFolder('clients', 'Acme Inc')).toBe('clients/acme-inc');
    expect(deriveChildFolder('', 'Inbox')).toBe('notes/inbox'); // empty parent → notes root
  });
  it('suffixes to avoid colliding with an existing folder', () => {
    expect(deriveChildFolder('clients', 'Acme', ['clients/acme'])).toBe('clients/acme-2');
    expect(deriveChildFolder('clients', 'Acme', ['clients/acme', 'clients/acme-2'])).toBe(
      'clients/acme-3'
    );
  });
});

describe('renamedFolderPath', () => {
  it('renames the last segment, keeping the parent', () => {
    expect(renamedFolderPath('clients/acme', 'Acme Corp')).toBe('clients/acme-corp');
    expect(renamedFolderPath('inbox', 'Reading')).toBe('reading');
  });
});

describe('allFolders', () => {
  it('lists every folder prefix from notes plus explicit empty folders, sorted + deduped', () => {
    const docs = ['clients/acme/a.md', 'notes/d.md'];
    expect(allFolders(docs, ['projects/empty'])).toEqual([
      'clients',
      'clients/acme',
      'notes',
      'projects',
      'projects/empty'
    ]);
  });
});
