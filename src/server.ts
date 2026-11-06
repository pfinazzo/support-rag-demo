/**
 * Why this file exists: this starts the HTTP server and handles what every
 * request has in common: an id, the cross-origin check, finding the route, and
 * turning an error into a safe reply. The routes themselves live in
 * `routes/`, and each one only says what to send.
 *
 * The first own-module import is `config.js`, on purpose. It loads `.env`, and
 * the modules after it read those settings when they load.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import { performance } from 'node:perf_hooks';

import { PORT } from './config.js';
import { isMockAi } from './env.js';
import {
  buildErrorResponse,
  createEventWriter,
  createHttpError,
  resolveRequestId,
  sendJson,
} from './http-exchange.js';
import { getLlmProvider } from './generation/local-claude.js';
import { nliModelStatus, warmupNli } from './verification/nli-model.js';
import { warmupPromptGuard } from './guard/prompt-guard-model.js';
import { resolveRerankerBackend, warmupReranker } from './ranking/reranker.js';
import { findRouteHandler } from './routes/index.js';
import type { RouteHandler } from './routes/route-types.js';
import { promptGuard, reindexer } from './runtime.js';
import { serveStaticFile } from './static-files.js';

/**
 * The only pages allowed to send a POST.
 * Why: this server has no sign-in. Without the check, any web page the
 * developer visits could post to localhost and change settings or run questions.
 */
const ALLOWED_WRITE_ORIGINS = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];

const PREFLIGHT_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/** Starts that take a while and may fail. A failed one is reported, and the server keeps running. */
const WARM_UPS = [
  {
    run: warmupPromptGuard,
    onReady: () => console.log('Prompt Guard classifier ready:', promptGuard.state().classifier),
    failureNote: 'Prompt Guard unavailable (fail-closed):',
  },
  {
    run: warmupReranker,
    onReady: () => undefined,
    failureNote: 'Reranker warmup skipped:',
  },
  {
    run: warmupNli,
    onReady: () => console.log('Citation NLI ready:', nliModelStatus()),
    failureNote: 'Citation NLI unavailable (checks fail closed):',
  },
];

/** Serves a file from `public/`. This is where every GET that is not an API route ends up. */
const serveStatic: RouteHandler = ({ request, response }) => serveStaticFile({ request, response });

const answerNotFound: RouteHandler = ({ response }) =>
  sendJson({ response, statusCode: 404, body: { error: 'Not found' } });

/**
 * What to do with a request no route claimed. A GET or HEAD is a page or
 * script, so it goes to the static files. Anything else is an unknown API call.
 */
const FALLBACK_HANDLERS_BY_METHOD = new Map<string, RouteHandler>([
  ['GET', serveStatic],
  ['HEAD', serveStatic],
]);

/** True for a POST from a page that is not this server's own page. */
const isForeignOriginWrite = ({
  method,
  origin,
}: {
  method: string;
  origin: string | undefined;
}): boolean => {
  if (method !== 'POST' || !origin) return false;
  return !ALLOWED_WRITE_ORIGINS.includes(origin);
};

/** Answers the browser's permission check before a cross-origin request. */
const sendPreflightReply = ({ response }: { response: ServerResponse }): void => {
  response.writeHead(204, PREFLIGHT_HEADERS);
  response.end();
};

/** The request path with no query string. Why: the query can carry values that must stay out of logs. */
const readPathname = ({ request }: { request: IncomingMessage }): string =>
  (request.url || '/').split('?')[0];

/**
 * Logs one failure as one line, with the request id.
 * The line holds the real error text and stack, which the caller never sees.
 * It never holds the request body or any header.
 */
