/**
 * Why this file exists: one customer question goes in and one checked answer
 * comes out. The steps run in a fixed order, and each step reports what it did
 * as an event, so the page can show every stage as it happens. Each step is its
 * own small function, so a reader can follow the order here and open a step
 * only when they need its detail.
 */
import type { ChatRequest } from './chat-request.js';
import { checkCitations, sourceDocUrl } from './verification/citation-checker.js';
import { computeResponseConfidence, numericFidelity } from './verification/confidence-scorer.js';
import { SHOULD_STORE_HELD_ANSWERS_IN_SEMANTIC_CACHE } from './config.js';
import { humanHandoff } from './handoff/human-handoff.js';
import type { EmitEvent } from './http-exchange.js';
import { gradeResponseWithJudge } from './evals/llm-judge.js';
import type { GenerateResult } from './generation/llm.js';
import { FALLBACK_MESSAGE, generateAnswer } from './generation/llm.js';
import type { LlmProvider } from './generation/local-claude.js';
import { getLlmProvider } from './generation/local-claude.js';
import type { ClaudeModel } from './generation/model-router.js';
import { CLAUDE_MODELS, modelRouter } from './generation/model-router.js';
import type { FullGuardReport } from './guard/prompt-guard.js';
import { prepareGuardData } from './guard/prompt-guard.js';
import { qualityMeter } from './evals/quality-meter.js';
import { evaluateRewriteGate, rewriteQuery } from './query/query-rewriter.js';
import { applyRetrievalOverrides } from './retrieval/retrieval-overrides.js';
import { reviewQueue } from './handoff/review-queue.js';
import { reindexer, semanticCache } from './runtime.js';
import { runSearchAgent } from './ranking/search-agent.js';
import type { SemanticCache } from './query/semantic-cache.js';
import type { SupportResponse } from './generation/structured-output.js';
import { responseEnvelope } from './generation/structured-output.js';
import type { ChatStepTelemetry, SearchTelemetry } from './types.js';

type PipelineParams = {
  readonly request: ChatRequest;
  readonly guard: FullGuardReport;
  readonly emit: EmitEvent;
  /** Address the page can use to fetch the documents we cite. */
  readonly baseUrl: string;
};

type SemanticCacheLookup = Awaited<ReturnType<SemanticCache['lookup']>>;

type SemanticCacheEntry = NonNullable<SemanticCacheLookup['entry']>;

type ContextSource = ReturnType<typeof buildContextSources>[number];

/** The model's answer, or a stand-in, plus the error if the model failed. */
type GenerationOutcome = { readonly generation: GenerateResult; readonly failure: Error | null };

/** The fourth security layer, which fences untrusted text. Position in the list, counting from zero. */
const DATA_SEPARATION_LAYER_INDEX = 3;

/** The same layer as the page numbers it, counting from one. */
const DATA_SEPARATION_LAYER_NUMBER = 4;

/** Why a question needs the earlier turns to make sense. Used to decide if history changes the semantic cache key. */
const HISTORY_DEPENDENT_REASONS = new Set(['unresolved_reference', 'elliptical_followup']);

const HELD_ANSWER_TEXT =
  'This response is held for operator review because no valid model output could be verified.';

/** Confidence given to a stand-in answer. Low on purpose, so it is held, never released. */
const STAND_IN_CONFIDENCE = 0.1;

const JUDGE_DIMENSIONS = ['factualAccuracy', 'citationSupport', 'tone', 'questionAnswered'];

/**
 * What the semantic cache reports about one lookup.
 * `threshold` is set last so the number shown is the one used for this lookup,
 * not the semantic cache's current default.
 */
const toSemanticCacheMetadata = ({
  lookup,
  storedEntryId = null,
}: {
  lookup: SemanticCacheLookup;
  storedEntryId?: string | null;
}) => ({
  ...lookup.telemetry,
  ...semanticCache.state({ roleKey: lookup.roleKey }),
  threshold: lookup.telemetry.threshold,
  storedEntryId,
});

