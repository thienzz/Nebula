import { describe, it, expect } from 'vitest';
import {
  planPasses,
  answerOverNotes,
  buildAnswerPrompt,
  buildMapPrompt,
  buildReducePrompt,
  type ReadSource,
  type CompleteFn
} from '../../src/lib/chat/longread';
import { NO_RESULTS_MESSAGE } from '../../src/lib/chat/prompt';

// Whole-note map-reduce reader (FR-CHAT-006). Pure planner + orchestration tested with a fake
// `complete` — no GPU. A whitespace word counter makes pass boundaries exact and readable.
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

describe('planPasses — packs whole notes into window-sized passes', () => {
  it('keeps notes that fit together in one pass', () => {
    const sources: ReadSource[] = [
      { docId: 'a', text: 'a a a' }, // 3
      { docId: 'b', text: 'b b' } // 2
    ];
    const passes = planPasses(sources, { budgetTokens: 10, countTokens: words });
    expect(passes).toHaveLength(1);
    expect(passes[0].parts.map((p) => p.docId)).toEqual(['a', 'b']);
  });

  it('starts a new pass when the next note would overflow the budget', () => {
    const sources: ReadSource[] = [
      { docId: 'a', text: 'a a a' }, // 3
      { docId: 'b', text: 'b b' } // 2 → 3+2=5 > 4
    ];
    const passes = planPasses(sources, { budgetTokens: 4, countTokens: words });
    expect(passes).toHaveLength(2);
    expect(passes[0].parts[0].docId).toBe('a');
    expect(passes[1].parts[0].docId).toBe('b');
  });

  it('splits a single over-long note across labeled parts spanning passes', () => {
    const long = Array.from({ length: 12 }, (_, i) => `w${i}`).join(' '); // 12 tokens
    const passes = planPasses([{ docId: 'big', text: long }], {
      budgetTokens: 4,
      countTokens: words
    });
    // 12 tokens / 4 per part → multiple parts, each its own pass, all labeled with the same total.
    expect(passes.length).toBeGreaterThan(1);
    const parts = passes.flatMap((p) => p.parts);
    expect(parts.every((p) => p.docId === 'big')).toBe(true);
    expect(parts.every((p) => p.part && p.part.total === parts.length)).toBe(true);
    // No content is lost: concatenating the parts in order reconstructs the note.
    expect(parts.map((p) => p.text.trim()).join(' ')).toBe(long);
  });

  it('skips blank notes', () => {
    const passes = planPasses([{ docId: 'x', text: '   ' }], {
      budgetTokens: 10,
      countTokens: words
    });
    expect(passes).toHaveLength(0);
  });
});

describe('prompt builders', () => {
  it('answer + map + reduce each carry the source/query/findings', () => {
    // A single unsplit note reaches the model as plain content (no source label noise).
    const pass = { parts: [{ docId: 'notes/x.md', text: 'hello world' }] };
    const a = buildAnswerPrompt('what?', pass, 'grounded');
    expect(a.user).toContain('hello world');
    expect(a.user).toContain('what?');

    // Multiple sources DO get labeled so the model can tell them apart.
    const multi = {
      parts: [
        { docId: 'notes/x.md', text: 'hello world' },
        { docId: 'notes/y.md', text: 'second note' }
      ]
    };
    expect(buildAnswerPrompt('what?', multi, 'grounded').user).toContain('notes/y.md');

    const m = buildMapPrompt('what?', pass);
    expect(m.system).toContain('NONE'); // map step instructs the NONE sentinel
    expect(m.user).toContain('hello world');

    const r = buildReducePrompt('what?', ['finding one', 'finding two'], 'reason');
    expect(r.user).toContain('finding one');
    expect(r.user).toContain('finding two');
    expect(r.user).toContain('what?');
  });
});

describe('answerOverNotes — orchestration', () => {
  const opts = {
    budgetTokens: 4096,
    mode: 'grounded' as const,
    maxAnswerTokens: 8,
    mapTokens: 8,
    reserveSystem: 8,
    countTokens: words
  };

  it('returns no-results without calling the model when there are no usable notes', async () => {
    let calls = 0;
    const complete: CompleteFn = async () => {
      calls++;
      return { text: 'x', ttftMs: 0, tokensPerSec: 0 };
    };
    const res = await answerOverNotes(
      'q',
      [],
      complete,
      () => {},
      new AbortController().signal,
      opts
    );
    expect(res.text).toBe(NO_RESULTS_MESSAGE);
    expect(res.passes).toBe(0);
    expect(calls).toBe(0);
  });

  it('single pass when notes fit: one streamed answer, no reduce', async () => {
    const streamed: string[] = [];
    let calls = 0;
    const complete: CompleteFn = async (req, onTok) => {
      calls++;
      expect(req.system).toContain('using the notes provided'); // the direct-answer system prompt
      const text = 'direct answer';
      for (const tok of text.split(' ')) onTok(tok + ' ');
      return { text, ttftMs: 5, tokensPerSec: 10 };
    };
    const res = await answerOverNotes(
      'q',
      [{ docId: 'a', text: 'short note' }],
      complete,
      (t) => streamed.push(t),
      new AbortController().signal,
      opts
    );
    expect(calls).toBe(1);
    expect(res.passes).toBe(1);
    expect(res.text).toBe('direct answer');
    expect(streamed.join('')).toContain('direct');
  });

  it('map-reduce when notes exceed the window: extracts per pass then synthesizes', async () => {
    const big = 'w '.repeat(8000).trim(); // far over the content budget → multiple passes
    let mapCalls = 0;
    let reduceCalls = 0;
    const complete: CompleteFn = async (req, onTok) => {
      if (req.system.includes('NONE')) {
        mapCalls++;
        return { text: `finding ${mapCalls}`, ttftMs: 1, tokensPerSec: 1 };
      }
      reduceCalls++;
      expect(req.user).toContain('finding 1'); // reduce sees the map findings
      const text = 'combined answer';
      for (const tok of text.split(' ')) onTok(tok + ' ');
      return { text, ttftMs: 7, tokensPerSec: 9 };
    };
    const res = await answerOverNotes(
      'q',
      [{ docId: 'big', text: big }],
      complete,
      () => {},
      new AbortController().signal,
      opts
    );
    expect(mapCalls).toBeGreaterThan(1);
    expect(reduceCalls).toBe(1);
    expect(res.passes).toBe(mapCalls);
    expect(res.text).toBe('combined answer');
  });

  it('falls back to no-results when every map pass reports NONE', async () => {
    const big = 'w '.repeat(8000).trim();
    let reduceCalls = 0;
    const complete: CompleteFn = async (req) => {
      if (req.system.includes('NONE')) {
        return { text: 'NONE', ttftMs: 1, tokensPerSec: 1 };
      }
      reduceCalls++;
      return { text: 'should not happen', ttftMs: 0, tokensPerSec: 0 };
    };
    const res = await answerOverNotes(
      'q',
      [{ docId: 'big', text: big }],
      complete,
      () => {},
      new AbortController().signal,
      opts
    );
    expect(reduceCalls).toBe(0);
    expect(res.text).toBe(NO_RESULTS_MESSAGE);
  });
});