const logFailure = ({
  error,
  requestId,
  method,
  pathname,
  durationMs,
}: {
  error: unknown;
  requestId: string;
  method: string;
  pathname: string;
  durationMs: number;
}): void =>
  console.error(
    JSON.stringify({
      level: 'error',
      requestId,
      method,
      path: pathname,
      durationMs: Math.round(durationMs),
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );

/**
 * Sends the reply for a failed request.
 * Normally: a JSON error with the right status code.
 * If a stream already started: the status line has gone out and cannot change,
 * so the error is sent as a final event, and the page learns the stream failed.
 */
const sendFailureReply = ({
  response,
  failure,
}: {
  response: ServerResponse;
  failure: ReturnType<typeof buildErrorResponse>;
}): void => {
  if (!response.headersSent)
    return sendJson({ response, statusCode: failure.statusCode, body: failure.body });
  createEventWriter({ response })({ event: 'error', data: failure.body });
  response.end();
};

/**
 * Handles one request from start to finish. This is the only try/catch on the
 * request path. Routes and helpers let errors rise to here, so a failure is
 * logged once and answered once.
 */
const handleRequest = async ({
  request,
  response,
}: {
  request: IncomingMessage;
  response: ServerResponse;
}): Promise<void> => {
  const startedAtMs = performance.now();
  const requestId = resolveRequestId({ request });
  const method = request.method || 'GET';
  response.setHeader('X-Request-Id', requestId);

  if (method === 'OPTIONS') return sendPreflightReply({ response });

  try {
    const url = new URL(request.url || '/', 'http://localhost');
    if (isForeignOriginWrite({ method, origin: request.headers.origin })) {
      throw createHttpError({ statusCode: 403, message: 'Cross-origin writes are not permitted' });
    }

    const handler =
      findRouteHandler({ method, pathname: url.pathname }) ||
      FALLBACK_HANDLERS_BY_METHOD.get(method) ||
      answerNotFound;
    const baseUrl = `http://127.0.0.1:${request.socket.localPort ?? PORT}`;
    await handler({ request, response, url, baseUrl });
  } catch (error) {
    const failure = buildErrorResponse({ error, requestId });
    logFailure({
      error,
      requestId,
      method,
      pathname: readPathname({ request }),
      durationMs: performance.now() - startedAtMs,
    });
    sendFailureReply({ response, failure });
  }
};

/**
 * Runs one slow start and reports how it went. Never throws.
 * A failed start does not stop the server. The check itself fails closed when
 * it is used, so no request passes unchecked while it is unavailable.
 */
const runWarmUp = async ({ warmUp }: { warmUp: (typeof WARM_UPS)[number] }): Promise<void> => {
  try {
    await warmUp.run();
    warmUp.onReady();
  } catch (error) {
    console.warn(warmUp.failureNote, error instanceof Error ? error.message : error);
  }
};

/** Prints the settings in force, so a developer can see at a glance which mode started. */
const logStartup = (): void => {
  const { rrfK, shortlistTopK, finalTopK } = reindexer.searcher;
  console.log(`Support RAG demo listening on http://localhost:${PORT}`);
  console.log(
    `  embeddings MOCK_AI=${isMockAi()}  llmProvider=${getLlmProvider()}  chunks=${reindexer.chunks.length}`,
  );
  console.log(
    `  RRF k=${rrfK}  shortlist=${shortlistTopK}  finalTopK=${finalTopK}  reranker=${resolveRerankerBackend()}`,
  );
};

export const server = http.createServer((request, response) => {
  /**
   * Not awaited on purpose: the server calls this listener and ignores what it
   * returns. `handleRequest` answers its own errors, so this `.catch` only
   * covers a failure while sending the error reply itself.
   */
  handleRequest({ request, response }).catch((error: unknown) =>
    console.error('Unhandled request failure:', error),
  );
});

server.listen(PORT, '127.0.0.1', () => {
  logStartup();
  /**
   * Not awaited on purpose: the server should accept requests while models
   * load. `runWarmUp` never throws, so nothing is left unhandled.
   */
  WARM_UPS.forEach((warmUp) => void runWarmUp({ warmUp }));
});