/**
 * True when the question only makes sense with the earlier turns, such as
 * "how long does that take?". Why: the same words can mean two things after
 * different conversations, so such a question must not reuse a saved answer
 * from another conversation.
 */
const isHistoryDependent = ({ request }: { request: ChatRequest }): boolean =>
  evaluateRewriteGate({ query: request.message, history: request.history }).reasons.some((reason) =>
    HISTORY_DEPENDENT_REASONS.has(reason),
  );

/**
 * The text that decides which saved answers can be reused for this request.
 * It holds everything that changes the answer: the model provider, how many
 * passages are kept, the history when it matters, and the guard settings.
 * Without any one of them, a saved answer made under other settings would be reused.
 */
const buildSemanticCacheScope = ({
  request,
  provider,
  topK,
  guard,
}: {
  request: ChatRequest;
  provider: LlmProvider;
  topK: number;
  guard: FullGuardReport;
}): string =>
  JSON.stringify([
    provider,
    topK,
    isHistoryDependent({ request }) ? request.history : [],
    guard.config,
  ]);

/**
 * Records on the guard report that a saved answer was used, so no fence ran.
 * Changes the report it is given, on purpose. The prompt guard keeps this same
 * object in its list of recent checks, so the page's recent-checks panel only
 * shows "skipped by semantic cache" if the object itself is updated. Writing the
 * outcome onto a copy would leave that panel stuck on "awaiting check".
 */
const markGuardReportAsSemanticCacheHit = ({ guard }: { guard: FullGuardReport }): void => {
  Object.assign(guard.layers[DATA_SEPARATION_LAYER_INDEX], {
    status: guard.config.dataSeparation ? 'skipped' : 'off',
    reason: 'Semantic cache hit: no new LLM prompt constructed',
  });
  Object.assign(guard, { retrievalSkipped: true, llmSkipped: true });
};

/**
 * Builds the reply for a saved answer. The saved retrieval trace is emptied,
 * because showing the old question's search as if it ran for this question
 * would be wrong.
 */
const buildSemanticCacheHitAnswer = ({
  lookup,
  entry,
  request,
  guard,
}: {
  lookup: SemanticCacheLookup;
  entry: SemanticCacheEntry;
  request: ChatRequest;
  guard: FullGuardReport;
}) => {
  const retrieval = {
    ...entry.response.retrieval,
    query: request.message,
    bm25List: [],
    vectorList: [],
    rrfShortlist: [],
    fusedResults: [],
    reranked: [],
    results: [],
  };
  return {
    ...entry.response,
    retrieval,
    blockedByGuard: false,
    guard,
    dataSeparation: guard.dataSeparation,
    sources: entry.sources,
    chatStep: { ...entry.response.chatStep, contextPassedToLlm: [] },
    cache: toSemanticCacheMetadata({ lookup }),
  };
};

/** Step 2, semantic cache hit: answers from a saved answer and tells the page the later stages were skipped. */
const answerFromSemanticCache = ({
  lookup,
  entry,
  request,
  guard,
  emit,
}: {
  lookup: SemanticCacheLookup;
  entry: SemanticCacheEntry;
  request: ChatRequest;
  guard: FullGuardReport;
  emit: EmitEvent;
}) => {
  emit({ event: 'status', data: { stage: 'answering', label: 'Verified semantic cache hit' } });
  markGuardReportAsSemanticCacheHit({ guard });
  emit({
    event: 'guard_layer',
    data: {
      layerIndex: DATA_SEPARATION_LAYER_NUMBER,
      layer: 'dataSeparation',
      phase: 'cached-bypass',
      result: {
        ...guard.layers[DATA_SEPARATION_LAYER_INDEX],
        status: 'cached-bypass',
        summary: 'LLM skipped via Semantic Cache',
      },
    },
  });
  return buildSemanticCacheHitAnswer({ lookup, entry, request, guard });
};

/**
 * Steps 3 and 4: rewrites a vague question, then searches. Calls the search
 * index and sometimes a model.
 * The search runs once on the raw question first, only when a rewrite happened,
 * so the page can show how much the rewrite improved the match.
 */
