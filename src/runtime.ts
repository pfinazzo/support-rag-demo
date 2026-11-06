/**
 * Why this file exists: the server needs a few long-lived objects: the search
 * index, the document store, the semantic cache and the prompt guard. They are
 * built once here, in the order they depend on each other, and every route
 * imports the same copies. Two copies would let a document change reach one
 * and not the other, and answers would disagree.
 */
import {
  DATA_DIRECTORY,
  DOCS_DIRECTORY,
  HAS_ANTHROPIC_KEY,
  IS_MOCK_LLM_FORCED,
  SHOULD_DEFAULT_TO_MOCK_EMBEDDINGS,
} from './config.js';
import { DocumentStore } from './doc-store.js';
import { isMockAi } from './env.js';
import { indexPathForMode, loadIndex } from './index-store.js';
import {
  checkClaudeAuth,
  getLlmProvider,
  initLlmProvider,
  setLlmProvider,
} from './local-claude.js';
import { pineconeConfig } from './pinecone-store.js';
import { PromptGuard } from './prompt-guard.js';
import { IncrementalIndexer } from './reindexer.js';
import { SemanticCache } from './semantic-cache.js';

/**
 * Switches embeddings to mock vectors when no OpenAI key is set. Changes `process.env`.
 * This runs first because every step below asks `isMockAi()`, and the answer
 * decides which index file is loaded. It only affects embeddings. The language
 * model is chosen separately.
 */
const applyMockEmbeddingsDefault = (): void => {
  if (!SHOULD_DEFAULT_TO_MOCK_EMBEDDINGS) return;
  process.env.MOCK_AI = 'true';
  console.log(
    'No OPENAI_API_KEY found — enabling MOCK_AI=true for embeddings (LLM provider is separate).',
  );
};

/**
 * Uses the logged-in Claude command line tool when no API key is set.
 * Why: a developer who is already logged in should get real answers without
 * copying a key. The provider only changes if it is still on mock.
 */
const enableLocalClaudeIfLoggedIn = async (): Promise<void> => {
  const status = await checkClaudeAuth();
  if (!status.installed || !status.loggedIn || getLlmProvider() !== 'mock') return;
  setLlmProvider({ provider: 'local-claude' });
  console.log(`Auto-activated logged-in Local Claude CLI (${status.account || status.binaryPath})`);
};

/**
 * Starts the Claude login check without waiting for it.
 * Not awaiting is deliberate: the server can start before the check ends, and
 * a failed check only means the provider stays on mock, which it logs here.
 */
const startLocalClaudeCheck = (): void => {
  if (IS_MOCK_LLM_FORCED || HAS_ANTHROPIC_KEY) return;
  enableLocalClaudeIfLoggedIn().catch((error: unknown) =>
    console.warn(
      'Local Claude check failed; staying on the current provider:',
      error instanceof Error ? error.message : error,
    ),
  );
};

applyMockEmbeddingsDefault();

initLlmProvider({ forceMockLlm: IS_MOCK_LLM_FORCED, hasAnthropicKey: HAS_ANTHROPIC_KEY });

startLocalClaudeCheck();

const indexFile = indexPathForMode({ dataDir: DATA_DIRECTORY });

console.log(`Loading index: ${indexFile}`);

export const isMockIndex = Boolean(loadIndex({ filePath: indexFile }).mock);

/**
 * Warnings for an index built with a different kind of embeddings than the
 * ones now in use. Why: mock and real vectors have different sizes and
 * meanings, so mixing them returns confident nonsense.
 */
const INDEX_MISMATCH_WARNINGS = [
  {
    isActive: isMockAi() && !isMockIndex,
    message: 'WARNING: MOCK_AI=true but index was built with real embeddings.',
  },
  {
    isActive: !isMockAi() && isMockIndex,
    message: 'WARNING: Loaded a mock index without MOCK_AI=true. Vectors may not align.',
  },
];

INDEX_MISMATCH_WARNINGS.filter(({ isActive }) => isActive).forEach(({ message }) =>
  console.warn(message),
);

export const documentStore = await DocumentStore.open({ docsDir: DOCS_DIRECTORY });

export const reindexer = await new IncrementalIndexer({ store: documentStore }).initialize();

export const semanticCache = new SemanticCache();

export const promptGuard = new PromptGuard();

export const pineconeSettings = pineconeConfig();

console.log(
  `Pinecone: ${pineconeSettings.hasKey ? 'CLOUD' : 'local-simulator'} index=${pineconeSettings.indexName} filter={{ roles: { $in: callerRoles } }}`,
);
