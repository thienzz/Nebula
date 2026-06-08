// Entity resolution — turning raw extracted names into stable, deduped graph nodes.
//
// The same real-world thing shows up under many surface forms across notes ("Acme", "ACME Corp",
// "John Doe", "john doe"). Without resolution the graph fills with near-duplicate nodes and every
// traversal/expansion fragments. This module collapses surface forms to a single canonical id and
// keeps the variants as aliases — the lightweight half of "entity resolution" (exact normalized
// match). Fuzzy/semantic merging ("J. Doe" == "John Doe") is deliberately out of scope here; it is
// the genuinely hard problem and would need its own pass. Pure & deterministic — no GPU/DB.

import type { EntityType, Extraction } from './entities';

/** A resolved graph node: one canonical id, a display name, its kind, and all surface forms seen. */
export interface ResolvedEntity {
  id: string; // canonical key, stable across re-ingests — used as the SurrealDB record id
  name: string; // display name (first non-empty surface form)
  type: EntityType;
  aliases: string[]; // every distinct surface form observed (incl. the display name)
}

export interface ResolvedRelation {
  sourceId: string;
  targetId: string;
  type: string;
  confidence?: number;
}

export interface ResolvedGraph {
  entities: ResolvedEntity[];
  relations: ResolvedRelation[];
}

/**
 * Canonical key for an entity name: NFKC-normalized, lowercased, whitespace→`_`, punctuation
 * stripped. Unicode letters are preserved so non-English entities (e.g. Vietnamese names with
 * diacritics) canonicalize correctly rather than being mangled by ASCII slugification. Returns ''
 * when nothing survives (caller skips it). Record-id safe (no spaces/slashes/dots).
 */
export function canonicalId(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_-]/gu, '');
}

/** Pick the better display name for the same entity: prefer the one with more original casing. */
function preferName(a: string, b: string): string {
  const upperCount = (s: string): number => (s.match(/\p{Lu}/gu) ?? []).length;
  if (upperCount(b) > upperCount(a)) return b;
  return a;
}

/**
 * Resolve a raw extraction into deduped canonical entities + relations whose endpoints reference
 * canonical ids. Entities sharing a canonical id are merged (type = first seen, aliases unioned).
 * Relations are dropped when either endpoint doesn't resolve to a kept entity, or when both
 * endpoints collapse to the same id (a self-loop after normalization). Deterministic ordering.
 */
export function resolveExtraction(ext: Extraction): ResolvedGraph {
  const byId = new Map<string, ResolvedEntity>();
  const order: string[] = []; // preserve first-seen order for determinism

  for (const e of ext.entities) {
    const id = canonicalId(e.name);
    if (!id) continue;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { id, name: e.name, type: e.type, aliases: [e.name] });
      order.push(id);
    } else {
      existing.name = preferName(existing.name, e.name);
      if (!existing.aliases.includes(e.name)) existing.aliases.push(e.name);
    }
  }

  const relations: ResolvedRelation[] = [];
  const relSeen = new Set<string>();
  for (const r of ext.relations) {
    const sourceId = canonicalId(r.source);
    const targetId = canonicalId(r.target);
    if (!sourceId || !targetId || sourceId === targetId) continue;
    if (!byId.has(sourceId) || !byId.has(targetId)) continue;
    const key = `${sourceId}|${targetId}|${r.type}`;
    if (relSeen.has(key)) continue;
    relSeen.add(key);
    const rel: ResolvedRelation = { sourceId, targetId, type: r.type };
    if (r.confidence !== undefined) rel.confidence = r.confidence;
    relations.push(rel);
  }

  return { entities: order.map((id) => byId.get(id)!), relations };
}