const retrieveEvidence = async ({
  request,
  topK,
  guard,
  emit,
}: {
  request: ChatRequest;
  topK: number;
  guard: FullGuardReport;
  emit: EmitEvent;
}) => {
  const { searcher } = reindexer;
  const search = ({ query }: { query: string }): Promise<SearchTelemetry> =>
    searcher.search({ query, topK, roles: request.roles });

  emit({
    event: 'status',
    data: { stage: 'retrieving', label: 'Searching permitted support documents' },
  });
  const rewrite = await rewriteQuery({ query: request.message, history: request.history });
  const rawStrength = rewrite.needsRewrite
    ? (await search({ query: request.message })).maxRerankScore
    : null;
  const searchAgent = await runSearchAgent({
    query: rewrite.rewrittenQuery,
    search,
    options: {
      onPass: ({ pass }) => emit({ event: 'search_pass', data: pass }),
    },
  });
  const queryRewrite = {
    ...rewrite,
    rawStrength,
    rewrittenStrength: searchAgent.retrieval.maxRerankScore,
    retrievalLift: rawStrength === null ? 0 : searchAgent.retrieval.maxRerankScore - rawStrength,
  };
  emit({ event: 'query_rewrite', data: queryRewrite });

  const retrieval = applyRetrievalOverrides({
    retrieval: searchAgent.retrieval,
    message: request.message,
    shouldSimulatePoison: guard.config.simulateIndirectInjection,
  });
  emit({ event: 'fusing', data: { ...retrieval } });
  emit({ event: 'reranking', data: { ...retrieval } });
  return { searchAgent, queryRewrite, retrieval };
};

/**
 * The status shown for the fence layer: off when switched off, contained when
 * it caught a hidden instruction, and fenced when it ran and found none.
 */
const toFenceStatus = ({
  isEnabled,
  hasHiddenInstruction,
}: {
  isEnabled: boolean;
  hasHiddenInstruction: boolean;
}) => {
  if (!isEnabled) return 'off';
  return hasHiddenInstruction ? 'contained' : 'fenced';
};

/**
 * Step 4b, the fourth security layer: wraps the question and the found
 * documents in marked "untrusted" blocks, and records the result on the guard
 * report.
 * Changes the report it is given, on purpose. The fencing code writes its
 * result into the report, and the prompt guard keeps this same object in its
 * list of recent checks. A copy would leave the page's recent-checks panel
 * stuck on "awaiting check".
 */
const fenceRetrievedText = ({
  request,
  guard,
  retrieval,
  emit,
}: {
  request: ChatRequest;
  guard: FullGuardReport;
  retrieval: SearchTelemetry;
  emit: EmitEvent;
}): void => {
  const isEnabled = guard.config.dataSeparation;
  emit({
    event: 'guard_layer',
    data: {
      layerIndex: DATA_SEPARATION_LAYER_NUMBER,
      layer: 'dataSeparation',
      phase: 'checking',
      enabled: isEnabled,
    },
  });

  prepareGuardData({
    report: guard,
    message: request.message,
    chunks: retrieval.results,
    history: request.history,
  });

  const { dataSeparation } = guard;
  const layer = guard.layers[DATA_SEPARATION_LAYER_INDEX];
  emit({
    event: 'guard_layer',
    data: {
      layerIndex: DATA_SEPARATION_LAYER_NUMBER,
      layer: 'dataSeparation',
      phase: 'done',
      result: {
        ...layer,
        enabled: isEnabled,
        status: toFenceStatus({
          isEnabled,
          hasHiddenInstruction: dataSeparation.indirectInjectionDetected,
        }),
        fenceId: dataSeparation.fenceId,
        sanitizedBreakoutAttempts: dataSeparation.sanitizedBreakoutAttempts,
        indirectInjectionDetected: dataSeparation.indirectInjectionDetected,
        summary: layer.reason,
      },
    },
  });
};

