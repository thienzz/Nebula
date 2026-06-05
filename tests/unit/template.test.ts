import { describe, it, expect } from 'vitest';
import {
  isoDate,
  isoTime,
  expandTemplate,
  dailyNoteTitle,
  dailyNotePath,
  dailyNoteBody,
  BUILTIN_TEMPLATES
} from '../../src/lib/vault/template';

// FR-NOTE-005/006 · OBSIDIAN-DNA §5.8. Templates + daily notes.

describe('isoDate / isoTime', () => {
  it('extracts date and time from an ISO timestamp', () => {
    expect(isoDate('2026-06-06T09:30:00Z')).toBe('2026-06-06');
    expect(isoTime('2026-06-06T09:30:00Z')).toBe('09:30');
    expect(isoTime('2026-06-06')).toBe(''); // no time component
  });
});

describe('expandTemplate', () => {
  const now = '2026-06-06T09:30:00Z';

  it('expands built-in date/time/datetime/title tokens', () => {
    expect(expandTemplate('{{date}} @ {{time}}', { now })).toBe('2026-06-06 @ 09:30');
    expect(expandTemplate('{{datetime}}', { now })).toBe('2026-06-06 09:30');
    expect(expandTemplate('# {{title}}', { now, title: 'Hello' })).toBe('# Hello');
  });

  it('expands custom vars and tolerates whitespace in the braces', () => {
    expect(expandTemplate('Hi {{ name }}', { now, name: 'Thien' })).toBe('Hi Thien');
  });

  it('leaves unknown placeholders intact (never silently dropped)', () => {
    expect(expandTemplate('keep {{unknown}}', { now })).toBe('keep {{unknown}}');
  });

  it('is deterministic for a fixed now', () => {
    const body = BUILTIN_TEMPLATES[0].body;
    expect(expandTemplate(body, { now, title: 'Sync' })).toBe(
      expandTemplate(body, { now, title: 'Sync' })
    );
  });
});

describe('daily notes', () => {
  const now = '2026-06-06T09:30:00Z';

  it('titles and paths a daily note by ISO date', () => {
    expect(dailyNoteTitle(now)).toBe('2026-06-06');
    expect(dailyNotePath(now)).toBe('notes/2026-06-06.md');
  });

  it('builds a daily body with the date already expanded', () => {
    const body = dailyNoteBody(now);
    expect(body).toContain('# 2026-06-06');
    expect(body).not.toContain('{{'); // no unexpanded tokens
  });
});
