// SurrealDB vector store — FR-ING-005 (HNSW cosine index) + FR-RET-001 (top-K search).
// Uses @surrealdb/wasm, which runs the engine in-process: `mem://` in Node/tests,
// `indxdb://nebula` in the webview (DATA-MODEL §1, ADR-008). The store is a derived,
// rebuildable cache (FR-DATA-002) — the `.md` files remain the source of truth.

import { RecordId, Surreal } from 'surrealdb';
import { surrealdbWasmEngines } from '@surrealdb/wasm';
import { EMBEDDING_DIM } from '$lib/inference/provider';
import type { SearchHit } from '$lib/inference/provider';

export interface ChunkRecord {
  chunkId: string;
  docId: string;
  text: string;
  page?: number;
  charStart: number;
  charEnd: number;
  embedding: number[];
}

interface ChunkRow {
  chunkId: string;
  docId: string;
  text: string;
  page: number | null;
  charStart: number;
  charEnd: number;
  dist: number;
}

export class VectorStore {
  private db: Surreal | null = null;

  /** Connect + define the schema and the HNSW cosine index (FR-ING-005). */
  async connect(url = 'mem://', dimension = EMBEDDING_DIM): Promise<void> {
    const db = new Surreal({ engines: surrealdbWasmEngines() });
    await db.connect(url);
    await db.use({ namespace: 'nebula', database: 'nebula' });
    await db.query(
      `DEFINE TABLE chunk SCHEMALESS;
       DEFINE INDEX hnsw_idx ON chunk FIELDS embedding HNSW DIMENSION ${dimension} DIST COSINE;`
    );
    this.db = db;
  }

  private get conn(): Surreal {
    if (!this.db) throw new Error('VectorStore not connected');
    return this.db;
  }

  /**
   * Upsert chunks keyed by a stable record id (= chunkId), so re-ingesting a document
   * overwrites rather than duplicating (FR-ING-007 — chunks keyed by (document, seq)).
   */
  async upsertChunks(records: ChunkRecord[]): Promise<void> {
    for (const r of records) {
      await this.conn.query(
        'UPSERT type::thing("chunk", $cid) CONTENT { chunkId: $cid, docId: $docId, text: $text, page: $page, charStart: $cs, charEnd: $ce, embedding: $emb }',
        {
          cid: r.chunkId,
          docId: r.docId,
          text: r.text,
          page: r.page ?? null,
          cs: r.charStart,
          ce: r.charEnd,
          emb: r.embedding
        }
      );
    }
  }

  /** Cosine top-K KNN over the HNSW index (FR-RET-001). Returns hits in descending score. */
  async search(queryVec: number[], k = 8): Promise<SearchHit[]> {
    const topK = Math.max(1, Math.floor(k));
    const [rows] = await this.conn.query<[ChunkRow[]]>(
      `SELECT chunkId, docId, text, page, charStart, charEnd, vector::distance::knn() AS dist
       FROM chunk WHERE embedding <|${topK},COSINE|> $q ORDER BY dist`,
      { q: queryVec }
    );
    return (rows ?? []).map((row) => ({
      chunkId: row.chunkId,
      docId: row.docId,
      text: row.text,
      page: row.page ?? undefined,
      charStart: row.charStart,
      charEnd: row.charEnd,
      score: 1 - row.dist // cosine similarity = 1 − cosine distance (DATA-MODEL §4)
    }));
  }

  /** Remove all chunks for a document (re-index / delete — FR-DATA-002/003). */
  async deleteDoc(docId: string): Promise<void> {
    await this.conn.query('DELETE chunk WHERE docId = $docId', { docId });
  }

  /**
   * Record the retrieval sub-graph for a query as SurrealDB graph edges (FR-GRAPH-002,
   * OBSIDIAN-DNA §5.3): `RELATE query:⟨id⟩ -> retrieved_from -> chunk:⟨id⟩`, carrying the
   * cosine score + rank. Re-relating the same query replaces its prior edges so the
   * Micro-Map reflects only the latest turn.
   */
  async relateRetrieval(
    queryId: string,
    hits: { chunkId: string; score: number }[]
  ): Promise<void> {
    await this.clearRetrieval(queryId);
    const q = new RecordId('query', queryId);
    for (let i = 0; i < hits.length; i++) {
      await this.conn.query('RELATE $q->retrieved_from->$c SET score = $score, rank = $rank', {
        q,
        c: new RecordId('chunk', hits[i].chunkId),
        score: hits[i].score,
        rank: i + 1
      });
    }
  }

  /** Read back a query's retrieval sub-graph, ordered by rank (FR-GRAPH-001 render input). */
  async getRetrievalSubgraph(
    queryId: string
  ): Promise<{ chunkId: string; docId: string; score: number; rank: number }[]> {
    const [rows] = await this.conn.query<
      [{ chunkId: string; docId: string; score: number; rank: number }[]]
    >(
      `SELECT out.chunkId AS chunkId, out.docId AS docId, score, rank
       FROM retrieved_from WHERE in = $q ORDER BY rank`,
      { q: new RecordId('query', queryId) }
    );
    return rows ?? [];
  }

  /** Drop a query's edges — the Micro-Map is ephemeral per conversation turn (FR-GRAPH-002). */
  async clearRetrieval(queryId: string): Promise<void> {
    await this.conn.query('DELETE retrieved_from WHERE in = $q', {
      q: new RecordId('query', queryId)
    });
  }

  async count(): Promise<number> {
    const [rows] = await this.conn.query<[{ c: number }[]]>(
      'SELECT count() AS c FROM chunk GROUP ALL'
    );
    return rows?.[0]?.c ?? 0;
  }

  async close(): Promise<void> {
    await this.db?.close();
    this.db = null;
  }
}
