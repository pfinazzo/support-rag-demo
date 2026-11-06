/**
 * Why this file exists: the page sends loose JSON. This turns it into one typed
 * request, once, at the edge. Everything after it can trust the shape and
 * never re-checks, and a bad field is a 400 that names the field.
 */
import { parseConversationTurns } from './conversation-turns.js';
import type { JsonObject } from './http-exchange.js';
import { createHttpError, isJsonObject, runOrRejectWithBadRequest } from './http-exchange.js';
import { resolveCallerRoles } from './roles.js';
import { validateThreshold } from './semantic-cache.js';
import type { ChatHistoryTurn } from './types.js';

/**
 * One question from the page, checked and ready to answer.
 * The arrays are plain, not readonly, because the hybrid search and semantic cache functions
 * in this project take plain arrays.
 */
export type ChatRequest = {
  readonly message: string;
  readonly history: ChatHistoryTurn[];
  readonly roles: string[];
  readonly rolePreset: string;
  /** Number of passages to keep. Undefined means use the searcher's default. */
  readonly topK: number | undefined;
  /** Closest-match score a saved answer needs, from 0.10 to 0.99. Undefined means the semantic cache default. */
  readonly semanticCacheThreshold: number | undefined;
  readonly shouldBypassSemanticCache: boolean;
  readonly shouldUseLiveJudge: boolean;
  /** Failures to inject on purpose, by name. Used to test the fallback path. */
  readonly faults: Record<string, string> | undefined;
};

/** True for an object whose values are all text. */
const isTextRecord = (value: unknown): value is Record<string, string> =>
  isJsonObject(value) && Object.values(value).every((entry) => typeof entry === 'string');

/** Checks the semantic cache threshold with the semantic cache's own rule, so both agree on what is valid. */
const parseSemanticCacheThreshold = ({ value }: { value: unknown }): number | undefined =>
  value === undefined
    ? undefined
    : runOrRejectWithBadRequest({ run: () => validateThreshold({ value }) });

/** Reads the injected-failure map. Throws a 400 when it is not an object of text. */
const parseFaults = ({ value }: { value: unknown }): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (!isTextRecord(value)) {
    throw createHttpError({ statusCode: 400, message: 'faults must be an object of text values' });
  }
  return value;
};

/**
 * Turns the JSON body of a chat request into a typed request.
 * `topK` falls back to undefined for 0 or non-numbers, so one bad value means
 * "use the default" and never "search for NaN passages".
 */
export const toChatRequest = ({ body }: { body: JsonObject }): ChatRequest => ({
  message: String(body.message || body.query || ''),
  history: parseConversationTurns({ value: body.history, fieldName: 'history' }),
  roles: resolveCallerRoles(body),
  rolePreset: String(body.rolePreset || ''),
  topK: Number(body.topK) || undefined,
  semanticCacheThreshold: parseSemanticCacheThreshold({ value: body.cacheThreshold }),
  shouldBypassSemanticCache: body.bypassCache === true,
  shouldUseLiveJudge: body.liveJudge === true,
  faults: parseFaults({ value: body.faults }),
});