/**
 * The message shown when nothing usable was found.
 * If the search skipped documents only because the caller's role cannot read
 * them, the message names the role that can. Otherwise it is the generic text.
 */
const buildFallbackMessage = ({ retrieval }: { retrieval: SearchTelemetry }): string => {
  const excludedChunks = retrieval.permissionReport?.excludedChunks || [];
  if (excludedChunks.length === 0) return FALLBACK_MESSAGE;

  const neededRoles = [...new Set(excludedChunks.flatMap((chunk) => chunk.chunkRoles))].join(', ');
  return `Your active role does not have permission to view the matching documentation for this question (requires role: ${neededRoles}).`;
};

/**
 * Builds an answer that does not come from the model. It carries a low
 * confidence, so the scoring step holds it for review instead of releasing it.
 */
const buildStandInGeneration = ({
  answer,
  usedMock,
  provider,
}: {
  answer: string;
  usedMock: boolean;
  provider: LlmProvider;
}): GenerateResult => ({
  answer,
  model: null,
  usedMock,
  provider,
  structuredOutput: responseEnvelope({
    answer,
    sources: [],
    extra: { confidence: STAND_IN_CONFIDENCE },
  }),
  infrastructure: undefined,
});

/** Turns anything that was thrown into an Error, so the failure can be reported with a message. */
const toError = ({ thrown }: { thrown: unknown }): Error =>
  thrown instanceof Error ? thrown : new Error(String(thrown));

/**
 * Step 7: asks the model for an answer, or builds a stand-in when there is
 * nothing to ground it on or the model fails. Calls the model and its tools.
 * A failure is turned into a held answer on purpose. The customer should wait
 * for a person, not see a raw error. The failure is returned so scoring can
 * mark the answer as not schema-valid.
 */
const generateGroundedAnswer = async ({
  request,
  retrieval,
  guard,
  provider,
  baseUrl,
  emit,
}: {
  request: ChatRequest;
  retrieval: SearchTelemetry;
  guard: FullGuardReport;
  provider: LlmProvider;
  baseUrl: string;
  emit: EmitEvent;
}): Promise<GenerationOutcome> => {
  emit({ event: 'status', data: { stage: 'answering', label: 'Generating a grounded response' } });
  emit({ event: 'answering', data: { fallback: !retrieval.relevant, llmProvider: provider } });

  if (!retrieval.relevant) {
    const answer = buildFallbackMessage({ retrieval });
    return {
      generation: buildStandInGeneration({ answer, usedMock: provider === 'mock', provider }),
      failure: null,
    };
  }

  try {
    const generation = await generateAnswer({
      message: request.message,
      history: request.history,
      chunks: retrieval.results,
      dataSeparation: guard.dataSeparation,
      infrastructureOptions: {
        roles: request.roles,
        baseUrl,
        emit,
        runtime: {
          roles: request.roles,
          baseUrl,
          search: async ({ query, topK }) => ({
            ...(await reindexer.searcher.search({ query, topK, roles: request.roles })),
          }),
        },
        faults: request.faults,
      },
    });
    return { generation, failure: null };
  } catch (thrown) {
    const failure = toError({ thrown });
    emit({ event: 'stream_error', data: { error: failure.message, recoverable: false } });
    return {
      generation: buildStandInGeneration({ answer: HELD_ANSWER_TEXT, usedMock: false, provider }),
      failure,
    };
  }
};

/** The passages given to the model, numbered in the order it saw them, each with a link to its document. */
const buildContextSources = ({
  retrieval,
  baseUrl,
}: {
  retrieval: SearchTelemetry;
  baseUrl: string;
}) =>
  retrieval.results.map((passage, position) => ({
    ...passage,
    contextId: position + 1,
    finalRank: position + 1,
    url: sourceDocUrl({ baseUrl, source: passage }),
  }));

/**
 * Finds the passage a citation points to.
 * Prefers the same file and section. Falls back to the same file, because a
 * model sometimes names a section slightly differently.
 */
