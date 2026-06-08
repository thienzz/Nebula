import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VectorStore, type ChunkRecord } from '../../src/lib/db/store';
import { buildEntityIndex } from '../../src/lib/graph/entity-index';

// Knowledge-graph persistence + traversal + GraphRAG against REAL SurrealDB (@surrealdb/wasm) via
// mem:// — no GPU, no network. Proves the graph half actually works in the engine, not just in pure
// fixtures. Mini-graph: Acme —hires→ John —leads→ Project X —uses→ Widget, spread over 3 docs.

const chunks: ChunkRecord[] = [
  {
    chunkId: 'd1#0',
    docId: 'd1',
    text: 'Acme hired John Doe.',
    charStart: 0,
    charEnd: 20,
    embedding: [1, 0, 0]
  },
  {
    chunkId: 'd2#0',
    docId: 'd2',
    text: 'John Doe leads Project X.',
    charStart: 0,
    charEnd: 25,
    embedding: [0, 1, 0]
  },
  {
    chunkId: 'd3#0',
    docId: 'd3',
    text: 'Project X uses Widget.',
    charStart: 0,
    charEnd: 22,
    embedding: [0, 0, 1]
  }
];

const entities = [
  { id: 'acme', name: 'Acme', type: 'org', aliases: ['Acme'] },
  { id: 'john_doe', name: 'John Doe', type: 'person', aliases: ['John Doe'] },
  { id: 'project_x', name: 'Project X', type: 'project', aliases: ['Project X'] },
  { id: 'widget', name: 'Widget', type: 'concept', aliases: ['Widget'] }
];

let store: VectorStore;

beforeEach(async () => {
  store = new VectorStore();
  await store.connect('mem://', 3);
  await store.upsertChunks(chunks);
  for (const e of entities) await store.upsertEntity(e);
  // mentions (chunk → entity), tagged with the doc that asserted them
  await store.relateMention('d1#0', 'd1', 'acme');
  await store.relateMention('d1#0', 'd1', 'john_doe');
  await store.relateMention('d2#0', 'd2', 'john_doe');
  await store.relateMention('d2#0', 'd2', 'project_x');
  await store.relateMention('d3#0', 'd3', 'project_x');
  await store.relateMention('d3#0', 'd3', 'widget');
  // relations (entity → entity)
  await store.relateEntities('acme', 'john_doe', 'hired', 'd1');
  await store.relateEntities('john_doe', 'project_x', 'leads', 'd2');
  await store.relateEntities('project_x', 'widget', 'uses', 'd3');
});

afterEach(async () => {
  await store?.close();
});

describe('entity + mention persistence', () => {
  it('persists entities (idempotent by id) and reads them back', async () => {
    await store.upsertEntity(entities[0]); // re-upsert Acme
    const all = await store.allEntities();
    expect(all).toHaveLength(4);
    expect(all.find((e) => e.id === 'john_doe')?.name).toBe('John Doe');
  });

  it('returns flat mention rows and an entity index with per-entity note counts', async () => {
    const mentions = await store.allMentions();
    expect(mentions).toHaveLength(6);
    const index = buildEntityIndex(await store.allEntities(), mentions);
    const john = index.find((e) => e.id === 'john_doe')!;
    expect(john.noteCount).toBe(2); // mentioned in d1 and d2
    expect(john.docIds).toEqual(['d1', 'd2']);
  });

  it('mentionsForEntity returns the docs that mention it', async () => {
    const m = await store.mentionsForEntity('john_doe');
    expect(m.map((x) => x.docId).sort()).toEqual(['d1', 'd2']);
  });

  it('entityIdsForChunks returns the entities a chunk mentions', async () => {
    const ids = await store.entityIdsForChunks(['d1#0']);
    expect(ids.sort()).toEqual(['acme', 'john_doe']);
  });
});

