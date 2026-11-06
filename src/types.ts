/**
 * Why this file exists: the shapes that pass between pipeline steps live here
 * and nowhere else. These are document chunks, ranked search results, search
 * telemetry, the saved index and the Pinecone records. Each step imports the
 * same definition. If two files kept their own copies, one could change a field
 * and the other would silently read the old one.
 */

/** A role a caller can hold. A chunk lists the roles that may read it. */
export type RoleName = 'all' | 'billing' | 'engineering' | 'admin';

/** A named group of roles. `roles.ts` expands each name into the roles it grants. */
export type RolePreset = 'all' | 'billing' | 'engineering' | 'admin';

/** One section of a source document, with its embedding. This is what search ranks. */
export interface DocChunk {
  id: string;
  sourceFile: string;
  /** The headings above this section, joined into one path. */
  headingPath: string;
  /** The section text exactly as written in the document. */
  rawContent: string;
  /** The text shown to the LLM, with the topic added in front. */
  prefixedText: string;
  /** SHA-256 of the text that was embedded. A chunk with the same hash is not embedded again. */
  contentHash?: string;
  /** One sentence naming the document and topic this section belongs to. */
  contextHeader?: string;
  /** The context header followed by the raw content. This is the text that gets embedded. */
  contextualizedContent?: string;
  /** Embedding vector. Its length must match the vectors the search compares it with. */
  embedding: number[];
  /** Role-Based Access Control (RBAC) roles that may see this chunk. */
  roles: string[];
}

/** A chunk before its embedding and id exist. The chunker produces these. */
export interface ChunkDraft {
  sourceFile: string;
  headingPath: string;
  rawContent: string;
  prefixedText: string;
  contentHash?: string;
  contextHeader?: string;
  contextualizedContent?: string;
  roles: string[];
}

/** One Markdown heading found in a document. */
export interface HeadingInfo {
  /** Heading depth. One `#` is level 1. */
  level: number;
  title: string;
  /** Line number in the document. */
  line: number;
  /** The leading `#` characters as written. */
  marker: string;
}

/** One chunk in the BM25 ranking, with the numbers that feed reciprocal rank fusion. */
export interface Bm25RankedItem {
  id: string;
  headingPath: string;
  sourceFile: string;
  bm25Score: number;
  /** Position in the BM25 ranking. The best chunk is 1. */
  bm25Rank: number;
  /** Rank plus the fusion constant. */
  rrfDenom: number;
  /** This chunk's share of the fused score: 1 divided by `rrfDenom`. */
  rrfTerm: number;
  /** The arithmetic written out as text, for the page to show. */
  formula: string;
  roles?: string[];
}

/** One chunk in the vector search ranking, with the numbers that feed reciprocal rank fusion. */
export interface VectorRankedItem {
  id: string;
  headingPath: string;
  sourceFile: string;
  /** Cosine similarity between the question and the chunk, from -1 to 1. */
  vectorSimilarity: number;
  /** Position in the vector ranking. The best chunk is 1. */
  vectorRank: number;
  /** Rank plus the fusion constant. */
  rrfDenom: number;
  /** This chunk's share of the fused score: 1 divided by `rrfDenom`. */
  rrfTerm: number;
  /** The arithmetic written out as text, for the page to show. */
  formula: string;
  roles?: string[];
}

/** A chunk on the reciprocal rank fusion shortlist, before the cross-encoder reranker sees it. */
export interface RrfShortlistItem {
  id: string;
  sourceFile: string;
  headingPath: string;
  prefixedText: string;
  contentHash?: string;
  contextHeader?: string;
  contextualizedContent?: string;
  bm25Score: number;
  /** Null if BM25 did not return this chunk. */
  bm25Rank: number | null;
  bm25RrfScore: number;
  vectorSimilarity: number;
  /** Null if vector search did not return this chunk. */
  vectorRank: number | null;
  vectorRrfScore: number;
  /** BM25 share plus vector share. Higher ranks first. */
  rrfScore: number;
  /** Position after fusion. The best chunk is 1. */
  rrfRank: number;
  /** True if BM25 matched a word or the vector similarity cleared its minimum. */
  isRelevant: boolean;
  /** The fusion arithmetic written out as text, for the page to show. */
  formula: string;
  roles?: string[];
}

/** A shortlist chunk after the cross-encoder reranker scored it. */
export interface RerankedItem extends RrfShortlistItem {
  rerankScore: number;
  /** Position after reranking. The best chunk is 1. */
  rerankRank: number;
  /** Fusion rank minus rerank rank. Positive means the reranker moved this chunk up. */
  rankDelta: number;
  /** True if the chunk scored above the floor and ranked high enough to reach the LLM. */
  keptForLlm: boolean;
  /** The reranker's score written out as text, for the page to show. */
  rerankFormula: string;
}