const findContextSource = ({
  contextSources,
  reference,
}: {
  contextSources: ContextSource[];
  reference: SupportResponse['citedSources'][number];
}): ContextSource | undefined =>
  contextSources.find(
    (source) =>
      source.sourceFile === reference.sourceFile &&
      (!reference.sectionTitle || source.headingPath === reference.sectionTitle),
  ) || contextSources.find((source) => source.sourceFile === reference.sourceFile);

/** Joins a citation the model wrote with the passage it came from, so the checks can read the real text. */
const toCitedSource = ({
  reference,
  contextSources,
  baseUrl,
}: {
  reference: SupportResponse['citedSources'][number];
  contextSources: ContextSource[];
  baseUrl: string;
}) => {
  const known = findContextSource({ contextSources, reference });
  return {
    ...known,
    ...reference,
    sourceFile: reference.sourceFile,
    headingPath: reference.sectionTitle || known?.headingPath || '',
    prefixedText: known?.prefixedText || '',
    url:
      reference.url ||
      sourceDocUrl({
        baseUrl,
        source: { sourceFile: reference.sourceFile, headingPath: reference.sectionTitle },
      }),
  };
};

/** The search score squeezed into 0 to 1. Why: the confidence score expects a share, and raw scores can be negative. */
const calculateRetrievalStrength = ({ retrieval }: { retrieval: SearchTelemetry }): number =>
  Math.max(0, Math.min(1, retrieval.maxRerankScore));

/** Throws if the model result has no structured output. Without it there is nothing to check or score. */
const requireStructuredOutput = ({
  generation,
}: {
  generation: GenerateResult;
}): SupportResponse => {
  if (!generation.structuredOutput)
    throw new Error('The model result had no structured output to check.');
  return generation.structuredOutput;
};

/**
 * Step 8 and the scoring half of step 9: checks every citation, then scores
 * the answer. Fetches the cited pages and runs a local language-understanding model.
 */
const checkAnswer = async ({
  generation,
  failure,
  retrieval,
  contextSources,
  guard,
  baseUrl,
  emit,
}: {
  generation: GenerateResult;
  failure: Error | null;
  retrieval: SearchTelemetry;
  contextSources: ContextSource[];
  guard: FullGuardReport;
  baseUrl: string;
  emit: EmitEvent;
}) => {
  const modelOutput = requireStructuredOutput({ generation });
  const sources = modelOutput.citedSources.map((reference) =>
    toCitedSource({ reference, contextSources, baseUrl }),
  );
  const citationCheck = await checkCitations({
    answer: generation.answer,
    sources,
    options: {
      baseUrl,
      onStep: ({ event: step }) => emit({ event: 'citation_check', data: step }),
    },
  });
  const guardVerdict: SupportResponse['guardVerdict'] = guard.dataSeparation
    .indirectInjectionDetected
    ? 'contained'
    : 'clean';
  const structuredOutput: SupportResponse = {
    ...modelOutput,
    citationVerdict: citationCheck.status,
    guardVerdict,
  };
  const confidence = computeResponseConfidence({
    citation: citationCheck,
    retrievalStrength: calculateRetrievalStrength({ retrieval }),
    schemaValid: failure === null,
    numericFidelity: numericFidelity({
      answer: generation.answer,
      sources: sources.map((source) => source.prefixedText),
    }),
    modelConfidence: structuredOutput.confidence,
  });
  emit({ event: 'confidence', data: confidence });
  return { sources, citationCheck, structuredOutput, confidence };
};

/** The source list the review queue and the judge both read: file name and passage text. */
const toSourceText = ({ source }: { source: { sourceFile: string; prefixedText: string } }) => ({
  sourceFile: source.sourceFile,
  text: source.prefixedText,
});

/**
 * Step 9: holds a low-confidence answer for a person, and builds a hand-off
 * package when the conversation should move to one. Writes to the review queue
 * and the hand-off log.
 * A held answer is stored with what the model proposed, so the reviewer can approve, edit or reject it.
 */
