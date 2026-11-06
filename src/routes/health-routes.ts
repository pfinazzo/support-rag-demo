/**
 * Why this file exists: the page and any load balancer need to ask "is the
 * server up, and how is it set up?" without calling a vendor. These routes
 * answer from memory only. A health check that called a vendor would report
 * "down" whenever the vendor was down, even though this server was fine.
 */
import { buildChunkingTelemetry } from '../chunking-telemetry.js';
import { HAS_ANTHROPIC_KEY, HAS_COHERE_KEY, HAS_OPENAI_KEY } from '../config.js';
import { isMockAi } from '../env.js';
import { sendJson } from '../http-exchange.js';
import { getLlmProvider } from '../local-claude.js';
import { resolveRerankerBackend } from '../reranker.js';
import { documentStore, isMockIndex, pineconeSettings, reindexer } from '../runtime.js';
import type { RouteContext } from './route-types.js';

/** The search tuning in force right now, read from the live searcher. */
const toSearchSettings = () => {
  const { rrfK, shortlistTopK, finalTopK, minVectorSimilarity, minRerankScore } =
    reindexer.searcher;
  return { rrfK, shortlistTopK, finalTopK, minVectorSimilarity, minRerankScore };
};

/** Which Pinecone the server is talking to: the cloud index or the local stand-in. */
const toPineconeBackend = (): string =>
  pineconeSettings.hasKey ? 'pinecone-cloud' : 'pinecone-local-simulator';

/** Answers whether the server is up and how it is set up. */
export const handleHealth = ({ response }: RouteContext): void =>
  sendJson({
    response,
    body: {
      ok: true,
      mockEmbeddings: isMockAi(),
      mock: isMockAi(),
      llmProvider: getLlmProvider(),
      hasOpenAI: HAS_OPENAI_KEY,
      hasAnthropic: HAS_ANTHROPIC_KEY,
      hasCohere: HAS_COHERE_KEY,
      chunkCount: reindexer.chunks.length,
      indexMock: isMockIndex,
      ...toSearchSettings(),
      rerankerBackend: resolveRerankerBackend(),
      pinecone: {
        backend: toPineconeBackend(),
        indexName: pineconeSettings.indexName,
        hasApiKey: pineconeSettings.hasKey,
      },
    },
  });

/** Shows how the documents were split into chunks and which settings search uses. */
export const handleChunkingTelemetry = ({ response }: RouteContext): void =>
  sendJson({
    response,
    body: buildChunkingTelemetry({
      documents: documentStore.documents(),
      indexedChunks: reindexer.chunks,
      searchSettings: toSearchSettings(),
      rerankerBackend: resolveRerankerBackend(),
      llmProvider: getLlmProvider(),
      isMockEmbeddings: isMockAi(),
      pinecone: {
        backend: toPineconeBackend(),
        indexName: pineconeSettings.indexName,
        cloud: pineconeSettings.cloud,
        region: pineconeSettings.region,
        hasApiKey: pineconeSettings.hasKey,
        filterTemplate: { roles: { $in: ['<callerRoles>'] } },
      },
    }),
  });
