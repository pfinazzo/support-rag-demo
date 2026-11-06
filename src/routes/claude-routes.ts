/**
 * Why this file exists: answers can come from a logged-in Claude command line
 * tool, an API key, OpenAI, or a mock. These routes let the page see which one
 * is active, log in or out, and switch, so a developer can try each without
 * restarting the server.
 */
import { HAS_ANTHROPIC_KEY } from '../config.js';
import { createHttpError, readJsonBody, sendJson } from '../http-exchange.js';
import type { LlmProvider } from '../local-claude.js';
import {
  checkClaudeAuth,
  disconnectLocalClaude,
  getLlmProvider,
  setLlmProvider,
  startClaudeLogin,
} from '../local-claude.js';
import type { RouteContext } from './route-types.js';

const LLM_PROVIDERS: readonly LlmProvider[] = ['local-claude', 'anthropic-api', 'openai', 'mock'];

/** The same names as a Set of plain text, so any string can be looked up without a type cast. */
const LLM_PROVIDER_NAMES = new Set<string>(LLM_PROVIDERS);

/** True for a provider name the server knows. A type guard takes its value directly. */
const isLlmProvider = (value: string): value is LlmProvider => LLM_PROVIDER_NAMES.has(value);

/**
 * Throws a 400 unless the Claude command line tool is logged in.
 * Why: switching to it while logged out would make every later answer fail.
 * The error carries the login status so the page can show what is wrong.
 */
const requireClaudeLogin = async (): Promise<void> => {
  const status = await checkClaudeAuth();
  if (status.loggedIn) return;
  throw createHttpError({
    statusCode: 400,
    message: 'Not logged in to Claude CLI. Call POST /api/claude/login first.',
    details: { status },
  });
};

/** Shows whether the Claude command line tool is installed and logged in. */
export const handleClaudeStatus = async ({ response }: RouteContext): Promise<void> =>
  sendJson({ response, body: await checkClaudeAuth() });

/** Starts the Claude login. Answers 400 when it could not start. */
export const handleClaudeLogin = async ({ response }: RouteContext): Promise<void> => {
  const outcome = await startClaudeLogin();
  sendJson({ response, body: outcome, statusCode: outcome.ok ? 200 : 400 });
};

/**
 * Logs the Claude command line tool out and moves to the next best provider:
 * the API when a key is set, otherwise the mock. Changes the active provider.
 */
export const handleClaudeDisconnect = async ({ response }: RouteContext): Promise<void> => {
  const fallbackProvider: LlmProvider = HAS_ANTHROPIC_KEY ? 'anthropic-api' : 'mock';
  const status = await disconnectLocalClaude({ fallback: fallbackProvider });
  sendJson({ response, body: { ok: true, llmProvider: getLlmProvider(), status } });
};

/** Switches the active provider. Throws a 400 for an unknown name, or for Claude while logged out. */
export const handleClaudeMode = async ({ request, response }: RouteContext): Promise<void> => {
  const body = await readJsonBody({ request });
  const provider = String(body.provider || '');
  if (!isLlmProvider(provider)) {
    throw createHttpError({
      statusCode: 400,
      message: `provider must be ${LLM_PROVIDERS.join(' | ')}`,
    });
  }
  if (provider === 'local-claude') await requireClaudeLogin();

  setLlmProvider({ provider });
  sendJson({ response, body: { ok: true, llmProvider: getLlmProvider() } });
};
