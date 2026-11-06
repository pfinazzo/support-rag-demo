/**
 * Why this file exists: when a user asks something close to an earlier question,
 * we reuse the saved answer. That skips the search and the LLM call.
 * Each combination of roles and settings gets its own HNSW index. A question is
 * only compared with answers made for the same roles and settings.
 * Without that, one user could be shown an answer built from documents their
 * roles cannot read.
 * The semantic cache lives in memory. A restart empties it. When it is full, the
 * oldest answer is dropped first.
 */
import type { CitationReport } from '../verification/citation-checker.js';
import { performance } from 'node:perf_hooks';
import { HnswAnnIndex } from '../retrieval/hnsw-index.js';
import { embedText, cosineSimilarity } from '../retrieval/embeddings.js';
import type { ChatStepTelemetry, SearchTelemetry } from '../types.js';

/** Everything saved for one answer, so a later hit can show the same stages again. */
export interface CachedResponse {
  citationCheck?: CitationReport;
  answer: string;
  fallback: boolean;
  model?: string | null;
  usedMock?: boolean;
  llmProvider?: string;
  retrieval: SearchTelemetry;
  chatStep: ChatStepTelemetry;
}

/** One saved answer in the semantic cache. */
interface Entry {
  id: string;
  /** The question that produced this answer. */
  query: string;
  /** The embedding of `query`. New questions are compared with it. */
  vector: number[];
  answer: string;
  sources: ChatStepTelemetry['contextPassedToLlm'];
  /** The role choice the user made. Shown on the page only. */
  rolePreset: string;
  /** The caller's roles, sorted and joined with commas. */
  roleKey: string;
  /** The roles plus the settings that shaped the answer. Only the same scope can reuse it. */
  scopeKey: string;
  /** How many later questions reused this answer. */
  hitCount: number;
  /** ISO 8601 time the answer was saved. */
  createdAt: string;
  /** ISO 8601 time of the latest reuse. Null if never reused. */
  lastHitAt: string | null;
  response: CachedResponse;
}

/**
 * Checks the minimum similarity for a cache hit and returns it.
 * Throws unless the value is a finite number from 0.10 to 0.99.
 */
export function validateThreshold({ value }: { value: unknown }): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.1 || value > 0.99)
    throw new Error('threshold must be a finite number between 0.10 and 0.99');
  return value;
}

type LookupParams = {
  query: string;
  roles: string[];
  /** The settings that shaped the answer. Answers made under other settings are not compared. */
  scope: string;
  /** Minimum similarity for this lookup only. If absent: the cache's own threshold. */
  threshold?: unknown;
  /** True to skip the semantic cache. The lookup then never hits and is not counted as a miss. */
  bypass?: boolean;
};

type StoreParams = {
  lookup: Awaited<ReturnType<SemanticCache['lookup']>>;
  query: string;
  rolePreset: string;
  response: CachedResponse;
};

/** The semantic cache. One shared instance lives in `runtime.ts`. */
export class SemanticCache {
  /** Minimum similarity, from 0 to 1, for a new question to reuse a saved answer. */
  threshold = 0.85;

  /** When the cache is full, the oldest answer is dropped. */
  readonly maxEntries = 128;

  /** Saved answers, oldest first. */
  private entries: Entry[] = [];

  /** One HNSW index per scope key. */
  private graphs = new Map<string, HnswAnnIndex>();

  /** Counts up to give each saved answer its id. */
  private sequence = 0;

  private hits = 0;

  private misses = 0;

  /** Goes up on every clear. A lookup from before the clear cannot store its answer afterward. */
  private revision = 0;

  /** The newest question vector in each scope. `state` uses it to show how close each saved answer is. */
  private latest = new Map<string, number[]>();

  /**
   * Empties the semantic cache and its counters.
   * Called after documents are re-indexed, because saved answers may then be out of date.
   */
  clear(): void {
    this.entries = [];
    this.graphs.clear();
    this.latest.clear();
    this.hits = 0;
    this.misses = 0;
    this.sequence = 0;
    this.revision++;
  }

  /** Sets the cache's minimum similarity. Throws if the value is out of range. */
  setThreshold({ value }: { value: unknown }): void {
    this.threshold = validateThreshold({ value });
  }

