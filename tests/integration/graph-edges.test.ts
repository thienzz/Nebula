import { describe, it, expect, afterEach } from 'vitest';
import { VectorStore, type ChunkRecord } from '../../src/lib/db/store';

// FR-GRAPH-002 · OBSIDIAN-DNA §5.3. REAL SurrealDB RELATE edges (@surrealdb/wasm, mem://).
// Proves `RELATE query->retrieved_from->chunk` persists + reads back as the Micro-Map.

const chunks: ChunkRecord[] = [
  {
    chunkId: 'a#0',
    docId: 'notes/a.md',
    text: 'arch',
    charStart: 0,
    charEnd: 4,
    embedding: [1, 0, 0]
  },
  {
    chunkId: 'b#0',
    docId: 'notes/b.md',
    text: 'fin',
    charStart: 0,
    charEnd: 3,
    embedding: [0, 1, 0]
  }
];

let store: VectorStore;
afterEach(async () => {
  await store?.close();
});

describe('VectorStore — retrieval sub-graph (RELATE)', () => {
  it('relates a query to its retrieved chunks and reads them back by rank', async () => {
    store = new VectorStore();
    await store.connect('mem://', 3);
    await store.upsertChunks(chunks);

    await store.relateRetrieval('q1', [
      { chunkId: 'a#0', score: 0.91 },
      { chunkId: 'b#0', score: 0.42 }
    ]);

    const sub = await store.getRetrievalSubgraph('q1');
    expect(sub).toHaveLength(2);
    expect(sub.map((e) => e.chunkId)).toEqual(['a#0', 'b#0']); // ordered by rank
    expect(sub[0]).toMatchObject({ docId: 'notes/a.md', score: 0.91, rank: 1 });
    expect(sub[1]).toMatchObject({ docId: 'notes/b.md', score: 0.42, rank: 2 });
  });

  it('re-relating replaces prior edges (ephemeral per turn)', async () => {
    store = new VectorStore();
    await store.connect('mem://', 3);
    await store.upsertChunks(chunks);

    await store.relateRetrieval('q1', [{ chunkId: 'a#0', score: 0.9 }]);
    await store.relateRetrieval('q1', [{ chunkId: 'b#0', score: 0.8 }]);

    const sub = await store.getRetrievalSubgraph('q1');
    expect(sub.map((e) => e.chunkId)).toEqual(['b#0']);
  });

  it('clearRetrieval drops the sub-graph', async () => {
    store = new VectorStore();
    await store.connect('mem://', 3);
    await store.upsertChunks(chunks);
    await store.relateRetrieval('q1', [{ chunkId: 'a#0', score: 0.9 }]);
    await store.clearRetrieval('q1');
    expect(await store.getRetrievalSubgraph('q1')).toEqual([]);
  });
});
