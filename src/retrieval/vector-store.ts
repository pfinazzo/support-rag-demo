/**
 * Why this file exists: it gathers the indexing and Pinecone query functions
 * behind one import path, so callers need not know which file each lives in.
 */
export { IncrementalIndexer, contentHash } from '../ingest/reindexer.js';

export { queryPinecone, queryPineconeLocalSimulator, ensureChunkRoles } from './pinecone-store.js';
