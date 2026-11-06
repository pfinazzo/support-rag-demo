/**
 * Why this file exists: the semantic cache must find the saved question closest
 * in meaning to a new one. Comparing against every saved vector gets slower with
 * each answer saved. An HNSW index (Malkov and Yashunin) walks a layered graph
 * of neighbours and reaches a close match in a few steps.
 * It runs inside our server and needs no native add-on.
 * Without it, every lookup would scan the whole list.
 */
import { cosineSimilarity } from './embeddings.js';

/** One vector in the graph. */
interface Node {
  id: string;
  vector: number[];
  /** The highest layer this node is on. Every node is on layer 0. */
  level: number;
  /** Neighbour ids on each layer, from layer 0 up to `level`. */
  links: Set<string>[];
}

/** One search result: a stored id and how close it is to the query. */
export interface AnnMatch {
  id: string;
  /** Cosine similarity, from -1 to 1. */
  similarity: number;
}

/**
 * Inputs for walking one layer.
 * `starts` are the ids to begin from. `ef` is how many of the best matches to
 * keep while walking. A larger `ef` finds closer matches but takes longer.
 */
type SearchLayerParams = { query: number[]; starts: string[]; ef: number; layer: number };

/** Inputs for a search. `k` is how many matches to return. `efSearch` is the `ef` used on layer 0. */
type SearchParams = { vector: number[]; k?: number; efSearch?: number };

/** An in-memory HNSW index. Each semantic cache scope has its own instance. */
export class HnswAnnIndex {
  private nodes = new Map<string, Node>();

  /** Id of the node where every search starts. It is on the highest layer. Null while the index is empty. */
  private entry: string | null = null;

  /** The highest layer in the graph. -1 while the index is empty. */
  private maxLevel = -1;

  /** Vector length, fixed by the first insert. */
  private dims = 0;

  /** The most neighbours a node keeps on one layer. */
  readonly M: number;

  /** How many candidates to track while inserting. A larger value builds a better graph but is slower. */
  readonly efConstruction: number;

  /**
   * Sets up an empty index. `M` is at least 2, and `efConstruction` is at least `M`.
   * `random` returns a number from 0 up to 1. A test can pass a fixed one to get the same graph every time.
   */
  constructor(opts: { M?: number; efConstruction?: number; random?: () => number } = {}) {
    this.M = Math.max(2, opts.M ?? 12);
    this.efConstruction = Math.max(this.M, opts.efConstruction ?? 80);
    this.random = opts.random ?? Math.random;
  }

  /** Picks each new node's layer. */
  private random: () => number;

  /** How many vectors the index holds. */
  get size(): number {
    return this.nodes.size;
  }

  /** Returns the highest layer of a node, or 0 if the id is unknown. */
  level({ id }: { id: string }): number {
    return this.nodes.get(id)?.level ?? 0;
  }

  /**
   * Rejects a vector the index cannot use.
   * Throws if the vector is empty, has a non-finite number, is all zeros, or differs in length from the first one.
   * Cosine similarity of an all-zero vector is undefined, so it cannot be ranked.
   */
  private validate({ vector }: { vector: number[] }): void {
    if (!vector.length || vector.some((v) => !Number.isFinite(v)) || !vector.some((v) => v !== 0))
      throw new Error('ANN requires finite nonzero vectors');
    if (this.dims && vector.length !== this.dims) throw new Error('ANN vector dimension mismatch');
  }

  /** Measures how close a stored vector is to the query. The result is held between -1 and 1. */
  private score({ query, id }: { query: number[]; id: string }): AnnMatch {
    return {
      id,
      similarity: Math.max(
        -1,
        Math.min(1, cosineSimilarity({ a: query, b: this.nodes.get(id)!.vector })),
      ),
    };
  }

  /**
   * Walks one layer of the graph and returns the closest `ef` vectors it finds, closest first.
   * It starts at `starts` and always expands the closest unvisited candidate next.
   * It stops when no remaining candidate beats the worst match kept.
   * Without the stop, the walk would visit the whole layer.
   */
  private searchLayer({ query, starts, ef, layer }: SearchLayerParams): AnnMatch[] {
    const seen = new Set(starts);
    const best = starts
      .map((id) => this.score({ query, id }))
      .sort((a, b) => b.similarity - a.similarity);
    const candidates = [...best];
    while (candidates.length) {
      candidates.sort((a, b) => b.similarity - a.similarity);
      const current = candidates.shift()!;
      if (best.length >= ef && current.similarity < best[best.length - 1].similarity) break;
      for (const id of this.nodes.get(current.id)!.links[layer] ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const next = this.score({ query, id });
        if (best.length < ef || next.similarity > best[best.length - 1].similarity) {
          candidates.push(next);
          best.push(next);
          best.sort((a, b) => b.similarity - a.similarity);
          if (best.length > ef) best.pop();
        }
      }
    }
    return best;
  }

