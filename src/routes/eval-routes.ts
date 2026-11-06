/**
 * Why this file exists: after a change, the only honest way to know answers are
 * still right is to ask the same fixed questions again. These routes run the
 * twenty golden questions through the real pipeline and report each result,
 * so a regression shows up as a failed row instead of a customer complaint.
 */
import { toChatRequest } from '../chat-request.js';
import { runGoldenEvaluation } from '../golden-eval.js';
import type { GoldenQuestion } from '../golden-questions.js';
import { GOLDEN_QUESTIONS } from '../golden-questions.js';
import type { EmitEvent } from '../http-exchange.js';
import { ignoreEvent, readJsonBody, sendJson, startEventStream } from '../http-exchange.js';
import { promptGuard } from '../runtime.js';
import { runSupportPipeline } from '../support-pipeline.js';
import type { RouteContext } from './route-types.js';

/**
 * A saved answer is reused only for a near-identical question.
 * Why: each golden question must be answered fresh. A looser threshold would
 * let one question return another's saved answer and hide a real failure.
 */
const EVAL_SEMANTIC_CACHE_THRESHOLD = 0.99;

/** Runs one golden question through the guard and the pipeline as an admin. */
const answerGoldenQuestion = async ({
  question,
  shouldUseLiveJudge,
  baseUrl,
  emit,
}: {
  question: GoldenQuestion;
  shouldUseLiveJudge: boolean;
  baseUrl: string;
  emit: EmitEvent;
}) => {
  const guard = await promptGuard.check({ query: question.question });
  const request = toChatRequest({
    body: {
      message: question.question,
      rolePreset: 'admin',
      cacheThreshold: EVAL_SEMANTIC_CACHE_THRESHOLD,
      liveJudge: shouldUseLiveJudge,
    },
  });
  return runSupportPipeline({ request, guard, emit, baseUrl });
};

/**
 * Runs the whole evaluation and answers as one JSON reply or as a stream of
 * steps. Calls the real pipeline for every question.
 * While streaming, every pipeline event is wrapped with the question's id so
 * the page can tell which of the twenty rows an event belongs to.
 */
const runEvaluation = async ({
  context,
  isStreaming,
}: {
  context: RouteContext;
  isStreaming: boolean;
}): Promise<void> => {
  const { request, response, baseUrl } = context;
  const body = await readJsonBody({ request });
  const shouldUseLiveJudge = body.liveJudge === true;
  const emit = isStreaming ? startEventStream({ response }) : ignoreEvent;

  const result = await runGoldenEvaluation({
    invoke: ({ question }) =>
      answerGoldenQuestion({
        question,
        shouldUseLiveJudge,
        baseUrl,
        emit: ({ event, data }) =>
          emit({ event: 'pipeline_step', data: { id: question.id, event, data } }),
      }),
    options: {
      judge: body.judge === true,
      liveJudge: shouldUseLiveJudge,
      canary: body.canary === true,
      onResult: ({ result: evalResult }) => emit({ event: 'eval_result', data: evalResult }),
    },
  });

  if (!isStreaming) return sendJson({ response, body: result });
  emit({ event: 'done', data: result });
  response.end();
};

/** Lists the golden questions without running them. */
export const handleEvalQuestions = ({ response }: RouteContext): void =>
  sendJson({ response, body: { questions: GOLDEN_QUESTIONS, total: GOLDEN_QUESTIONS.length } });

/** Runs the evaluation and answers once, when every question is done. */
export const handleEvalRun = (context: RouteContext): Promise<void> =>
  runEvaluation({ context, isStreaming: false });

/** Runs the evaluation and streams each question's result as it finishes. */
export const handleEvalStream = (context: RouteContext): Promise<void> =>
  runEvaluation({ context, isStreaming: true });
