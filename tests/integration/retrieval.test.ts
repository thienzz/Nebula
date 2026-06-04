import { describe, it, expect } from 'vitest';
import { vectorSearch, hybridSearch, type IndexedChunk } from '../../src/lib/retrieval/search';

// TC-RET-001 (top-K cosine, P1) + TC-RET-003 (hybrid beats vector on exact terms, P2).
// Fixture corpus with hand-authored embeddings (topic axes) — no GPU/DB.

const corpus: IndexedChunk[] = [
  {
    chunkId: 'c1',
    docId: 'arch',
    text: 'system architecture overview',
    page: 1,
    charStart: 0,
    charEnd: 28,
    embedding: [1, 0, 0]
  },
  {
    chunkId: 'c2',
    docId: 'arch',
    text: 'more architecture and design notes',
    page: 2,
    charStart: 0,
    charEnd: 34,
    embedding: [0.95, 0.1, 0]
  },
  {
    chunkId: 'c3',
    docId: 'cats',
    text: 'all about cats and kittens',
    page: 1,
    charStart: 0,
    charEnd: 26,
    embedding: [0, 1, 0]
  },
  {
    chunkId: 'c4',
    docId: 'incident',
    text: 'incident TICKET-4242 root cause analysis',
    page: 1,
    charStart: 0,
    charEnd: 40,
    embedding: [0, 0, 1]
  }
];

describe('TC-RET-001 — top-K cosine returns ranked hits', () => {
  it('returns ≤K hits in descending score with source+page+span; correct source in top-K', () => {
    const queryAboutArchitecture = [1, 0, 0];
    const hits = vectorSearch(queryAboutArchitecture, corpus, { k: 2 });

    expect(hits.length).toBeLessThanOrEqual(2);
    // descending score
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    }
    // each hit carries source + page + span
    for (const h of hits) {
      expect(h.docId).toBeTruthy();
      expect(h.page).toBeTypeOf('number');
      expect(h.charEnd).toBeGreaterThan(h.charStart);
    }
    // the labeled correct source (architecture) is in the top-K
    expect(hits.map((h) => h.docId)).toContain('arch');
    expect(hits[0].chunkId).toBe('c1');
  });
});

describe('TC-RET-003 — hybrid beats pure-vector on exact terms', () => {
  it('recovers a verbatim ID that cosine ranks outside top-K', () => {
    const query = [1, 0, 0]; // semantically "architecture"
    const k = 2;

    const vectorHits = vectorSearch(query, corpus, { k }).map((h) => h.chunkId);
    const hybridHits = hybridSearch(query, ['TICKET-4242'], corpus, { k }).map((h) => h.chunkId);

    // Pure vector (architecture query) misses the incident ticket.
    expect(vectorHits).not.toContain('c4');
    // Hybrid fuses the exact-term lexical hit and surfaces it.
    expect(hybridHits).toContain('c4');
    // Recall of the exact-term doc: hybrid ≥ vector.
    const recall = (hits: string[]) => (hits.includes('c4') ? 1 : 0);
    expect(recall(hybridHits)).toBeGreaterThanOrEqual(recall(vectorHits));
  });
});
