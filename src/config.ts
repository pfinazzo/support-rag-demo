/**
 * Why this file exists: this is the one place the server reads environment
 * variables. Listing every setting here shows what the server needs to run,
 * and no other server file touches `process.env` for these settings.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from './env.js';

const SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(SOURCE_DIRECTORY, '..');

/**
 * Loads `.env` before any setting below is read.
 * Without this, a key saved in `.env` would look missing, and the server
 * would quietly start in mock mode.
 */
loadEnv({ filePath: path.join(PROJECT_ROOT, '.env') });

export const PORT = Number(process.env.PORT || 3000);

export const DATA_DIRECTORY = path.join(PROJECT_ROOT, 'data');

export const DOCS_DIRECTORY = path.join(PROJECT_ROOT, 'docs');

export const PUBLIC_DIRECTORY = path.join(PROJECT_ROOT, 'public');

export const CLIENT_DIRECTORY = path.join(PROJECT_ROOT, 'client');

export const DATABASE_SEED_DIRECTORY = path.join(PROJECT_ROOT, 'reference/db-documents');

export const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);

export const HAS_ANTHROPIC_KEY = Boolean(process.env.ANTHROPIC_API_KEY);

export const HAS_COHERE_KEY = Boolean(process.env.COHERE_API_KEY);

export const IS_MOCK_LLM_FORCED = process.env.FORCE_MOCK_LLM === 'true';

export const IS_HOT_RELOAD_ENABLED = process.env.HOT_RELOAD !== '0';

/**
 * True only for the legacy test fixtures, which expect a held answer to be
 * stored in the semantic cache. In normal runs a held answer is never stored, because a repeat
 * question would then return text a person has not approved.
 */
export const SHOULD_STORE_HELD_ANSWERS_IN_SEMANTIC_CACHE =
  process.env.ALLOW_LEGACY_TEST_FIXTURES === 'true';

/**
 * True when nothing says which embeddings to use and there is no OpenAI key.
 * Why: a missing key should start a working offline demo, not a crash.
 */
export const SHOULD_DEFAULT_TO_MOCK_EMBEDDINGS =
  !HAS_OPENAI_KEY && process.env.MOCK_AI === undefined;