describe('relations + multi-hop traversal', () => {
  it('persists relations and filters to a sub-set', async () => {
    expect(await store.allRelations()).toHaveLength(3);
    const among = await store.relationsAmong(['acme', 'john_doe']);
    expect(among).toEqual([{ sourceId: 'acme', targetId: 'john_doe', type: 'hired' }]);
  });

  it('traverses the persisted graph multiple hops from a start entity', async () => {
    // From Acme: 1 hop → John Doe; 2 hops → Project X; Widget is 3 hops away (excluded at hops=2).
    const within2 = await store.entityNeighbors('acme', 2);
    const byId = new Map(within2.map((n) => [n.id, n.hop]));
    expect(byId.get('john_doe')).toBe(1);
    expect(byId.get('project_x')).toBe(2);
    expect(byId.has('widget')).toBe(false);

    const within3 = await store.entityNeighbors('acme', 3);
    expect(within3.find((n) => n.id === 'widget')?.hop).toBe(3);
  });
});

describe('GraphRAG retrieval (vector seed + graph expansion, fused)', () => {
  it('pulls in a structurally-connected chunk the narrow vector search would miss', async () => {
    // Query hugs d1 only. With seedK=1 the vector pass returns just d1#0 (about Acme+John).
    const res = await store.graphRagSearch([0.95, 0.05, 0], { seedK: 1, expandK: 5, k: 5 });
    expect(res.seeds.map((h) => h.chunkId)).toEqual(['d1#0']);
    // Acme/John's entities expand to d2#0 (John leads Project X) — semantically distant, structurally near.
    expect(res.expanded.map((h) => h.chunkId)).toContain('d2#0');
    // …and it explains WHY it's here: the seed entity it shares (John Doe), with a count.
    const d2 = res.expanded.find((h) => h.chunkId === 'd2#0')!;
    expect(d2.sharedCount).toBe(1);
    expect(d2.sharedEntities).toEqual(['John Doe']);
    // The fused context therefore contains BOTH the seed and the graph-reached sibling.
    const fusedIds = res.fused.map((h) => h.chunkId);
    expect(fusedIds).toContain('d1#0');
    expect(fusedIds).toContain('d2#0');
  });

  it('degrades to plain vector results when the vault has no graph', async () => {
    const bare = new VectorStore();
    await bare.connect('mem://', 3);
    await bare.upsertChunks(chunks);
    const res = await bare.graphRagSearch([0.95, 0.05, 0], { seedK: 2, k: 2 });
    expect(res.entityIds).toEqual([]);
    expect(res.expanded).toEqual([]);
    expect(res.fused.map((h) => h.chunkId)).toContain('d1#0');
    await bare.close();
  });
});

describe('incremental-extraction guard (graphmeta content hash)', () => {
  it('persists + reads back a content hash and overwrites in place when text changes', async () => {
    expect(await store.getGraphHash('d1')).toBeNull(); // never extracted → no hash
    await store.setGraphHash('d1', 'abc123');
    expect(await store.getGraphHash('d1')).toBe('abc123'); // same hash next rebuild → caller SKIPS
    await store.setGraphHash('d1', 'def456'); // note edited → new hash → caller re-extracts
    expect(await store.getGraphHash('d1')).toBe('def456');
  });

  it('clearDocGraph forgets the hash so a deleted/re-added doc re-extracts', async () => {
    await store.setGraphHash('d3', 'h3');
    await store.clearDocGraph('d3');
    expect(await store.getGraphHash('d3')).toBeNull();
  });
});

describe('scoped graph cleanup', () => {
  it('clearDocGraph removes a doc’s edges but leaves entity nodes for other docs', async () => {
    await store.clearDocGraph('d2');
    const mentions = await store.allMentions();
    expect(mentions.find((m) => m.docId === 'd2')).toBeUndefined();
    // John was mentioned in d1 and d2; after clearing d2 he's still mentioned in d1.
    expect((await store.mentionsForEntity('john_doe')).map((m) => m.docId)).toEqual(['d1']);
    // Entity nodes are untouched (rebuildable cache, may be referenced elsewhere).
    expect(await store.allEntities()).toHaveLength(4);
    // The d2-asserted relation is gone; the other two remain.
    expect(await store.allRelations()).toHaveLength(2);
  });
});
