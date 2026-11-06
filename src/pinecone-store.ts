/**
 * Why this file exists: vector search must hide documents the caller's role
 * may not read. This file talks to Pinecone, or to a local stand-in, and
 * applies the RBAC role filter on every query. Without it, a customer could
 * get a staff-only passage back from search.
 *
 * Normally: PINECONE_API_KEY is set, and the file queries a Pinecone
 * serverless index that uses cosine similarity and an HNSW index.
 *
 * If no key is set: the file reads and writes data/pinecone.mock.json.
 * It applies the same role filter before it scores any vector.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pinecone } from '@pinecone-database/pinecone';
import { cosineSimilarity } from './embeddings.js';
import { chunkAccessibleToRoles, rolesForChunk } from './roles.js';
import type {
  DocChunk,
  ExcludedChunkReport,
  PermissionReport,
  PineconeMockRecord,
} from './types.js';

/** Folder of this file. ES modules have no built-in __dirname. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The project folder, one level above src. */
const root = path.resolve(__dirname, '..');

/**
 * Reads the Pinecone settings from the environment.
 * The index defaults to support-rag-demo on AWS in us-east-1.
 * hasKey says whether live Pinecone can be used.
 * Empty or blank values fall back to the defaults.
 */
export function pineconeConfig() {
  const apiKey = String(process.env.PINECONE_API_KEY || '').trim();
  const indexName =
    String(process.env.PINECONE_INDEX || 'support-rag-demo').trim() || 'support-rag-demo';
  const cloud = String(process.env.PINECONE_CLOUD || 'aws').trim() || 'aws';
  const region = String(process.env.PINECONE_REGION || 'us-east-1').trim() || 'us-east-1';
  return {
    apiKey,
    indexName,
    cloud,
    region,
    hasKey: Boolean(apiKey),
  };
}

/** Returns the path of the local stand-in's JSON file, inside the data folder. */
export function pineconeMockPath({
  dataDir = path.join(root, 'data'),
}: { dataDir?: string } = {}): string {
  return path.join(dataDir, 'pinecone.mock.json');
}

/**
 * Converts a document chunk to a Pinecone record.
 * The vector is the chunk's embedding. The text and RBAC roles go in the metadata.
 */
export function chunkToPineconeRecord({ chunk }: { chunk: DocChunk }): PineconeMockRecord {
  return {
    id: chunk.id,
    values: chunk.embedding,
    metadata: {
      text: chunk.rawContent,
      prefixedText: chunk.prefixedText,
      contextHeader: chunk.contextHeader,
      contextualizedContent: chunk.contextualizedContent,
      sourceFile: chunk.sourceFile,
      headingPath: chunk.headingPath,
      roles: [...(chunk.roles || [])],
    },
  };
}

/**
 * Writes the records to the local stand-in's JSON file and returns its path.
 * Creates the data folder if needed and replaces any earlier file.
 */
export function savePineconeMock({
  records,
  dataDir,
}: {
  records: PineconeMockRecord[];
  dataDir?: string;
}): string {
  const out = pineconeMockPath({ dataDir });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const payload = {
    version: 1,
    createdAt: new Date().toISOString(),
    indexName: pineconeConfig().indexName,
    metric: 'cosine',
    backend: 'pinecone-local-simulator',
    note: 'Zero-key Pinecone simulator — uses the same { roles: { $in: callerRoles } } filter as Cloud.',
    recordCount: records.length,
    records,
  };
  fs.writeFileSync(out, JSON.stringify(payload, null, 2));
  return out;
}

/**
 * Reads the local stand-in's records.
 * If the file is missing or has no record list: returns an empty list.
 * Throws if the file holds invalid JSON.
 */
export function loadPineconeMock({ dataDir }: { dataDir?: string } = {}): PineconeMockRecord[] {
  const file = pineconeMockPath({ dataDir });
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    records?: PineconeMockRecord[];
  };
  return Array.isArray(raw.records) ? raw.records : [];
}

