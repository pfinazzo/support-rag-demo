/**
 * Why this file exists: the page shows how the model is chosen, what is saved
 * by prompt caching, how the prompt window fills up, and how answers are
 * graded. These routes expose each of those, with their own test inputs, so
 * the page can demonstrate them without a full question.
 */
import { buildContext } from '../generation/context-builder.js';
import { parseConversationTurns } from '../query/conversation-turns.js';
import { fallbackChain } from '../generation/fallback-chain.js';
import { createHttpError, isJsonObject, readJsonBody, sendJson } from '../http-exchange.js';
import { gradeResponseWithJudge } from '../evals/llm-judge.js';
import { modelRouter } from '../generation/model-router.js';
import { promptCacheLedger } from '../generation/prompt-cache.js';
import { TRICKY_REWRITE_QUERIES } from '../query/query-rewriter.js';
import { SupportResponseJsonSchema } from '../generation/structured-output.js';
import type { RouteContext } from './route-types.js';

const DEFAULT_CONTEXT_SYSTEM_PROMPT = 'You are an evidence-grounded support assistant.';

const DEFAULT_CONTEXT_QUESTION = 'Continue this conversation';

const DEFAULT_HARD_TOKEN_LIMIT = 8000;

const DEFAULT_MAX_TOKENS_PER_TURN_RATE = 160;

const DEFAULT_PROBE_QUERY = 'What is my plan?';

const DEFAULT_PROBE_ERROR = 'HTTP 503';

type JudgeSource = { sourceFile: string; text: string };

/** True for a source the judge can read: a file name and its text. */
const isJudgeSource = (value: unknown): value is JudgeSource =>
  isJsonObject(value) && typeof value.sourceFile === 'string' && typeof value.text === 'string';

/** Reads the sources a judge request carries. Throws a 400 when one is malformed. */
const parseJudgeSources = ({ value }: { value: unknown }): JudgeSource[] => {
  if (!Array.isArray(value)) return [];
  if (!value.every(isJudgeSource)) {
    throw createHttpError({
      statusCode: 400,
      message: 'sources must be a list of { sourceFile, text }',
    });
  }
  return value;
};

/** Reads a list of text values, such as model names. Anything else counts as an empty list. */
const toTextList = ({ value }: { value: unknown }): string[] =>
  Array.isArray(value) ? value.map(String) : [];

/** Shows which model each kind of question goes to, and the fallback attempts so far. */
export const handleRouterState = ({ response }: RouteContext): void =>
  sendJson({ response, body: { ...modelRouter.status(), fallback: fallbackChain.status() } });

/**
 * Tests the fallback chain without calling a model. Changes whether the local
 * model is allowed as a last resort.
 * The caller names which models should fail. The chain then shows how it
 * falls through to the next one. If every model fails, the answer is still a
 * 200 with the error, because showing that failure is the point of the probe.
 */
export const handleRouterProbe = async ({ request, response }: RouteContext): Promise<void> => {
  const body = await readJsonBody({ request });
  const failingModels = toTextList({ value: body.failModels });
  fallbackChain.localEnabled = body.localEnabled === true;
  const route = modelRouter.route({ query: String(body.query || DEFAULT_PROBE_QUERY) });

  try {
    const outcome = await fallbackChain.run({
      primary: route.model,
      invoke: async ({ model }) => {
        if (failingModels.includes(model))
          throw new Error(String(body.error || DEFAULT_PROBE_ERROR));
        return 'Link healthy (injected transport probe)';
      },
    });
    sendJson({ response, body: { route, ...outcome, status: fallbackChain.status() } });
  } catch (error) {
    sendJson({
      response,
      body: {
        route,
        error: error instanceof Error ? error.message : String(error),
        status: fallbackChain.status(),
      },
    });
  }
};

/** Shows how much the shared start of the prompt has saved through prompt caching. */
export const handlePromptCacheState = ({ response }: RouteContext): void =>
  sendJson({ response, body: promptCacheLedger.status() });

/** Lists the short or vague questions the page uses to demonstrate query rewriting. */
export const handleRewriteQueries = ({ response }: RouteContext): void =>
  sendJson({ response, body: TRICKY_REWRITE_QUERIES });

/** Shows the exact shape every model answer must have. */
export const handleSchema = ({ response }: RouteContext): void =>
  sendJson({ response, body: SupportResponseJsonSchema });

/**
 * Builds a prompt from the given turns and reports how many tokens each part
 * takes. Throws a 400 for a limit that is not a positive number.
 */
export const handleContextBuild = async ({ request, response }: RouteContext): Promise<void> => {
  const body = await readJsonBody({ request });
  const hardTokenLimit = Number(body.hardTokenLimit || DEFAULT_HARD_TOKEN_LIMIT);
  const maxTokensPerTurnRate = Number(
    body.maxTokensPerTurnRate ?? DEFAULT_MAX_TOKENS_PER_TURN_RATE,
  );
  if (!Number.isFinite(hardTokenLimit) || hardTokenLimit < 1) {
    throw createHttpError({
      statusCode: 400,
      message: 'hardTokenLimit must be a number of 1 or more',
    });
  }
  if (!Number.isFinite(maxTokensPerTurnRate) || maxTokensPerTurnRate < 0) {
    throw createHttpError({
      statusCode: 400,
      message: 'maxTokensPerTurnRate must be a number of 0 or more',
    });
  }

  const report = await buildContext({
    input: {
      systemPrompt: String(body.systemPrompt || DEFAULT_CONTEXT_SYSTEM_PROMPT),
      tools: [],
      retrievedChunks: [],
      turns: parseConversationTurns({ value: body.turns, fieldName: 'turns' }),
      question: String(body.question || DEFAULT_CONTEXT_QUESTION),
      hardTokenLimit,
      maxTokensPerTurnRate,
    },
  });
  sendJson({ response, body: report });
};

/** Grades one answer against its sources on four points. Uses a model only when `live` is true. */
export const handleJudge = async ({ request, response }: RouteContext): Promise<void> => {
  const body = await readJsonBody({ request });
  const grade = await gradeResponseWithJudge({
    question: String(body.question || ''),
    answer: String(body.answer || ''),
    sources: parseJudgeSources({ value: body.sources }),
    live: body.live === true,
  });
  sendJson({ response, body: grade });
};