const routeToPeople = ({
  request,
  generation,
  failure,
  checked,
  emit,
}: {
  request: ChatRequest;
  generation: GenerateResult;
  failure: Error | null;
  checked: Awaited<ReturnType<typeof checkAnswer>>;
  emit: EmitEvent;
}) => {
  const isHeld = checked.confidence.disposition === 'held_for_review';
  const review = isHeld
    ? reviewQueue.enqueue({
        input: {
          question: request.message,
          ...checked.confidence,
          originalSources: checked.sources.map((source) => toSourceText({ source })),
          proposedOutput: failure
            ? { error: String(failure), output: checked.structuredOutput }
            : checked.structuredOutput,
        },
      })
    : null;
  const handoff = humanHandoff.create({
    turns: [
      ...request.history,
      { role: 'user', content: request.message },
      {
        role: 'assistant',
        content: generation.answer,
        confidence: checked.confidence.confidenceScore,
      },
    ],
    confidenceScore: checked.confidence.confidenceScore,
    reviewQueueItems: review ? [review.id] : [],
    escalationId: checked.structuredOutput.escalationId,
  });
  if (handoff) emit({ event: 'handoff', data: handoff });
  return { isHeld, review, handoff };
};

/** The router's model names as a Set of plain text, so any string can be looked up without a type cast. */
const CLAUDE_MODEL_NAMES = new Set<string>(CLAUDE_MODELS);

/** True for a model name the router knows. A type guard takes its value directly. */
const isClaudeModel = (model: string | null): model is ClaudeModel =>
  model !== null && CLAUDE_MODEL_NAMES.has(model);

/**
 * Grades the answer on four points and reports each one. Calls a model when
 * the request asks for the live judge. Otherwise it uses fixed rules.
 */
const runJudge = async ({
  request,
  generation,
  checked,
  emit,
}: {
  request: ChatRequest;
  generation: GenerateResult;
  checked: Awaited<ReturnType<typeof checkAnswer>>;
  emit: EmitEvent;
}) => {
  emit({ event: 'judge_start', data: { dimensions: JUDGE_DIMENSIONS } });
  const judge = await gradeResponseWithJudge({
    question: request.message,
    answer: generation.answer,
    sources: checked.sources.map((source) => toSourceText({ source })),
    live: request.shouldUseLiveJudge,
    citationSupported: checked.citationCheck.status === 'verified',
  });
  Object.entries(judge.dimensions).forEach(([dimension, score]) =>
    emit({ event: 'judge_dimension', data: { dimension, ...score } }),
  );
  return judge;
};

/**
 * Feeds this answer's quality back to the router and the quality meter.
 * Changes the router's history and the meter's recent scores.
 * The router learns from the average of confidence and judge score, so a
 * model that keeps answering badly is picked less often for similar questions.
 */
const saveOutcome = ({
  request,
  generation,
  failure,
  retrieval,
  checked,
  judge,
}: {
  request: ChatRequest;
  generation: GenerateResult;
  failure: Error | null;
  retrieval: SearchTelemetry;
  checked: Awaited<ReturnType<typeof checkAnswer>>;
  judge: Awaited<ReturnType<typeof runJudge>>;
}): void => {
  if (isClaudeModel(generation.model)) {
    modelRouter.observe({
      query: request.message,
      model: generation.model,
      quality: (checked.confidence.confidenceScore + judge.overallScore) / 2,
    });
  }
  qualityMeter.record({
    sample: {
      responseConfidence: checked.confidence.confidenceScore,
      citationPassRate: checked.citationCheck.status === 'verified' ? 1 : 0,
      promptGuardBlockRate: 0,
      retrievalMatchStrength: calculateRetrievalStrength({ retrieval }),
      schemaValidationRate: failure ? 0 : 1,
      llmJudgeScore: judge.overallScore,
    },
  });
};

/**
 * True when this answer must not be saved for reuse. Each case would let a
 * later customer receive text that should not be repeated:
 * - a poisoned run, which holds text planted by the demo;
 * - a request that asked to skip the semantic cache;
 * - a hand-off, because a person is taking over the conversation;
 * - a held answer, which no person has approved.
 */
