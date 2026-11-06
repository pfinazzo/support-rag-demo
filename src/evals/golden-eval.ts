/**
 * Why this file exists: it checks the support answers against a fixed list of
 * golden questions. Each answer must contain the required facts and cite the
 * required source files. Without it, a change to prompts or retrieval could make
 * answers worse and nobody would see it until a customer did.
 */
import { GOLDEN_QUESTIONS, type GoldenQuestion } from './golden-questions.js';
import { gradeResponseWithJudge, type JudgeResult } from './llm-judge.js';

/**
 * What the pipeline produced for one golden question.
 * Only `answer` and `sources` are required. The other fields add reasons to fail.
 */
export interface EvalActual {
  answer: string;
  sources: Array<{ sourceFile: string; prefixedText?: string }>;
  fallback?: boolean;
  blockedByGuard?: boolean;
  citationCheck?: { status: string };
  structuredOutput?: unknown;
  infrastructure?: unknown;
  confidence?: { disposition: string };
  proposedAnswer?: string;
}

/**
 * Lowercases text, turns dashes into hyphens and collapses spaces.
 * Why: the model may write an en dash or a double space. Without this, a correct
 * answer would miss a required keyword over punctuation alone.
 */
const normalize = ({ s }: { s: string }) =>
  s.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

type EvaluateGoldenParams = {
  question: GoldenQuestion;
  actual: EvalActual;
  options?: { judge?: boolean; liveJudge?: boolean };
};

/**
 * Grades one answer against its golden question.
 * It passes only if every required fact and source is present and nothing else went wrong.
 * A keyword written as an array means any one of its spellings counts.
 * With `options.judge`: also asks the LLM judge for a verdict. That can call a vendor
 * when `options.liveJudge` is set.
 * Any listed reason marks the question "drifted". Without this, a quietly worse
 * answer would go unnoticed.
 */
export async function evaluateGolden({ question, actual, options = {} }: EvaluateGoldenParams) {
  const answer = actual.answer || '',
    normalized = normalize({ s: answer }),
    missingKeywords = question.requiredKeywords.filter(
      (k) => !(Array.isArray(k) ? k : [k]).some((v) => normalized.includes(normalize({ s: v }))),
    ),
    matchedKeywords = question.requiredKeywords.filter((k) => !missingKeywords.includes(k));
  const cited = new Set(actual.sources.map((s) => s.sourceFile)),
    missingSources = question.requiredSources.filter((s) => !cited.has(s)),
    matchedSources = question.requiredSources.filter((s) => cited.has(s));
  let judge: JudgeResult | null = null;
  if (options.judge)
    judge = await gradeResponseWithJudge({
      question: question.question,
      answer,
      sources: actual.sources.map((s) => ({
        sourceFile: s.sourceFile,
        text: s.prefixedText || question.expectedAnswer,
      })),
      expectedAnswer: question.expectedAnswer,
      live: options.liveJudge,
      citationSupported: actual.citationCheck?.status === 'verified',
    });
  const reasons = [
    ...(missingKeywords.length ? ['missing_required_facts'] : []),
    ...(missingSources.length ? ['missing_required_sources'] : []),
    ...(actual.blockedByGuard ? ['guard_blocked'] : []),
    ...(actual.fallback ? ['fallback'] : []),
    ...(actual.citationCheck?.status === 'flagged' ? ['citation_flagged'] : []),
    ...(judge?.overallVerdict === 'fail' ? ['judge_failed'] : []),
  ];
  return {
    id: question.id,
    question: question.question,
    expectedAnswer: question.expectedAnswer,
    actualAnswer: answer,
    status: reasons.length ? ('drifted' as const) : ('passed' as const),
    matchedKeywords,
    missingKeywords,
    matchedSources,
    missingSources,
    reasons,
    judge,
  };
}

/**
 * Runs every golden question through `invoke` and grades each answer, one at a time.
 * Calls `invoke` for each question, and the LLM judge too when `options.judge` is set.
 * If `invoke` throws: that question gets an error answer and is graded as drifted.
 * With `options.canary`: the first answer is replaced with a known-bad one.
 * A working check must then report a drift. If it does not, the check is broken.
 * `options.onResult` runs after each question so a page can show progress.
 * The `total` in the report is a fixed number, not the length of the question list.
 */
export async function runGoldenEvaluation({
  invoke,
  options = {},
}: {
  invoke: ({ question }: { question: GoldenQuestion }) => Promise<EvalActual>;
  options?: {
    judge?: boolean;
    liveJudge?: boolean;
    canary?: boolean;
    onResult?: ({
      result,
      index,
    }: {
      result: Awaited<ReturnType<typeof evaluateGolden>>;
      index: number;
    }) => void | Promise<void>;
  };
}) {
  const results = [];
  for (const [i, question] of GOLDEN_QUESTIONS.entries()) {
    let actual: EvalActual;
    try {
      actual = await invoke({ question });
    } catch (e) {
      actual = { answer: 'Pipeline error: ' + (e as Error).message, sources: [], fallback: true };
    }
    if (options.canary && i === 0)
      actual = {
        ...actual,
        answer: 'The policy has changed; no approved facts available.',
        sources: [],
      };
    const result = await evaluateGolden({ question, actual, options });
    results.push(result);
    await options.onResult?.({ result, index: i + 1 });
  }
  return {
    total: 20,
    completed: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    drifted: results.filter((r) => r.status === 'drifted').length,
    results,
  };
}
