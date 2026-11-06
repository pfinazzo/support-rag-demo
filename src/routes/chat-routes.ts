/**
 * Why this file exists: this is where a customer's question enters. The route
 * validates the request, runs the prompt guard first, and only then starts the
 * pipeline. A blocked question never reaches the semantic cache, the hybrid search or the
 * model, so a malicious message cannot cost money or reach customer data.
 */
import type { ServerResponse } from 'node:http';

import { toChatRequest } from '../chat-request.js';
import { resolveRequestGuardConfig } from '../guard-config.js';
import type { EmitEvent } from '../http-exchange.js';
import { ignoreEvent, readJsonBody, sendJson, startEventStream } from '../http-exchange.js';
import type { FullGuardReport } from '../prompt-guard.js';
import { qualityMeter } from '../quality-meter.js';
import { resolveCallerRoles } from '../roles.js';
import { promptGuard, reindexer } from '../runtime.js';
import { runSupportPipeline } from '../support-pipeline.js';
import type { RouteContext } from './route-types.js';

type StreamEvent = { readonly event: string; readonly data: unknown };

/**
 * The reply for a question the guard stopped. It names the layer that caught
 * it, and says plainly which stages did not run.
 * Throws if no layer is marked as the one that blocked, since that would mean
 * the guard blocked a request without a reason.
 */
const buildBlockedReply = ({ guard }: { guard: FullGuardReport }) => {
  const caughtBy = guard.layers.find((layer) => layer.blocked);
  if (!caughtBy) throw new Error('The prompt guard blocked a request without naming a layer.');

  return {
    blockedByGuard: true,
    guard,
    dataSeparation: guard.dataSeparation,
    answer: `Blocked by Prompt Guard — ${caughtBy.name}: ${caughtBy.reason}. Semantic cache lookup, retrieval and LLM generation were not run.`,
    fallback: true,
    sources: [],
    chatStep: {
      contextPassedToLlm: [],
      usedFallback: true,
      answer: 'Prompt injection blocked',
      model: null,
    },
  };
};

/**
 * Sends the final reply. One JSON body for a plain request. For a stream, the
 * closing events and then a `close` event, so the page knows nothing more is
 * coming. Writes to the response.
 */
const sendChatReply = ({
  response,
  emit,
  isStreaming,
  body,
  streamEvents,
}: {
  response: ServerResponse;
  emit: EmitEvent;
  isStreaming: boolean;
  body: unknown;
  streamEvents: readonly StreamEvent[];
}): void => {
  if (!isStreaming) return sendJson({ response, body });
  streamEvents.forEach(({ event, data }) => emit({ event, data }));
  emit({ event: 'close', data: {} });
  response.end();
};

/**
 * Handles one chat request, as one JSON reply or as a stream of stage events.
 * Everything that can be a 400 is checked before the stream opens. Once the
 * stream has started, the status code is already sent and a 400 is no longer possible.
 */
const answerChat = async ({
  context,
  isStreaming,
}: {
  context: RouteContext;
  isStreaming: boolean;
}): Promise<void> => {
  const { request, response, baseUrl } = context;
  const body = await readJsonBody({ request });
  const chatRequest = toChatRequest({ body });
  const guardConfig = resolveRequestGuardConfig({
    guardConfig: body.guardConfig,
    simulateIndirectInjection: body.simulateIndirectInjection,
  });
  const emit = isStreaming ? startEventStream({ response }) : ignoreEvent;

  const guard = await promptGuard.check({
    query: chatRequest.message,
    overrides: guardConfig,
    onLayer: ({ event: layerEvent }) => emit({ event: 'guard_layer', data: layerEvent }),
  });
  if (guard.blocked) {
    qualityMeter.record({ sample: { promptGuardBlockRate: 1 } });
    const blockedReply = buildBlockedReply({ guard });
    return sendChatReply({
      response,
      emit,
      isStreaming,
      body: blockedReply,
      streamEvents: [
        { event: 'guard', data: guard },
        { event: 'done', data: blockedReply },
      ],
    });
  }

  const result = await runSupportPipeline({ request: chatRequest, guard, emit, baseUrl });
  sendChatReply({
    response,
    emit,
    isStreaming,
    body: result,
    streamEvents: [{ event: 'done', data: result }],
  });
};

/** Answers a question and sends the whole reply at once. */
export const handleChat = (context: RouteContext): Promise<void> =>
  answerChat({ context, isStreaming: false });

/** Answers a question and streams each stage as it happens. */
export const handleChatStream = (context: RouteContext): Promise<void> =>
  answerChat({ context, isStreaming: true });

/**
 * Searches the documents the caller's role may read, without writing an
 * answer. Why: it lets the page show what the search finds for a question,
 * apart from what the model does with it.
 */
export const handleSearch = async ({ request, response }: RouteContext): Promise<void> => {
  const body = await readJsonBody({ request });
  const query = String(body.query || body.q || '');
  const { searcher } = reindexer;
  const topK = Number(body.topK) || searcher.finalTopK;
  const result = await searcher.search({ query, topK, roles: resolveCallerRoles(body) });
  sendJson({ response, body: result });
};
