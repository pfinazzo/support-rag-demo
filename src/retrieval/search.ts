/**
 * Why this file exists: it finds the document sections that answer a question.
 * It runs hybrid search (BM25 plus vector search), merges the two rankings with
 * reciprocal rank fusion, and re-orders the best with a cross-encoder reranker.
 * It also applies the RBAC role filter. Without this file, the LLM would get
 * weaker passages, or passages the caller is not allowed to read.
 */
import { buildBm25Index } from './bm25.js';
import { embedText, cosineSimilarity } from './embeddings.js';
import {
  rerankShortlist,
  DEFAULT_FINAL_TOP_K,
  DEFAULT_SHORTLIST_TOP_K,
  DEFAULT_MIN_RERANK_SCORE,
  type RerankerBackend,
} from '../ranking/reranker.js';
import { envNumber } from '../env.js';
import {
  buildPermissionReport,
  ensureChunkRoles,
  loadPineconeMock,
  pineconeConfig,
  queryPinecone,
  queryPineconeLocalSimulator,
} from './pinecone-store.js';
import { ALL_ROLES, chunkAccessibleToRoles } from './roles.js';
import type {
  DocChunk,
  Bm25RankedItem,
  VectorRankedItem,
  RrfShortlistItem,
  SearchTelemetry,
} from '../types.js';

/**
 * The constant k in the reciprocal rank fusion score 1 / (rank + k).
 * A larger k makes the gap between a first and a second rank smaller.
 */
export const RRF_K = 30;

/**
 * Lowest vector similarity that counts as a match, from 0 to 1.
 * A section below this is kept only if BM25 also found it.
 */
export const DEFAULT_MIN_VECTOR_SIMILARITY = 0.25;

/**
 * Settings for one searcher.
 * Each one left unset falls back to its environment variable, then to a default.
 */
export interface SearcherOptions {
  /** Lowest vector similarity that counts as a match. */
  minVectorSimilarity?: number;
  /** The k in the reciprocal rank fusion formula. */
  rrfK?: number;
  /** How many fused sections go to the cross-encoder reranker. */
  shortlistTopK?: number;
  /** How many sections the LLM gets after reranking. */
  finalTopK?: number;
  /** Lowest cross-encoder score a section may have and still reach the LLM. */
  minRerankScore?: number;
}

/** Settings for one search call. */
export interface SearchCallOptions {
  /** How many sections to return. Overrides the searcher's `finalTopK`. */
  topK?: number;
  /** Roles of the caller. If empty or missing: every role. */
  roles?: string[];
  /** The query already embedded. If missing: this file embeds the query. */
  queryVector?: number[];
}

export type SearchParams = SearchCallOptions & { query: string };

/** A search function plus the settings it was built with. */
export interface Searcher {
  search: ({ query, topK, roles, queryVector }: SearchParams) => Promise<SearchTelemetry>;
  chunks: DocChunk[];
  minVectorSimilarity: number;
  rrfK: number;
  shortlistTopK: number;
  finalTopK: number;
  minRerankScore: number;
}

/**
 * Builds a searcher over a list of document sections.
 * Calls `ensureChunkRoles`, so a section with no roles gets them.
 * Each setting comes from `opts`, then from its environment variable
 * (MIN_VECTOR_SIMILARITY, SHORTLIST_TOP_K, FINAL_TOP_K, MIN_RERANK_SCORE), then from a default.
 */
