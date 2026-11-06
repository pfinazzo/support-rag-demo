/**
 * Why this file exists: every route reads a request and writes a response the
 * same way. Keeping that here means a route only says what it wants to send,
 * and a fix to headers or error bodies lands in one place.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { text as readStreamText } from 'node:stream/consumers';

export type JsonObject = Record<string, unknown>;

/** Sends one named event to the page. Does nothing when nobody is listening. */
export type EmitEvent = (params: { event: string; data: unknown }) => void;

/**
 * An error a route threw on purpose, so the caller sees a 4xx with its message.
 * Any other error is a bug, and the caller sees a 500 without the details.
 */
export type HttpError = Error & { readonly statusCode: number; readonly details: JsonObject };

type ErrorResponse = { readonly statusCode: number; readonly body: JsonObject };

const UNEXPECTED_ERROR_MESSAGE = 'Could not complete this request.';

/**
 * Letters, digits, dot, dash and underscore only.
 * Why: the id is echoed in a header and written to logs, so it must not carry
 * a line break that could forge a log line.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
};

/**
 * Headers for a stream of events. `no-transform` and `X-Accel-Buffering` stop
 * proxies from holding events back, which would make the page look frozen.
 */
const EVENT_STREAM_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'Access-Control-Allow-Origin': '*',
  'X-Accel-Buffering': 'no',
};

/**
 * Builds an error a route throws when the caller sent something wrong.
 * `details` adds fields to the response body, such as the current Claude login status.
 */
export const createHttpError = ({
  statusCode,
  message,
  details = {},
}: {
  statusCode: number;
  message: string;
  details?: JsonObject;
}): HttpError => Object.assign(new Error(message), { statusCode, details });

/** True for an error made by `createHttpError`. A type guard takes its value directly. */
export const isHttpError = (error: unknown): error is HttpError =>
  error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number';

/**
 * Turns any thrown error into the status and body the caller may see.
 * Why: an error message can reveal how the server works inside. Only errors we
 * threw on purpose show their message. Everything else gets a plain sentence
 * and the request id, so a bug report can be matched to the log line.
 */
export const buildErrorResponse = ({
  error,
  requestId,
}: {
  error: unknown;
  requestId: string;
}): ErrorResponse =>
  isHttpError(error)
    ? { statusCode: error.statusCode, body: { error: error.message, ...error.details } }
    : { statusCode: 500, body: { error: UNEXPECTED_ERROR_MESSAGE, requestId } };

/**
 * Runs a check that throws a plain Error on bad input, and reports that error
 * to the caller as a 400.
 * Why: the shared validators (semantic cache threshold, prompt guard settings) throw plain
 * errors. Without this, a typo in a request would come back as a 500.
 */
export const runOrRejectWithBadRequest = <Result>({ run }: { run: () => Result }): Result => {
  try {
    return run();
  } catch (error) {
    throw createHttpError({
      statusCode: 400,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

/** True for a plain JSON object. Arrays and null are not objects here. */
export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Uses the request id a load balancer already set, or makes a new one.
 * Why: one id on every log line and error lets a person's bug report be found
 * in the logs of a whole cluster.
 */
export const resolveRequestId = ({ request }: { request: IncomingMessage }): string => {
  const incomingId = request.headers['x-request-id'];
  return typeof incomingId === 'string' && REQUEST_ID_PATTERN.test(incomingId)
    ? incomingId
    : randomUUID();
};

/** Parses JSON text. Throws a 400 so a typo in a request is not reported as a server bug. */
const parseJson = ({ rawBody }: { rawBody: string }): unknown => {
  try {
    return JSON.parse(rawBody);
  } catch {
    throw createHttpError({ statusCode: 400, message: 'Invalid JSON body' });
  }
};

/**
 * Reads the request body as one JSON object. An empty body is an empty object.
 * Throws a 400 when the body is not valid JSON or not an object.
 */
export const readJsonBody = async ({
  request,
}: {
  request: IncomingMessage;
}): Promise<JsonObject> => {
  const rawBody = await readStreamText(request);
  if (!rawBody) return {};

  const parsed = parseJson({ rawBody });
  if (!isJsonObject(parsed)) {
    throw createHttpError({ statusCode: 400, message: 'Request body must be a JSON object' });
  }
  return parsed;
};

/**
 * Writes a JSON response. Writes to the response.
 * The body is turned into text before any header is sent. If it cannot be
 * turned into text, the caller gets a clean 500 instead of a half-sent reply.
 */
export const sendJson = ({
  response,
  body,
  statusCode = 200,
}: {
  response: ServerResponse;
  body: unknown;
  statusCode?: number;
}): void => {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, JSON_HEADERS);
  response.end(payload);
};

/** Writes a plain-text or Markdown response. Writes to the response. */
export const sendText = ({
  response,
  statusCode,
  contentType,
  text,
  headers = {},
}: {
  response: ServerResponse;
  statusCode: number;
  contentType: string;
  text: string;
  headers?: Record<string, string>;
}): void => {
  response.writeHead(statusCode, { 'Content-Type': contentType, ...headers });
  response.end(text);
};

/**
 * Builds an emitter that writes one named event to an open stream.
 * It skips the write once the page has gone away, because writing to a closed
 * connection throws.
 */
export const createEventWriter =
  ({ response }: { response: ServerResponse }): EmitEvent =>
  ({ event, data }) => {
    if (response.destroyed) return;
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

/**
 * Opens an event stream and returns the emitter for it. Writes the headers.
 * Headers are sent at once so the page sees the stream open before the first event.
 */
export const startEventStream = ({ response }: { response: ServerResponse }): EmitEvent => {
  response.writeHead(200, EVENT_STREAM_HEADERS);
  response.flushHeaders();
  return createEventWriter({ response });
};

/** The emitter used when the page asked for one JSON reply, not a stream. */
export const ignoreEvent: EmitEvent = () => undefined;