/** One chunk handed to the LLM as evidence. */
export interface LlmContextChunk {
  /** Position of this chunk in the context list, counting from 1. */
  contextId: number;
  id: string;
  sourceFile: string;
  headingPath: string;
  prefixedText: string;
  contentHash?: string;
  contextHeader?: string;
  contextualizedContent?: string;
  rrfScore: number;
  rrfRank: number;
  rerankScore: number;
  rerankRank: number;
  rankDelta: number;
  /** Position in the list the LLM receives. */
  finalRank: number;
  roles?: string[];
}

/** Which backend answers the question. `mock` makes no model call. */
export type LlmProviderName = 'local-claude' | 'anthropic-api' | 'openai' | 'mock';

/** What the answer step reports to the page. */
export interface ChatStepTelemetry {
  contextPassedToLlm: LlmContextChunk[];
  /** True if the fixed fallback message was sent instead of a model answer. */
  usedFallback: boolean;
  /** Why the fallback was sent. Null if it was not. */
  fallbackReason: string | null;
  /** The model that answered. Null if no model was called. */
  model: string | null;
  usedMock?: boolean;
  llmProvider?: LlmProviderName;
  answer: string;
}

/** A chunk that the caller's roles hid from this search. */
export interface ExcludedChunkReport {
  id: string;
  sourceFile: string;
  headingPath: string;
  chunkRoles: string[];
  cosineSim: number;
  bm25Score: number;
}

/** Shows which chunks the caller's roles allowed and which they hid. */
export interface PermissionReport {
  backend: 'pinecone-cloud' | 'pinecone-local-simulator';
  indexName: string;
  /** The RBAC role filter sent with the Pinecone query. */
  filter: { roles: { $in: string[] } };
  callerRoles: string[];
  accessibleChunkCount: number;
  totalChunkCount: number;
  excludedChunks: ExcludedChunkReport[];
}

/** Everything one search did, so the page can show each stage. */
export interface SearchTelemetry {
  query: string;
  /** How many chunks each ranking returns. */
  topK: number;
  /** How many chunks stay on the fusion shortlist. */
  shortlistTopK: number;
  /** How many chunks may reach the LLM. */
  finalTopK: number;
  /** The reciprocal rank fusion constant added to each rank. */
  rrfK: number;
  /** Vector similarity below this does not count as a match. */
  minVectorSimilarity: number;
  /** Rerank score below this keeps a chunk away from the LLM. */
  minRerankScore: number;
  /** False if no chunk was kept for the LLM. */
  relevant: boolean;
  maxBm25Score: number;
  maxVectorSimilarity: number;
  maxRerankScore: number;
  rerankerBackend: string;
  /** The chunks kept for the LLM. At most `finalTopK`. */
  results: RerankedItem[];
  bm25List: Bm25RankedItem[];
  vectorList: VectorRankedItem[];
  /** The fusion shortlist before the reranker. At most `shortlistTopK`. */
  rrfShortlist: RrfShortlistItem[];
  /** The same list as `rrfShortlist`, kept for page fields that still read this name. */
  fusedResults: RrfShortlistItem[];
  /** Every shortlist chunk with its rerank score and whether it was kept. */
  reranked: RerankedItem[];
  /** Which chunks the caller's RBAC roles allowed. Absent if no role filter ran. */
  permissionReport?: PermissionReport;
  callerRoles?: string[];
}

/** The index as saved to disk. */
export interface IndexFile {
  version: number;
  /** ISO 8601 time the file was written. */
  createdAt: string;
  /** True if the embeddings came from the offline mock, not OpenAI. */
  mock: boolean;
  /** Embedding model name. Null if the mock made the vectors. */
  model: string | null;
  chunkCount: number;
  chunks: DocChunk[];
}

/** One earlier message in the conversation. */
export interface ChatHistoryTurn {
  role: 'user' | 'assistant' | string;
  content: string;
}

/** The data stored beside each vector in Pinecone. */
export interface PineconeRecordMeta {
  /** The raw section text. */
  text: string;
  prefixedText: string;
  contentHash?: string;
  contextHeader?: string;
  contextualizedContent?: string;
  sourceFile: string;
  headingPath: string;
  /** The roles the RBAC role filter matches against. */
  roles: string[];
}

/** One vector record in the local Pinecone simulator, shaped like a real Pinecone record. */
export interface PineconeMockRecord {
  id: string;
  values: number[];
  metadata: PineconeRecordMeta;
}
