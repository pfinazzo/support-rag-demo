/**
 * Why this file exists: this is the list of every URL the server answers. Each
 * row is one URL and the function that handles it, so adding an endpoint means
 * adding a row. Keeping the list in one place also shows at a glance what the
 * server exposes.
 */
import { handleHotReloadSubscription } from '../ingest/hot-reload.js';
import {
  handleSemanticCacheClear,
  handleSemanticCacheState,
  handleSemanticCacheThreshold,
} from './semantic-cache-routes.js';
import { handleChat, handleChatStream, handleSearch } from './chat-routes.js';
import {
  handleCitationCheck,
  handleCitationStatus,
  handleCitationStream,
} from './citation-routes.js';
import {
  handleClaudeDisconnect,
  handleClaudeLogin,
  handleClaudeMode,
  handleClaudeStatus,
} from './claude-routes.js';
import { handleDocument } from './document-routes.js';
import { handleEvalQuestions, handleEvalRun, handleEvalStream } from './eval-routes.js';
import {
  handleGuardAuditClear,
  handleGuardCheck,
  handleGuardConfigUpdate,
  handleGuardState,
} from './guard-routes.js';
import { handleChunkingTelemetry, handleHealth } from './health-routes.js';
import {
  handleContextBuild,
  handleJudge,
  handlePromptCacheState,
  handleRewriteQueries,
  handleRouterProbe,
  handleRouterState,
  handleSchema,
} from './model-routes.js';
import {
  handleHandoffCheck,
  handleHandoffState,
  handleQualityMeterBatch,
  handleQualityMeterState,
  handleReviewQueueAction,
  handleReviewQueueState,
} from './operations-routes.js';
import { handleReindexMutate, handleReindexRestore, handleReindexState } from './reindex-routes.js';
import { handleStageCode } from './stage-code-routes.js';
import type { RouteHandler } from './route-types.js';

/** The path a request for any single document is filed under. */
const DOCUMENT_ROUTE_KEY = '/docs/*';

/**
 * A Map, not an object. Keys are built from the request's method and path,
 * which come from outside, and an object would answer for names like `constructor`.
 */
const ROUTES = new Map<string, RouteHandler>([
  ['GET /health', handleHealth],
  ['GET /api/health', handleHealth],
  ['GET /api/chunks', handleChunkingTelemetry],
  ['GET /api/pipeline/chunking', handleChunkingTelemetry],
  ['GET /api/hot-reload', handleHotReloadSubscription],
  [`GET ${DOCUMENT_ROUTE_KEY}`, handleDocument],

  ['POST /api/search', handleSearch],
  ['POST /api/chat', handleChat],
  ['POST /api/chat/stream', handleChatStream],

  ['GET /api/guard', handleGuardState],
  ['POST /api/guard/check', handleGuardCheck],
  ['POST /api/guard/config', handleGuardConfigUpdate],
  ['POST /api/guard/audit/clear', handleGuardAuditClear],

  ['GET /api/cache', handleSemanticCacheState],
  ['POST /api/cache/clear', handleSemanticCacheClear],
  ['POST /api/cache/threshold', handleSemanticCacheThreshold],

  ['GET /api/citations/status', handleCitationStatus],
  ['POST /api/citations/check', handleCitationCheck],
  ['POST /api/citations/stream', handleCitationStream],

  ['GET /api/eval/questions', handleEvalQuestions],
  ['POST /api/eval/run', handleEvalRun],
  ['POST /api/eval/stream', handleEvalStream],

  ['GET /api/quality-meter', handleQualityMeterState],
  ['POST /api/quality-meter/batch', handleQualityMeterBatch],
  ['GET /api/review-queue', handleReviewQueueState],
  ['POST /api/review-queue/action', handleReviewQueueAction],
  ['GET /api/handoff/status', handleHandoffState],
  ['POST /api/handoff/check', handleHandoffCheck],

  ['GET /api/reindex/status', handleReindexState],
  ['POST /api/reindex/mutate', handleReindexMutate],
  ['POST /api/reindex/restore', handleReindexRestore],

  ['GET /api/router/status', handleRouterState],
  ['POST /api/router/probe', handleRouterProbe],
  ['GET /api/prompt-cache/status', handlePromptCacheState],
  ['GET /api/rewrite/queries', handleRewriteQueries],
  ['GET /api/schema', handleSchema],
  ['GET /api/stage-code', handleStageCode],
  ['POST /api/context/build', handleContextBuild],
  ['POST /api/judge', handleJudge],

  ['GET /api/claude/status', handleClaudeStatus],
  ['POST /api/claude/login', handleClaudeLogin],
  ['POST /api/claude/disconnect', handleClaudeDisconnect],
  ['POST /api/claude/mode', handleClaudeMode],
]);

/**
 * The key a request is filed under. Every path under `/docs/` shares one key,
 * because the file name is part of the path and cannot be listed in advance.
 */
export const toRouteKey = ({ method, pathname }: { method: string; pathname: string }): string =>
  `${method} ${pathname.startsWith('/docs/') ? DOCUMENT_ROUTE_KEY : pathname}`;

/** Finds the handler for a request, or undefined when the URL is not an API route. */
export const findRouteHandler = ({
  method,
  pathname,
}: {
  method: string;
  pathname: string;
}): RouteHandler | undefined => ROUTES.get(toRouteKey({ method, pathname }));
