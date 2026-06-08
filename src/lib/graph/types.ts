// Shared knowledge-graph row shapes — the contract between the persistence layer (db/store.ts)
// and the pure graph/retrieval modules (entity-index, graphrag, entity-graph). Kept dependency-free
// so the pure modules never pull in the SurrealDB wasm engine just to name a type.

/** A graph node as persisted/returned: canonical id + display name + kind + observed surface forms. */
export interface EntityRecord {
  id: string;
  name: string;
  type: string;
  aliases: string[];
}

/** A chunk→entity mention edge, carrying the doc it came from (provenance + scope filtering). */
export interface MentionEdge {
  docId: string;
  chunkId: string;
  entityId: string;
}

/** An entity→entity relation edge with its label and the doc that asserted it (provenance). */
export interface RelationEdge {
  sourceId: string;
  targetId: string;
  type: string;
  docId?: string;
}