export function createSearcher({
  rawChunks,
  opts = {},
}: {
  rawChunks: DocChunk[];
  opts?: SearcherOptions;
}): Searcher {
  const chunks = ensureChunkRoles({ chunks: rawChunks });
  const minVectorSimilarity =
    opts.minVectorSimilarity ??
    envNumber({ name: 'MIN_VECTOR_SIMILARITY', fallback: DEFAULT_MIN_VECTOR_SIMILARITY });
  const rrfK = opts.rrfK ?? RRF_K;
  const shortlistTopK =
    opts.shortlistTopK ?? envNumber({ name: 'SHORTLIST_TOP_K', fallback: DEFAULT_SHORTLIST_TOP_K });
  const finalTopK =
    opts.finalTopK ?? envNumber({ name: 'FINAL_TOP_K', fallback: DEFAULT_FINAL_TOP_K });
  const minRerankScore =
    opts.minRerankScore ??
    envNumber({ name: 'MIN_RERANK_SCORE', fallback: DEFAULT_MIN_RERANK_SCORE });

  /**
   * BM25 index over every section, including ones the caller may not read.
   * It is used only to report what the role filter hid.
   * The index for ranking is built per query, over readable sections only.
   */
  const bm25All = buildBm25Index({ documents: chunks.map((c) => c.prefixedText) });

  /**
   * Runs one search and returns the results plus a record of every step.
   * Embeds the query unless `queryVector` is given. Calls Pinecone when a key is set.
   *
   * If the query is empty or there are no sections: returns an empty result.
   * Otherwise the steps are:
   * 1. The RBAC role filter removes sections the caller may not read, before any scoring.
   * 2. BM25 ranks the readable sections.
   * 3. Vector search ranks them by similarity.
   * 4. Reciprocal rank fusion merges both rankings into a shortlist.
   * 5. The cross-encoder reranker re-orders the shortlist.
   * 6. Sections below the minimum rerank score are dropped.
   * `relevant` is false if nothing is left.
   *
   * If the Pinecone cloud query fails: logs a warning and scores vectors in memory.
   * Without that fallback, one Pinecone outage would fail every search.
   */
  async function search({
    query,
    topK,
    roles,
    queryVector,
  }: SearchParams): Promise<SearchTelemetry> {
    const q = String(query || '').trim();
    const effectiveFinalTopK = topK || finalTopK;
    const callerRoles = roles && roles.length ? roles : [...ALL_ROLES];

    if (!q || chunks.length === 0) {
      return emptyResult({
        q,
        finalTopK: effectiveFinalTopK,
        shortlistTopK,
        rrfK,
        minVectorSimilarity,
        minRerankScore,
        callerRoles,
      });
    }

    /** BM25 scores over all sections, kept for the report of hidden sections. */
    const bm25AllHits = bm25All.search({ query: q });
    const bm25ByChunkId = new Map<string, number>();
    bm25AllHits.forEach((hit) => {
      bm25ByChunkId.set(chunks[hit.index].id, hit.score);
    });

    const queryVec = queryVector ? queryVector : await embedText({ text: q });

    /**
     * The RBAC role filter, applied before any scoring.
     * Without this, text the caller may not read could reach the LLM.
     */
    const accessible = chunks.filter((c) =>
      chunkAccessibleToRoles({ chunkRoles: c.roles, callerRoles }),
    );
    const accessibleIndexes = new Set(accessible.map((c) => chunks.indexOf(c)));

    /** BM25 over readable sections only. */
    const bm25 = buildBm25Index({ documents: accessible.map((c) => c.prefixedText) });
    const bm25HitsRaw = bm25.search({ query: q });
    /** BM25 numbers its documents from zero. This maps them back to positions in `chunks`. */
    const bm25Hits = bm25HitsRaw.map((hit) => ({
      index: chunks.indexOf(accessible[hit.index]),
      score: hit.score,
    }));

    const bm25ByIndex = new Map<number, { score: number; rank: number }>();
    bm25Hits.forEach((hit, i) => {
      bm25ByIndex.set(hit.index, { score: hit.score, rank: i + 1 });
    });
    const maxBm25Score = bm25Hits.length ? bm25Hits[0].score : 0;

    const bm25List: Bm25RankedItem[] = bm25Hits.map((hit, i) => {
      const rank = i + 1;
      const chunk = chunks[hit.index];
      const rrfDenom = rank + rrfK;
      const rrfTerm = 1 / rrfDenom;
      return {
        id: chunk.id,
        headingPath: chunk.headingPath,
        sourceFile: chunk.sourceFile,
        bm25Score: hit.score,
        bm25Rank: rank,
        rrfDenom,
        rrfTerm,
        formula: `1 / (${rank} + ${rrfK}) = ${rrfTerm.toFixed(6)}`,
        roles: chunk.roles,
      };
    });

    /**
     * Vector search. Pinecone cloud if a key is set. Otherwise the local simulator
     * or an in-memory comparison.
     */
    const cfg = pineconeConfig();
    /** How many vector hits appear in the report: at least 12, or twice the shortlist size. */
    const VECTOR_LIST_CAP = Math.max(shortlistTopK * 2, 12);
    let vectorScored: Array<{ index: number; similarity: number }> = [];

    if (cfg.hasKey) {
      try {
        const { hits } = await queryPinecone({
          queryVector: queryVec,
          callerRoles,
          topK: Math.max(VECTOR_LIST_CAP, shortlistTopK * 3),
        });
        const byId = new Map(chunks.map((c, i) => [c.id, i]));
        vectorScored = hits
          .map((h) => {
            const index = byId.get(h.id);
            if (index === undefined) return null;
            return { index, similarity: h.score };
          })
          .filter((x): x is { index: number; similarity: number } => x !== null);
      } catch (err) {
        console.warn(
          'Pinecone cloud query failed; falling back to local simulator:',
          (err as Error).message,
        );
        vectorScored = scoreLocalVectors({ chunks, accessibleIndexes, queryVec });
      }
    } else {
      /**
       * No Pinecone key: use the saved simulator records, but only if no section has a
       * context header. Otherwise compare vectors in memory.
       */
      const records = loadPineconeMock();
      if (records.length > 0 && !chunks.some((c) => c.contextHeader)) {
        const { hits } = queryPineconeLocalSimulator({
          records,
          queryVector: queryVec,
          callerRoles,
          topK: Math.max(VECTOR_LIST_CAP, shortlistTopK * 3),
        });
        const byId = new Map(chunks.map((c, i) => [c.id, i]));
        vectorScored = hits
          .map((h) => {
            const index = byId.get(h.id);
            if (index === undefined) return null;
            return { index, similarity: h.score };
          })
          .filter((x): x is { index: number; similarity: number } => x !== null);
      } else {
        vectorScored = scoreLocalVectors({ chunks, accessibleIndexes, queryVec });
      }
    }

    vectorScored.sort((a, b) => b.similarity - a.similarity);
    const vectorByIndex = new Map<number, { similarity: number; rank: number }>();
    vectorScored.forEach((hit, i) => {
      vectorByIndex.set(hit.index, { similarity: hit.similarity, rank: i + 1 });
    });
    const maxVectorSimilarity = vectorScored.length ? vectorScored[0].similarity : 0;

    const vectorList: VectorRankedItem[] = vectorScored.slice(0, VECTOR_LIST_CAP).map((hit, i) => {
      const rank = i + 1;
      const chunk = chunks[hit.index];
      const rrfDenom = rank + rrfK;
      const rrfTerm = 1 / rrfDenom;
      return {
        id: chunk.id,
        headingPath: chunk.headingPath,
        sourceFile: chunk.sourceFile,
        vectorSimilarity: hit.similarity,
        vectorRank: rank,
        rrfDenom,
        rrfTerm,
        formula: `1 / (${rank} + ${rrfK}) = ${rrfTerm.toFixed(6)}`,
        roles: chunk.roles,
      };
    });

    /**
     * Reciprocal rank fusion. A section's score is the sum of 1 / (rank + k)
     * over each ranking that holds it. Higher is better.
     * All BM25 hits are candidates. Vector hits are candidates only above the similarity floor.
     */
    const candidateIndexes = new Set<number>();
    for (const hit of bm25Hits) candidateIndexes.add(hit.index);
    for (const hit of vectorScored) {
      if (hit.similarity >= minVectorSimilarity) candidateIndexes.add(hit.index);
    }

    const fused: RrfShortlistItem[] = [];
    for (const index of candidateIndexes) {
      /** A second role check, in case an earlier step let a hidden section through. */
      if (!accessibleIndexes.has(index)) continue;
      const bm = bm25ByIndex.get(index);
      const vec = vectorByIndex.get(index);
      const bm25Rank = bm ? bm.rank : null;
      const vectorRank = vec ? vec.rank : null;
      const bm25Score = bm ? bm.score : 0;
      const vectorSimilarity = vec ? vec.similarity : 0;
      const bm25RrfScore = bm25Rank ? 1 / (bm25Rank + rrfK) : 0;
      const vectorRrfScore = vectorRank ? 1 / (vectorRank + rrfK) : 0;
      const rrfScore = bm25RrfScore + vectorRrfScore;
      const isRelevant = bm25Score > 0 || vectorSimilarity >= minVectorSimilarity;
      if (!isRelevant) continue;

      const chunk = chunks[index];
      const bmPart = bm25Rank ? `1/(${bm25Rank}+${rrfK})=${bm25RrfScore.toFixed(4)}` : '0';
      const vecPart = vectorRank ? `1/(${vectorRank}+${rrfK})=${vectorRrfScore.toFixed(4)}` : '0';
      fused.push({
        id: chunk.id,
        sourceFile: chunk.sourceFile,
        headingPath: chunk.headingPath,
        prefixedText: chunk.prefixedText,
        contextHeader: chunk.contextHeader,
        contextualizedContent: chunk.contextualizedContent,
        bm25Score,
        bm25Rank,
        bm25RrfScore,
        vectorSimilarity,
        vectorRank,
        vectorRrfScore,
        rrfScore,
        rrfRank: 0,
        isRelevant,
        formula: `${bmPart} + ${vecPart} = ${rrfScore.toFixed(4)}`,
        roles: chunk.roles,
      });
    }

    fused.sort((a, b) => b.rrfScore - a.rrfScore);
    const rrfShortlist = fused.slice(0, shortlistTopK).map((item, i) => ({
      ...item,
      rrfRank: i + 1,
    }));

    /** The cross-encoder reranker scores each shortlisted section against the query. */
    const {
      items: reranked,
      backend,
      maxRerankScore,
    } = await rerankShortlist({
      query: q,
      shortlist: rrfShortlist,
      opts: {
        minRerankScore,
        finalTopK: effectiveFinalTopK,
      },
    });

    const results = reranked.filter((r) => r.keptForLlm);
    const relevant = results.length > 0;

    /**
     * Lists up to 5 sections the caller could not read that still matched the query.
     * A match is a cosine similarity of 0.2 or more, or any BM25 score.
     */
    const permissionReport = buildPermissionReport({
      allChunks: chunks,
      callerRoles,
      queryVector: queryVec,
      bm25ByChunkId,
      cosineFloor: 0.2,
      maxExcluded: 5,
    });

    return {
      query: q,
      topK: effectiveFinalTopK,
      shortlistTopK,
      finalTopK: effectiveFinalTopK,
      rrfK,
      minVectorSimilarity,
      minRerankScore,
      relevant,
      maxBm25Score,
      maxVectorSimilarity,
      maxRerankScore,
      rerankerBackend: backend as RerankerBackend,
      results,
      bm25List,
      vectorList,
      rrfShortlist,
      fusedResults: rrfShortlist,
      reranked,
      permissionReport,
      callerRoles,
    };
  }

  return {
    search,
    chunks,
    minVectorSimilarity,
    rrfK,
    shortlistTopK,
    finalTopK,
    minRerankScore,
  };
}