  /**
   * Cuts a node's links on one layer down to at most `M`, and removes the dropped links from both ends.
   * A neighbour is kept first if it is closer to the node than to any neighbour already kept.
   * This spreads the links in different directions. Any slots left are filled with the closest of the rest.
   * Without it, a node would link only to one tight clump and searches could not leave it.
   */
  private prune({ node, layer }: { node: Node; layer: number }): void {
    const ranked = [...node.links[layer]]
      .map((id) => this.score({ query: node.vector, id }))
      .sort((a, b) => b.similarity - a.similarity);
    const selected: AnnMatch[] = [];
    const deferred: AnnMatch[] = [];
    for (const candidate of ranked) {
      if (
        selected.every(
          (n) =>
            cosineSimilarity({
              a: this.nodes.get(candidate.id)!.vector,
              b: this.nodes.get(n.id)!.vector,
            }) < candidate.similarity,
        )
      )
        selected.push(candidate);
      else deferred.push(candidate);
      if (selected.length === this.M) break;
    }
    for (const candidate of deferred) {
      if (selected.length < this.M) selected.push(candidate);
    }
    const kept = new Set(selected.map((n) => n.id));
    for (const id of node.links[layer])
      if (!kept.has(id)) this.nodes.get(id)!.links[layer]?.delete(node.id);
    node.links[layer] = kept;
  }

  /**
   * Adds a vector to the index. Changes the graph.
   * Throws if the vector is invalid or the id is already in the index.
   * The index stores a copy, so later changes to the caller's array do not alter the graph.
   * Each node gets a random top layer. Few nodes reach the upper layers, so the upper layers stay sparse and fast to cross.
   */
  insert({ id, vector }: { id: string; vector: number[] }): void {
    this.validate({ vector });
    if (this.nodes.has(id)) throw new Error('Duplicate ANN id');
    this.dims = vector.length;
    /** The layer is capped at 24. The `Math.max` keeps the logarithm away from zero. */
    const level = Math.min(
      24,
      Math.floor(-Math.log(Math.max(Number.MIN_VALUE, this.random())) / Math.log(this.M)),
    );
    const node: Node = {
      id,
      vector: [...vector],
      level,
      links: Array.from({ length: level + 1 }, () => new Set<string>()),
    };
    if (!this.entry) {
      this.nodes.set(id, node);
      this.entry = id;
      this.maxLevel = level;
      return;
    }
    let ep = this.entry;
    for (let l = this.maxLevel; l > level; l--)
      ep = this.searchLayer({ query: vector, starts: [ep], ef: 1, layer: l })[0].id;
    this.nodes.set(id, node);
    for (let l = Math.min(level, this.maxLevel); l >= 0; l--) {
      const neighbors = this.searchLayer({
        query: vector,
        starts: [ep],
        ef: this.efConstruction,
        layer: l,
      });
      for (const n of neighbors.slice(0, this.M)) {
        node.links[l].add(n.id);
        this.nodes.get(n.id)!.links[l].add(id);
      }
      this.prune({ node, layer: l });
      for (const n of [...node.links[l]]) this.prune({ node: this.nodes.get(n)!, layer: l });
      ep = neighbors[0]?.id ?? ep;
    }
    if (level > this.maxLevel) {
      this.entry = id;
      this.maxLevel = level;
    }
  }

  /**
   * Finds the stored vectors closest to a query, closest first.
   * Returns an empty list if the index is empty. Throws if the vector is invalid.
   * It crosses the upper layers one step at a time, then searches layer 0 with a wider beam.
   * The result is approximate. A very close vector can be missed.
   */
  search({ vector, k = 1, efSearch = 64 }: SearchParams): AnnMatch[] {
    this.validate({ vector });
    if (!this.entry) return [];
    let ep = this.entry;
    for (let l = this.maxLevel; l > 0; l--)
      ep = this.searchLayer({ query: vector, starts: [ep], ef: 1, layer: l })[0].id;
    return this.searchLayer({
      query: vector,
      starts: [ep],
      ef: Math.max(k, efSearch),
      layer: 0,
    }).slice(0, k);
  }
}
