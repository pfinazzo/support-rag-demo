/**
 * Why this file exists: the page can check an answer's citations on its own,
 * without asking a question, and can run four built-in examples that each
 * fail in a different way (a good citation, a dead link, a reversed claim, a
 * made-up quote). These routes run that check and stream its steps.
 */
import type { CitationSource } from '../verification/citation-checker.js';
import { checkCitations, citationSimulation } from '../verification/citation-checker.js';
import type { EmitEvent, JsonObject } from '../http-exchange.js';
import {
  ignoreEvent,
  isJsonObject,
  readJsonBody,
  sendJson,
  startEventStream,
} from '../http-exchange.js';
import { nliModelStatus } from '../verification/nli-model.js';
import type { RouteContext } from './route-types.js';

/** The built-in examples, one per way a citation can go wrong. */
const SIMULATION_KINDS = ['pass', 'broken-url', 'negation', 'quote'];

/** Longest answer text we check. Why: the entailment model reads every sentence, so an unbounded answer is an unbounded bill in time. */
const MAX_ANSWER_CHARACTERS = 12000;

type CitationSample = { kind: string; answer: string; sources: CitationSource[] };

type SampleReport = {
  sample: string;
  answer: string;
  report: Awaited<ReturnType<typeof checkCitations>>;
};

const toOptionalText = ({ value }: { value: unknown }): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Keeps only the three fields the check reads. Anything else the caller sent is dropped. */
const toCitationSource = ({ source }: { source: JsonObject }): CitationSource => ({
  sourceFile: toOptionalText({ value: source.sourceFile }),
  headingPath: toOptionalText({ value: source.headingPath }),
  url: toOptionalText({ value: source.url }),
});

/** Reads the cited sources a request carries. Entries that are not objects are skipped. */
const parseCitationSources = ({ value }: { value: unknown }): CitationSource[] =>
  (Array.isArray(value) ? value : [])
    .filter(isJsonObject)
    .map((source) => toCitationSource({ source }));

/** Which built-in examples to run: all four, one by name, or none. */
const toSimulationKinds = ({ simulation }: { simulation: unknown }): string[] => {
  if (simulation === 'all') return SIMULATION_KINDS;
  return simulation ? [String(simulation)] : [];
};

/** The answers to check: the built-in examples when asked for, otherwise the answer in the request. */
const buildSamples = ({
  body,
  baseUrl,
}: {
  body: JsonObject;
  baseUrl: string;
}): CitationSample[] => {
  const kinds = toSimulationKinds({ simulation: body.simulation });
  if (kinds.length === 0) {
    return [
      {
        kind: 'custom',
        answer: String(body.answer || '').slice(0, MAX_ANSWER_CHARACTERS),
        sources: parseCitationSources({ value: body.sources }),
      },
    ];
  }
  return kinds.map((kind) => ({ kind, ...citationSimulation({ kind, baseUrl }) }));
};

/**
 * Checks the samples one after another. Fetches pages and runs the entailment model.
 * They run in order, not together. Their steps stream to the page as they
 * happen, and running them at once would mix the four examples on screen.
 */
const checkSamplesInOrder = ({
  samples,
  baseUrl,
  emit,
}: {
  samples: CitationSample[];
  baseUrl: string;
  emit: EmitEvent;
}): Promise<SampleReport[]> =>
  samples.reduce<Promise<SampleReport[]>>(async (previousReports, sample) => {
    const reports = await previousReports;
    const report = await checkCitations({
      answer: sample.answer,
      sources: sample.sources,
      options: {
        baseUrl,
        onStep: ({ event: step }) =>
          emit({ event: 'citation_check', data: { ...step, sample: sample.kind } }),
      },
    });
    return [...reports, { sample: sample.kind, answer: sample.answer, report }];
  }, Promise.resolve([]));

/** One report is returned flat. Several are returned together under `samples`. */
const toCitationResult = ({ reports }: { reports: SampleReport[] }) => {
  if (reports.length > 1) return { samples: reports };
  const [only] = reports;
  return { ...only.report, simulation: only.sample, answer: only.answer };
};

/** Runs one citation check and answers as one JSON reply or as a stream of steps. */
const runCitationCheck = async ({
  context,
  isStreaming,
}: {
  context: RouteContext;
  isStreaming: boolean;
}): Promise<void> => {
  const { request, response, baseUrl } = context;
  const body = await readJsonBody({ request });
  const emit = isStreaming ? startEventStream({ response }) : ignoreEvent;
  const reports = await checkSamplesInOrder({
    samples: buildSamples({ body, baseUrl }),
    baseUrl,
    emit,
  });
  const result = toCitationResult({ reports });

  if (!isStreaming) return sendJson({ response, body: result });
  emit({ event: 'done', data: result });
  response.end();
};

/** Shows whether the entailment model that judges citations has loaded. */
export const handleCitationStatus = ({ response }: RouteContext): void =>
  sendJson({ response, body: nliModelStatus() });

/** Checks citations and answers once, when every check is done. */
export const handleCitationCheck = (context: RouteContext): Promise<void> =>
  runCitationCheck({ context, isStreaming: false });

/** Checks citations and streams each step as it happens. */
export const handleCitationStream = (context: RouteContext): Promise<void> =>
  runCitationCheck({ context, isStreaming: true });