  /**
   * Describes the semantic cache for the page: settings, counts and saved answers.
   * If `roleKey` is given: lists only the answers saved for those roles.
   * Each answer shows its similarity to the latest question in its scope, or null if there is none.
   */
  state({ roleKey }: { roleKey?: string } = {}) {
    const visible = this.entries.filter((e) => !roleKey || e.roleKey === roleKey);
    return {
      threshold: this.threshold,
      maxEntries: this.maxEntries,
      size: visible.length,
      stats: {
        hits: this.hits,
        misses: this.misses,
        hitRate: this.hits / Math.max(1, this.hits + this.misses),
      },
      entries: visible.map((e) => ({
        id: e.id,
        query: e.query,
        answer: e.answer,
        sources: e.sources,
        rolePreset: e.rolePreset,
        roleKey: e.roleKey,
        hitCount: e.hitCount,
        createdAt: e.createdAt,
        lastHitAt: e.lastHitAt,
        similarity: this.latest.has(e.scopeKey)
          ? cosineSimilarity({ a: e.vector, b: this.latest.get(e.scopeKey)! })
          : null,
        hnswLevel: this.graphs.get(e.scopeKey)?.level({ id: e.id }) ?? 0,
        embeddingSummary: {
          first: e.vector.slice(0, 8),
          barcode: e.vector.slice(0, 32),
          dims: e.vector.length,
          norm: Math.hypot(...e.vector),
        },
      })),
    };
  }

  /**
   * Finds a saved answer close enough to this question.
   * Embeds the question, which calls OpenAI unless MOCK_AI is on.
   * Counts a hit or a miss and records the hit on the answer.
   * Returns the lookup details that `store` needs, and the answer if it hit.
   * If `bypass` is set: skips the embedding and the search, and the lookup never hits.
   * A hit below a similarity of 0.78 is flagged as `degradedRisk`, because the match is weak.
   */
  async lookup({ query, roles, scope, threshold, bypass = false }: LookupParams) {
    const start = performance.now();
    const activeThreshold =
      threshold === undefined ? this.threshold : validateThreshold({ value: threshold });
    const revision = this.revision;
    const roleKey = [...new Set(roles)].sort().join(',');
    const scopeKey = JSON.stringify([roleKey, scope]);
    const vector = bypass ? [] : await embedText({ text: query });
    if (!bypass) this.latest.set(scopeKey, vector);
    /** HNSW rejects an all-zero vector, so a bypass or a blank embedding skips the search. */
    const nearest = vector.some((v) => v !== 0)
      ? this.graphs.get(scopeKey)?.search({ vector })[0]
      : undefined;
    const entry = nearest && this.entries.find((e) => e.id === nearest.id);
    const hit = Boolean(entry && nearest && nearest.similarity >= activeThreshold);
    if (hit && entry) {
      this.hits++;
      entry.hitCount++;
      entry.lastHitAt = new Date().toISOString();
    } else if (!bypass) this.misses++;
    const telemetry = {
      hit,
      bypassed: bypass,
      similarity: nearest?.similarity ?? null,
      threshold: activeThreshold,
      matchedEntryId: entry?.id ?? null,
      matchedQuery: entry?.query ?? null,
      latencyMs: performance.now() - start,
      /** True for a hit under 0.78 similarity. */
      degradedRisk: hit && (nearest?.similarity ?? 1) < 0.78,
      retrievalSkipped: hit,
      llmSkipped: hit,
    };
    return { vector, roleKey, scopeKey, revision, entry: hit ? entry : undefined, telemetry };
  }

  /**
   * Saves an answer so a later, similar question can reuse it.
   * Returns the new entry id, or null if nothing was saved.
   * Nothing is saved for a fallback message or a blank answer.
   * Nothing is saved if the cache was cleared after the lookup, because the answer may use old documents.
   * When the cache is full: drops the oldest answer and rebuilds every HNSW index, because the index has no delete.
   */
  store({ lookup, query, rolePreset, response }: StoreParams): string | null {
    if (response.fallback || !response.answer.trim() || lookup.revision !== this.revision)
      return null;
    const entry: Entry = {
      id: String(++this.sequence),
      query,
      vector: lookup.vector,
      answer: response.answer,
      sources: response.chatStep.contextPassedToLlm,
      rolePreset,
      roleKey: lookup.roleKey,
      scopeKey: lookup.scopeKey,
      hitCount: 0,
      createdAt: new Date().toISOString(),
      lastHitAt: null,
      /** A copy, so later changes to `response` cannot alter the saved answer. */
      response: structuredClone(response),
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
      this.graphs.clear();
      for (const e of this.entries)
        this.graph({ key: e.scopeKey }).insert({ id: e.id, vector: e.vector });
    } else this.graph({ key: entry.scopeKey }).insert({ id: entry.id, vector: entry.vector });
    return entry.id;
  }

  /** Returns the HNSW index for a scope, creating it on first use. */
  private graph({ key }: { key: string }): HnswAnnIndex {
    if (!this.graphs.has(key)) this.graphs.set(key, new HnswAnnIndex());
    return this.graphs.get(key)!;
  }
}