const isSemanticCacheStoreBlocked = ({
  request,
  shouldSimulatePoison,
  hasHandoff,
  isHeld,
}: {
  request: ChatRequest;
  shouldSimulatePoison: boolean;
  hasHandoff: boolean;
  isHeld: boolean;
}): boolean =>
  shouldSimulatePoison ||
  request.shouldBypassSemanticCache ||
  hasHandoff ||
  (isHeld && !SHOULD_STORE_HELD_ANSWERS_IN_SEMANTIC_CACHE);

/**
 * Answers one question, from the first security check to the stored result.
 * Emits one event per stage. Writes to the review queue, the hand-off log, the
 * quality meter, the model router and the semantic cache.
 */
export const runSupportPipeline = async ({ request, guard, emit, baseUrl }: PipelineParams) => {
  const provider = getLlmProvider();
  const topK = request.topK ?? reindexer.searcher.finalTopK;
  const shouldSimulatePoison = guard.config.simulateIndirectInjection;

  const lookup = await semanticCache.lookup({
    query: request.message,
    roles: request.roles,
    scope: buildSemanticCacheScope({ request, provider, topK, guard }),
    threshold: request.semanticCacheThreshold,
    bypass: shouldSimulatePoison || request.shouldBypassSemanticCache,
  });
  emit({ event: 'cache', data: toSemanticCacheMetadata({ lookup }) });
  emit({ event: 'guard', data: guard });

  const { entry } = lookup;
  if (entry) return answerFromSemanticCache({ lookup, entry, request, guard, emit });

  const { searchAgent, queryRewrite, retrieval } = await retrieveEvidence({
    request,
    topK,
    guard,
    emit,
  });
  fenceRetrievedText({ request, guard, retrieval, emit });
  const { generation, failure } = await generateGroundedAnswer({
    request,
    retrieval,
    guard,
    provider,
    baseUrl,
    emit,
  });

  const contextSources = buildContextSources({ retrieval, baseUrl });
  const checked = await checkAnswer({
    generation,
    failure,
    retrieval,
    contextSources,
    guard,
    baseUrl,
    emit,
  });
  const { isHeld, review, handoff } = routeToPeople({
    request,
    generation,
    failure,
    checked,
    emit,
  });
  const judge = await runJudge({ request, generation, checked, emit });
  saveOutcome({ request, generation, failure, retrieval, checked, judge });

  const chatStep: ChatStepTelemetry = {
    contextPassedToLlm: contextSources,
    usedFallback: !retrieval.relevant,
    fallbackReason: retrieval.relevant ? null : 'No relevant permitted evidence',
    model: generation.model,
    llmProvider: provider,
    usedMock: generation.usedMock,
    answer: generation.answer,
  };
  const result = {
    answer: generation.answer,
    proposedAnswer: isHeld ? generation.answer : undefined,
    releaseAllowed: !isHeld,
    releasedAnswer: isHeld ? null : generation.answer,
    reviewItem: review,
    handoff,
    confidence: checked.confidence,
    judge,
    queryRewrite,
    searchAgent: { ...searchAgent, retrieval: undefined },
    structuredOutput: checked.structuredOutput,
    infrastructure: generation.infrastructure,
    model: generation.model,
    usedMock: generation.usedMock,
    llmProvider: provider,
    fallback: !retrieval.relevant,
    retrieval,
    chatStep,
    sources: checked.sources,
    citationCheck: checked.citationCheck,
    blockedByGuard: false,
    guard,
    dataSeparation: guard.dataSeparation,
  };

  const isStoreBlocked = isSemanticCacheStoreBlocked({
    request,
    shouldSimulatePoison,
    hasHandoff: Boolean(handoff),
    isHeld,
  });
  const storedEntryId = isStoreBlocked
    ? null
    : semanticCache.store({
        lookup,
        query: request.message,
        rolePreset: request.rolePreset || request.roles.join(','),
        response: result,
      });
  return { ...result, cache: toSemanticCacheMetadata({ lookup, storedEntryId }) };
};
