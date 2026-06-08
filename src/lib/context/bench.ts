// Context-Engine bench engine (CE0) — the reference vault, the gold question set, and the three
// strategies it compares. Pure + deterministic: strategies operate on supplied vectors (synthetic by
// default, real bge-m3 behind a flag in the runner), so `npm run bench` writes a byte-stable
// results.json. The whole point is to MEASURE that "compiled" (CE1, select.ts) beats "naive vector
// top-k" at a fraction of "raw folder dump"'s tokens. ALGORITHMS §5.

import { selectContext, type SelectionCandidate } from './select';
import { scoreStrategy, averageScores, type StrategyScore } from './bench-score';

export interface BenchNote {
  docId: string;
  text: string;
  entities: string[];
  /** Synthetic cosine to query 1 / query 2 (the real-model path overrides vec via embeddings). */
  c1: number;
  c2: number;
}

export interface BenchQuestion {
  id: string;
  query: string;
  /** Which query axis this question uses (0 → c1, 1 → c2). */
  axis: 0 | 1;
  gold: string[]; // docIds that SHOULD reach the cloud model
}

// A small but deliberately STRUCTURED vault: two projects (Atlas, Orion), each with a status note and
// a budget/risk note worded like the query (high cosine = vector "seeds"), plus a champion and a rival
// note that share the project ENTITY but use none of the query's words (low cosine = graph-only). Two
// distractor notes use some query words but no shared entity (high-ish cosine, NOT relevant) — exactly
// the trap that fools cosine top-k. All texts are ~equal length so a fixed budget fits ~4 notes.
export const REFERENCE_VAULT: BenchNote[] = [
  { docId: 'deals/atlas-status.md',    text: 'Atlas project status update: the rollout is on track for the current quarter overall.', entities: ['Atlas'],          c1: 0.95, c2: 0.0 }, // prettier-ignore
  { docId: 'deals/atlas-budget.md',    text: 'Atlas budget risk: Finance has not approved the spend yet, and that is the main risk.', entities: ['Atlas', 'Finance'], c1: 0.9,  c2: 0.0 }, // prettier-ignore
  { docId: 'deals/atlas-champion.md',  text: 'Dana has been advocating internally for the initiative and steadily pushing it forward.', entities: ['Atlas', 'Dana'],   c1: 0.12, c2: 0.0 }, // prettier-ignore
  { docId: 'deals/atlas-rival.md',     text: 'A competitor submitted a noticeably lower proposal for the very same scope of work.', entities: ['Atlas', 'Helix'],   c1: 0.12, c2: 0.0 }, // prettier-ignore
  { docId: 'deals/orion-status.md',    text: 'Orion project status update: the design phase is complete and the build is starting now.', entities: ['Orion'],          c1: 0.0,  c2: 0.95 }, // prettier-ignore
  { docId: 'deals/orion-budget.md',    text: 'Orion budget risk: Finance flagged the spend for review, which is the principal risk here.', entities: ['Orion', 'Finance'], c1: 0.0,  c2: 0.9 }, // prettier-ignore
  { docId: 'deals/orion-owner.md',     text: 'Lee owns the effort and coordinates all of the cross team dependencies day to day.', entities: ['Orion', 'Lee'],    c1: 0.0,  c2: 0.12 }, // prettier-ignore
  { docId: 'deals/orion-rival.md',     text: 'A rival vendor is pursuing the same account with an aggressive discount on their bid.', entities: ['Orion', 'Helix'],   c1: 0.0,  c2: 0.12 }, // prettier-ignore
  { docId: 'ops/cadence.md',           text: 'Project status meetings are held every week to review progress against the plan together.', entities: [],                 c1: 0.2,  c2: 0.2 }, // prettier-ignore
  { docId: 'ops/standup.md',           text: 'The team runs a short daily standup to sync on tasks and surface blockers quickly.', entities: [],                 c1: 0.18, c2: 0.18 }, // prettier-ignore
  { docId: 'misc/cats.md',             text: 'Cats are small domesticated animals that famously enjoy sleeping for most of the day.', entities: [],                 c1: 0.0,  c2: 0.0 }, // prettier-ignore
  { docId: 'misc/weather.md',          text: 'The weather this week is mild with a gentle breeze and only a slight chance of rain.', entities: [],                 c1: 0.05, c2: 0.05 } // prettier-ignore
];

export const GOLD_QUESTIONS: BenchQuestion[] = [
  {
    id: 'atlas-status-risk',
    query: 'What is the status and the main risk of the Atlas project?',
    axis: 0,
    gold: ['deals/atlas-status.md', 'deals/atlas-budget.md', 'deals/atlas-champion.md', 'deals/atlas-rival.md'] // prettier-ignore
  },
  {
    id: 'orion-status-risk',
    query: 'What is the status and the main risk of the Orion project?',
    axis: 1,
    gold: ['deals/orion-status.md', 'deals/orion-budget.md', 'deals/orion-owner.md', 'deals/orion-rival.md'] // prettier-ignore
  }
];

/** A strategy returns the docIds it would send to the cloud model + the token cost. */
export interface StrategyOutput {
  selected: string[];
  tokens: number;
}

export interface VaultVecs {
  cosFor: (note: BenchNote, axis: 0 | 1) => number; // similarity of a note to a question's query
}