/** Upsert chunks into Pinecone Cloud (creates serverless cosine index if missing). */
/**
 * Upserts chunks into the Pinecone Cloud index, creating the index if it is missing.
 * Calls the Pinecone API and can create a paid resource.
 * Throws if no API key is set.
 * A new index takes its vector size from the first chunk, or 1536 if there is none.
 * After creating the index it waits 2.5 seconds before the first upsert.
 * Upserts go in batches of 50.
 * Each text field is cut to 35,000 characters.
 */
export async function upsertChunksToPinecone({ chunks }: { chunks: DocChunk[] }): Promise<{
  backend: 'pinecone-cloud';
  indexName: string;
  upserted: number;
}> {
  const cfg = pineconeConfig();
  if (!cfg.hasKey) {
    throw new Error('PINECONE_API_KEY is required for live Pinecone upsert');
  }
  const pc = new Pinecone({ apiKey: cfg.apiKey });
  const existing = await pc.listIndexes();
  const names = (existing.indexes || []).map((i) => i.name);
  if (!names.includes(cfg.indexName)) {
    const dims = chunks[0]?.embedding?.length || 1536;
    await pc.createIndex({
      name: cfg.indexName,
      dimension: dims,
      metric: 'cosine',
      spec: {
        serverless: {
          cloud: cfg.cloud as 'aws' | 'gcp' | 'azure',
          region: cfg.region,
        },
      },
    });
    await new Promise((r) => setTimeout(r, 2500));
  }

  const index = pc.index(cfg.indexName);
  /** Chunks sent to Pinecone per upsert call. */
  const BATCH = 50;
  let upserted = 0;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH).map((c) => ({
      id: c.id,
      values: c.embedding,
      metadata: {
        text: c.rawContent.slice(0, 35000),
        prefixedText: c.prefixedText.slice(0, 35000),
        contextHeader: c.contextHeader || '',
        contextualizedContent: (c.contextualizedContent || c.prefixedText).slice(0, 35000),
        sourceFile: c.sourceFile,
        headingPath: c.headingPath,
        roles: [...(c.roles || [])],
      },
    }));
    await index.upsert({ records: batch as never });
    upserted += batch.length;
  }
  return { backend: 'pinecone-cloud', indexName: cfg.indexName, upserted };
}

/** One search result from Pinecone or the local stand-in. */
export interface PineconeQueryHit {
  id: string;
  score: number;
  metadata: {
    text?: string;
    prefixedText?: string;
    sourceFile?: string;
    headingPath?: string;
    roles?: string[];
  };
}

/** Inputs for a live Pinecone query. */
type QueryPineconeParams = { queryVector: number[]; callerRoles: string[]; topK: number };

/**
 * Query Pinecone Cloud with Role-Based Access Control (RBAC) metadata filter:
 *   filter: { roles: { $in: callerRoles } }
 */
/**
 * Finds the topK chunks nearest the query vector in Pinecone Cloud.
 * Calls the Pinecone API.
 * Pinecone applies the RBAC role filter, so chunks the caller's roles cannot read never come back.
 * Throws if no API key is set.
 */
export async function queryPinecone({
  queryVector,
  callerRoles,
  topK,
}: QueryPineconeParams): Promise<{
  hits: PineconeQueryHit[];
  backend: 'pinecone-cloud';
  indexName: string;
}> {
  const cfg = pineconeConfig();
  if (!cfg.hasKey) {
    throw new Error('PINECONE_API_KEY is required for live Pinecone query');
  }
  const pc = new Pinecone({ apiKey: cfg.apiKey });
  const index = pc.index(cfg.indexName);
  const result = await index.query({
    vector: queryVector,
    topK,
    includeMetadata: true,
    filter: { roles: { $in: callerRoles } },
  });
  const hits: PineconeQueryHit[] = (result.matches || []).map((m) => ({
    id: String(m.id),
    score: Number(m.score || 0),
    metadata: (m.metadata || {}) as PineconeQueryHit['metadata'],
  }));
  return { hits, backend: 'pinecone-cloud', indexName: cfg.indexName };
}

/** Inputs for a query on the local stand-in. */
type QueryPineconeLocalSimulatorParams = {
  records: PineconeMockRecord[];
  queryVector: number[];
  callerRoles: string[];
  topK: number;
};