type ScoreLocalVectorsParams = {
  chunks: DocChunk[];
  accessibleIndexes: Set<number>;
  queryVec: number[];
};

/**
 * Scores readable sections against the query by cosine similarity, in memory.
 * Sections the caller may not read are left out. The result is not sorted.
 */
function scoreLocalVectors({
  chunks,
  accessibleIndexes,
  queryVec,
}: ScoreLocalVectorsParams): Array<{ index: number; similarity: number }> {
  return chunks
    .map((chunk, index) => ({
      index,
      similarity: accessibleIndexes.has(index)
        ? cosineSimilarity({ a: queryVec, b: chunk.embedding })
        : -1,
    }))
    .filter((x) => x.similarity >= 0);
}

type EmptyResultParams = {
  q: string;
  finalTopK: number;
  shortlistTopK: number;
  rrfK: number;
  minVectorSimilarity: number;
  minRerankScore: number;
  callerRoles: string[];
};

/**
 * Builds the result for an empty query or an empty corpus.
 * Every list is empty and `relevant` is false.
 */
function emptyResult({
  q,
  finalTopK,
  shortlistTopK,
  rrfK,
  minVectorSimilarity,
  minRerankScore,
  callerRoles,
}: EmptyResultParams): SearchTelemetry {
  const cfg = pineconeConfig();
  return {
    query: q,
    topK: finalTopK,
    shortlistTopK,
    finalTopK,
    rrfK,
    minVectorSimilarity,
    minRerankScore,
    relevant: false,
    maxBm25Score: 0,
    maxVectorSimilarity: 0,
    maxRerankScore: 0,
    rerankerBackend: 'mock',
    results: [],
    bm25List: [],
    vectorList: [],
    rrfShortlist: [],
    fusedResults: [],
    reranked: [],
    callerRoles,
    permissionReport: {
      backend: cfg.hasKey ? 'pinecone-cloud' : 'pinecone-local-simulator',
      indexName: cfg.indexName,
      filter: { roles: { $in: [...callerRoles] } },
      callerRoles: [...callerRoles],
      accessibleChunkCount: 0,
      totalChunkCount: 0,
      excludedChunks: [],
    },
  };
}