/** Synthetic similarity: the hand-set c1/c2. Deterministic, no model. */
export const SYNTHETIC_VECS: VaultVecs = {
  cosFor: (note, axis) => (axis === 0 ? note.c1 : note.c2)
};

export const DEFAULT_FLOOR = 0.25;

/** Strategy A — RAW folder dump: send every note. Maximum recall, maximum tokens, low precision. */
export function strategyRaw(
  vault: BenchNote[],
  countTokens: (t: string) => number
): StrategyOutput {
  return {
    selected: vault.map((n) => n.docId),
    tokens: vault.reduce((s, n) => s + countTokens(n.text), 0)
  };
}

/** Strategy B — NAIVE vector top-k: rank by cosine, admit greedily until the budget. No graph. */
export function strategyNaive(
  q: BenchQuestion,
  vault: BenchNote[],
  vecs: VaultVecs,
  budget: number,
  countTokens: (t: string) => number
): StrategyOutput {
  const ranked = [...vault]
    .map((n) => ({ n, cos: vecs.cosFor(n, q.axis) }))
    .sort((a, b) => b.cos - a.cos || (a.n.docId < b.n.docId ? -1 : 1));
  const selected: string[] = [];
  let tokens = 0;
  for (const { n } of ranked) {
    const t = countTokens(n.text);
    if (tokens + t > budget) continue;
    selected.push(n.docId);
    tokens += t;
  }
  return { selected: selected.sort(), tokens };
}

/** Strategy C — COMPILED (CE1): cosine seeds PLUS entity-graph siblings, budgeted via selectContext. */
export function strategyCompiled(
  q: BenchQuestion,
  vault: BenchNote[],
  vecs: VaultVecs,
  budget: number,
  countTokens: (t: string) => number,
  floor: number = DEFAULT_FLOOR
): StrategyOutput {
  // Seeds = notes above the cosine floor; their entities define the graph neighbourhood.
  const seedEntities = new Set<string>();
  for (const n of vault) if (vecs.cosFor(n, q.axis) >= floor) n.entities.forEach((e) => seedEntities.add(e)); // prettier-ignore

  const candidates: SelectionCandidate[] = vault.map((n) => {
    const cos = vecs.cosFor(n, q.axis);
    const shared = n.entities.filter((e) => seedEntities.has(e));
    return {
      chunkId: `${n.docId}#0`,
      docId: n.docId,
      seq: 0,
      text: n.text,
      score: cos,
      graphConnected: shared.length > 0,
      sharedCount: shared.length
    };
  });

  const res = selectContext(candidates, { tokenBudget: budget, countTokens, floor });
  return { selected: res.selected.map((c) => c.docId).sort(), tokens: res.tokenTotal };
}

export interface BenchResult {
  strategies: Record<'raw' | 'naive' | 'compiled', StrategyScore>;
  perQuestion: { id: string; raw: StrategyScore; naive: StrategyScore; compiled: StrategyScore }[];
  budgetPerQuestion: number;
  vaultSize: number;
  questionCount: number;
}

/**
 * Run the bench: for each gold question, size a budget to the gold set, run all three strategies, and
 * score them. Pure given `vecs` + `countTokens` — the runner injects synthetic or real-model vectors.
 */
export function runBench(opts: {
  vault?: BenchNote[];
  questions?: BenchQuestion[];
  vecs?: VaultVecs;
  countTokens: (t: string) => number;
  floor?: number;
}): BenchResult {
  const vault = opts.vault ?? REFERENCE_VAULT;
  const questions = opts.questions ?? GOLD_QUESTIONS;
  const vecs = opts.vecs ?? SYNTHETIC_VECS;
  const floor = opts.floor ?? DEFAULT_FLOOR;

  const raws: StrategyScore[] = [];
  const naives: StrategyScore[] = [];
  const compiledS: StrategyScore[] = [];
  const perQuestion: BenchResult['perQuestion'] = [];
  let lastBudget = 0;

  for (const q of questions) {
    // Budget = the cost of the gold set: enough room for the right material, not a token more.
    const budget = q.gold.reduce((s, id) => {
      const note = vault.find((n) => n.docId === id);
      return s + (note ? opts.countTokens(note.text) : 0);
    }, 0);
    lastBudget = budget;

    const raw = scoreStrategy(strategyRaw(vault, opts.countTokens).selected, q.gold, strategyRaw(vault, opts.countTokens).tokens); // prettier-ignore
    const naiveOut = strategyNaive(q, vault, vecs, budget, opts.countTokens);
    const naive = scoreStrategy(naiveOut.selected, q.gold, naiveOut.tokens);
    const compOut = strategyCompiled(q, vault, vecs, budget, opts.countTokens, floor);
    const compiled = scoreStrategy(compOut.selected, q.gold, compOut.tokens);

    perQuestion.push({ id: q.id, raw, naive, compiled });
    raws.push(raw);
    naives.push(naive);
    compiledS.push(compiled);
  }

  return {
    strategies: {
      raw: averageScores(raws),
      naive: averageScores(naives),
      compiled: averageScores(compiledS)
    },
    perQuestion,
    budgetPerQuestion: lastBudget,
    vaultSize: vault.length,
    questionCount: questions.length
  };
}
