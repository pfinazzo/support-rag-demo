#!/usr/bin/env node
/**
 * Why this file exists: search needs an index of the document sections with their
 * embeddings. A person runs this script after the docs change, or on first setup.
 * It splits the Markdown docs by heading, embeds each section with OpenAI, and writes
 * the index file. It also writes records for the local Pinecone simulator, and upserts
 * to Pinecone Cloud when a key is set. Without it, search has nothing to look up.
 *
 * Run it with `npx tsx scripts/build-index.ts`. With no OpenAI key, run
 * `MOCK_AI=true npx tsx scripts/build-index.ts --mock` to use mock embeddings.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/env.js';
import { loadAndChunkDocs } from '../src/chunker.js';
import { embedMany, EMBEDDING_MODEL } from '../src/embeddings.js';
import { saveIndex, indexPathForMode } from '../src/index-store.js';
import {
  chunkToPineconeRecord,
  pineconeConfig,
  savePineconeMock,
  upsertChunksToPinecone,
} from '../src/pinecone-store.js';
import type { DocChunk } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const root = path.resolve(__dirname, '..');

loadEnv({ filePath: path.join(root, '.env') });

/**
 * True when the person asked for deterministic fake vectors, by flag or by MOCK_AI.
 * Why it sets MOCK_AI: the embedding code checks that variable, not this flag.
 */
const wantMock =
  process.argv.includes('--mock') || String(process.env.MOCK_AI || '').toLowerCase() === 'true';

if (wantMock) process.env.MOCK_AI = 'true';

const docsDir = path.join(root, 'docs');

const dataDir = path.join(root, 'data');

/**
 * The index file to write. Mock and real runs use different files, so a mock run
 * cannot overwrite the real index.
 */
const outPath = indexPathForMode({ dataDir, mock: wantMock });

console.log(
  `Mode:        ${wantMock ? 'MOCK (deterministic vectors)' : 'OpenAI ' + EMBEDDING_MODEL}`,
);

console.log(`Docs:        ${docsDir}`);

console.log(`Output:      ${outPath}`);

const chunks = loadAndChunkDocs({ docsDir });

console.log(`Chunked ${chunks.length} sections from Markdown headings.`);

/** A short sample of each section's RBAC role filter, printed so a person can see roles were read. */
const roleSample = chunks.slice(0, 3).map((c) => `${c.sourceFile} → [${c.roles.join(', ')}]`);

console.log(`Role-Based Access Control (RBAC) sample: ${roleSample.join(' | ')}`);

/**
 * Embeds each section's text, using the contextualized version when it exists.
 * Calls OpenAI unless mock mode is on. Prints progress on one line.
 */
const embeddings = await embedMany({
  texts: chunks.map((c) => c.contextualizedContent || c.prefixedText),
  onProgress: ({ done, total }) => {
    process.stdout.write(`\rEmbedding ${done}/${total}…`);
  },
});

process.stdout.write('\n');

/** One index record per section. The id is the section's position, such as chunk_007. */
const records: DocChunk[] = chunks.map((c, i) => ({
  id: `chunk_${String(i).padStart(3, '0')}`,
  sourceFile: c.sourceFile,
  headingPath: c.headingPath,
  rawContent: c.rawContent,
  prefixedText: c.prefixedText,
  contextHeader: c.contextHeader,
  contextualizedContent: c.contextualizedContent,
  embedding: embeddings[i],
  roles: c.roles,
}));

/** Writes the index file to disk. */
saveIndex({
  filePath: outPath,
  records,
  meta: {
    mock: wantMock,
    model: wantMock ? 'mock-hash-v1' : EMBEDDING_MODEL,
  },
});

console.log(`Wrote ${records.length} chunks → ${outPath}`);

/** Always writes the local Pinecone simulator file, so the demo works with no key. */
const pineconeRecords = records.map((chunk) => chunkToPineconeRecord({ chunk }));

const mockPath = savePineconeMock({ records: pineconeRecords, dataDir });

console.log(`Wrote Pinecone local-simulator records → ${mockPath}`);

/**
 * Upserts to Pinecone Cloud only when a key is set.
 * If the upsert fails: the script logs a warning and still finishes, because the local
 * index and simulator file are already written.
 */
const cfg = pineconeConfig();

if (cfg.hasKey) {
  console.log(`PINECONE_API_KEY set — upserting to Pinecone Cloud index "${cfg.indexName}"…`);
  try {
    const result = await upsertChunksToPinecone({ chunks: records });
    console.log(`Pinecone Cloud upserted ${result.upserted} vectors into ${result.indexName}`);
  } catch (err) {
    console.warn(
      'Pinecone Cloud upsert failed (local simulator still available):',
      (err as Error).message,
    );
  }
} else {
  console.log(
    'No PINECONE_API_KEY — using zero-key Pinecone local simulator (data/pinecone.mock.json).',
  );
}

if (wantMock) {
  console.log(
    'Tip: production index stays clean at data/index.json (run without --mock / MOCK_AI).',
  );
}