/**
 * Local Pinecone simulator: apply `{ roles: { $in: callerRoles } }` BEFORE cosine scoring.
 */
/**
 * Finds the topK nearest records in the local stand-in.
 * Drops the records the caller's roles cannot read before scoring.
 * This matches what Pinecone does, so the local run behaves like the live one.
 */
export function queryPineconeLocalSimulator({
  records,
  queryVector,
  callerRoles,
  topK,
}: QueryPineconeLocalSimulatorParams): {
  hits: PineconeQueryHit[];
  backend: 'pinecone-local-simulator';
  indexName: string;
} {
  const cfg = pineconeConfig();
  const filtered = records.filter((r) =>
    chunkAccessibleToRoles({ chunkRoles: r.metadata?.roles || [], callerRoles }),
  );
  const scored = filtered
    .map((r) => ({
      id: r.id,
      score: cosineSimilarity({ a: queryVector, b: r.values }),
      metadata: r.metadata,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  return {
    hits: scored,
    backend: 'pinecone-local-simulator',
    indexName: cfg.indexName,
  };
}

/**
 * Build permission telemetry: which chunks would have matched the query
 * (cosine ≥ 0.20 OR BM25 > 0) but were excluded by the Pinecone Role-Based Access Control (RBAC) filter.
 */
/**
 * Reports which chunks matched the query but were hidden by the RBAC role filter.
 * A hidden chunk counts as a match if its cosine similarity reaches the floor, 0.2 unless set, or its BM25 score is above zero.
 * The report lists the strongest hidden chunks, at most 5 unless set.
 * The demo shows this so a viewer can see what the role filter removed.
 */
export function buildPermissionReport(opts: {
  allChunks: DocChunk[];
  callerRoles: string[];
  queryVector: number[];
  bm25ByChunkId: Map<string, number>;
  cosineFloor?: number;
  maxExcluded?: number;
}): PermissionReport {
  const cfg = pineconeConfig();
  const cosineFloor = opts.cosineFloor ?? 0.2;
  const maxExcluded = opts.maxExcluded ?? 5;
  const accessible = opts.allChunks.filter((c) =>
    chunkAccessibleToRoles({ chunkRoles: c.roles, callerRoles: opts.callerRoles }),
  );
  const excluded: ExcludedChunkReport[] = [];
  for (const c of opts.allChunks) {
    if (chunkAccessibleToRoles({ chunkRoles: c.roles, callerRoles: opts.callerRoles })) continue;
    const cosineSim = cosineSimilarity({ a: opts.queryVector, b: c.embedding });
    const bm25Score = opts.bm25ByChunkId.get(c.id) || 0;
    if (cosineSim >= cosineFloor || bm25Score > 0) {
      excluded.push({
        id: c.id,
        sourceFile: c.sourceFile,
        headingPath: c.headingPath,
        chunkRoles: [...(c.roles || [])],
        cosineSim,
        bm25Score,
      });
    }
  }
  excluded.sort((a, b) => Math.max(b.cosineSim, b.bm25Score) - Math.max(a.cosineSim, a.bm25Score));
  return {
    backend: cfg.hasKey ? 'pinecone-cloud' : 'pinecone-local-simulator',
    indexName: cfg.indexName,
    filter: { roles: { $in: [...opts.callerRoles] } },
    callerRoles: [...opts.callerRoles],
    accessibleChunkCount: accessible.length,
    totalChunkCount: opts.allChunks.length,
    excludedChunks: excluded.slice(0, maxExcluded),
  };
}

/**
 * Returns the chunks with roles filled in.
 * A chunk that has no roles gets them from its source file and heading.
 * Without roles, a chunk would match no role filter and could never be found.
 */
export function ensureChunkRoles({ chunks }: { chunks: DocChunk[] }): DocChunk[] {
  return chunks.map((c) => ({
    ...c,
    roles:
      Array.isArray(c.roles) && c.roles.length > 0
        ? c.roles
        : rolesForChunk({ sourceFile: c.sourceFile, headingPath: c.headingPath }),
  }));
}
