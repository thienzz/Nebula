import { describe, it, expect } from 'vitest';
import { resolveEditConflict, conflictPathFor } from '../../src/lib/vault/conflict';

// FR-DATA-004 — never clobber the on-disk file; preserve both on divergence.

const fixedNow = () => '2026-06-05T12:00:00.000Z';

describe('resolveEditConflict — four branches', () => {
  it('noop when nothing changed', () => {
    expect(
      resolveEditConflict({
        path: 'notes/x.md',
        baseHash: 'a',
        diskHash: 'a',
        editorHash: 'a',
        editorContent: ''
      })
    ).toEqual({ action: 'noop' });
  });

  it('save when only the editor changed', () => {
    expect(
      resolveEditConflict({
        path: 'notes/x.md',
        baseHash: 'a',
        diskHash: 'a',
        editorHash: 'b',
        editorContent: ''
      }).action
    ).toBe('save');
  });

  it('reload when only the disk changed externally', () => {
    expect(
      resolveEditConflict({
        path: 'notes/x.md',
        baseHash: 'a',
        diskHash: 'b',
        editorHash: 'a',
        editorContent: ''
      }).action
    ).toBe('reload');
  });

  it('conflict when both changed — preserves the in-app version, never the disk path', () => {
    const plan = resolveEditConflict(
      {
        path: 'notes/x.md',
        baseHash: 'a',
        diskHash: 'b',
        editorHash: 'c',
        editorContent: 'my unsaved work'
      },
      fixedNow
    );
    expect(plan.action).toBe('conflict');
    if (plan.action === 'conflict') {
      expect(plan.conflictContent).toBe('my unsaved work');
      // The conflict copy is a NEW sibling file — the original is untouched.
      expect(plan.conflictPath).not.toBe('notes/x.md');
      expect(plan.conflictPath).toMatch(/^notes\/x\..*\.conflict\.md$/);
    }
  });
});

describe('conflictPathFor', () => {
  it('builds a timestamped sibling and sanitizes : and .', () => {
    expect(conflictPathFor('notes/x.md', '2026-06-05T12:00:00.000Z')).toBe(
      'notes/x.2026-06-05T12-00-00-000Z.conflict.md'
    );
  });
  it('handles non-.md paths', () => {
    expect(conflictPathFor('a/b', '2026')).toBe('a/b.2026.conflict.md');
  });
});
