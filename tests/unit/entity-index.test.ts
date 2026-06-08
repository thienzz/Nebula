import { describe, it, expect } from 'vitest';
import {
  buildEntityIndex,
  notesForEntity,
  entityNeighbors
} from '../../src/lib/graph/entity-index';
import type { EntityRecord, MentionEdge, RelationEdge } from '../../src/lib/graph/types';

const entities: EntityRecord[] = [
  { id: 'acme', name: 'Acme', type: 'org', aliases: [] },
  { id: 'john', name: 'John', type: 'person', aliases: [] },
  { id: 'orphan', name: 'Orphan', type: 'concept', aliases: [] } // no mentions
];

const mentions: MentionEdge[] = [
  { docId: 'd1', chunkId: 'd1#0', entityId: 'acme' },
  { docId: 'd1', chunkId: 'd1#0', entityId: 'john' },
  { docId: 'd2', chunkId: 'd2#0', entityId: 'john' },
  { docId: 'd2', chunkId: 'd2#1', entityId: 'john' } // same doc, different chunk → still 1 note
];

describe('buildEntityIndex', () => {
  it('counts DISTINCT docs per entity, drops orphans, sorts by count then name', () => {
    const index = buildEntityIndex(entities, mentions);
    expect(index.map((e) => e.id)).toEqual(['john', 'acme']); // john=2 docs, acme=1; orphan omitted
    expect(index[0]).toMatchObject({ id: 'john', noteCount: 2, docIds: ['d1', 'd2'] });
    expect(index[1]).toMatchObject({ id: 'acme', noteCount: 1, docIds: ['d1'] });
  });

  it('omits entities with zero mentions', () => {
    expect(buildEntityIndex(entities, mentions).find((e) => e.id === 'orphan')).toBeUndefined();
  });
});

describe('notesForEntity', () => {
  it('returns distinct docIds mentioning the entity, sorted', () => {
    expect(notesForEntity(mentions, 'john')).toEqual(['d1', 'd2']);
    expect(notesForEntity(mentions, 'nope')).toEqual([]);
  });
});

describe('entityNeighbors (1-hop, both directions)', () => {
  const relations: RelationEdge[] = [
    { sourceId: 'acme', targetId: 'john', type: 'hired' },
    { sourceId: 'john', targetId: 'projx', type: 'leads' }
  ];

  it('returns outgoing and incoming neighbors with direction + label', () => {
    const n = entityNeighbors(relations, 'john');
    expect(n).toEqual([
      { id: 'acme', type: 'hired', direction: 'in' }, // acme → john
      { id: 'projx', type: 'leads', direction: 'out' } // john → projx
    ]);
  });

  it('returns [] for an entity with no relations', () => {
    expect(entityNeighbors(relations, 'isolated')).toEqual([]);
  });
});
