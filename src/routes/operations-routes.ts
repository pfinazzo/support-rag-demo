/**
 * Why this file exists: after the pipeline answers, people watch quality, clear
 * the review queue and take over conversations. These routes give the page that
 * operator view of the quality meter, the review queue and the hand-offs.
 */
import { parseConversationTurns } from '../query/conversation-turns.js';
import { readJsonBody, runOrRejectWithBadRequest, sendJson } from '../http-exchange.js';
import { humanHandoff } from '../handoff/human-handoff.js';
import { qualityMeter } from '../evals/quality-meter.js';
import { reviewQueue } from '../handoff/review-queue.js';
import type { RouteContext } from './route-types.js';

/** Shows the recent quality scores and any active alerts. */
export const handleQualityMeterState = ({ response }: RouteContext): void =>
  sendJson({ response, body: qualityMeter.status() });

/** Adds one batch of scores, healthy or deliberately degraded, so the page can show an alert firing and clearing. */
export const handleQualityMeterBatch = async ({
  request,
  response,
}: RouteContext): Promise<void> => {
  const body = await readJsonBody({ request });
  sendJson({ response, body: qualityMeter.batch({ degraded: body.degraded === true }) });
};

/** Shows the answers waiting for a person. */
export const handleReviewQueueState = ({ response }: RouteContext): void =>
  sendJson({ response, body: reviewQueue.state() });

/**
 * Approves, edits or rejects one held answer. Changes the review queue.
 * An unknown or already-resolved item is the caller's mistake, so it is a 400.
 */
export const handleReviewQueueAction = async ({
  request,
  response,
}: RouteContext): Promise<void> => {
  const body = await readJsonBody({ request });
  const answer = typeof body.answer === 'string' ? body.answer : undefined;
  const resolved = runOrRejectWithBadRequest({
    run: () =>
      reviewQueue.action({
        id: String(body.id),
        action: String(body.action),
        notes: String(body.notes || ''),
        answer,
      }),
  });
  sendJson({ response, body: resolved });
};

/** Shows the conversations that were handed to a person. */
export const handleHandoffState = ({ response }: RouteContext): void =>
  sendJson({ response, body: humanHandoff.state() });

/** Tests whether a conversation should move to a person. Creates a hand-off package when it should. */
export const handleHandoffCheck = async ({ request, response }: RouteContext): Promise<void> => {
  const body = await readJsonBody({ request });
  const handoff = humanHandoff.create({
    turns: parseConversationTurns({ value: body.turns, fieldName: 'turns' }),
    confidenceScore: Number(body.confidenceScore ?? 1),
    reviewQueueItems: Array.isArray(body.reviewQueueItems) ? body.reviewQueueItems.map(String) : [],
  });
  sendJson({ response, body: { handoff } });
};
