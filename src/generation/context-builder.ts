/**
 * Why this file exists: the LLM can only read a limited number of tokens.
 * This file adds up what a prompt would hold and reports each step.
 * It shrinks the chat history when the history grows too fast or too long.
 * Without it, a long chat would overflow the model's window and the request
 * would fail.
 */
/** One message in the chat history. Tokens is filled in by buildContext. */
export interface ContextTurn {
  role: string;
  content: string;
  tokens?: number;
}

/**
 * Everything that goes into one prompt, plus the limits to fit it under.
 * A missing hardTokenLimit comes from the model's window.
 * A missing maxTokensPerTurnRate means 160 tokens per turn.
 * A missing preserveRecentTurns means 2.
 */
export interface ContextInput {
  systemPrompt: string;
  tools?: unknown[];
  retrievedChunks?: string[];
  turns?: ContextTurn[];
  question: string;
  model?: string;
  hardTokenLimit?: number;
  maxTokensPerTurnRate?: number;
  preserveRecentTurns?: number;
}

/** One line of the report that the page draws, such as a part added or the history compacted. */
export interface ContextStep {
  index: number;
  component: string;
  tokens: number;
  runningTokens: number;
  phase: 'added' | 'compacted' | 'rejected';
  recentTokensPerTurn: number;
  summary?: string;
}

/**
 * The token window of each known model.
 * A model missing from this table falls back to 32,768 tokens.
 */
export const MODEL_WINDOWS: Record<string, number> = {
  'claude-haiku-4-5': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-opus-4-6': 200000,
  'ollama/qwen2.5:1.5b': 32768,
};

/**
 * Estimates tokens as UTF-8 bytes divided by three, rounded up.
 * This is a rough guess, not a real tokenizer.
 * It only needs to be steady enough to compare a prompt against a limit.
 */
export const countTokens = ({ text }: { text: string }) =>
  Math.ceil(Buffer.byteLength(text, 'utf8') / 3);

/**
 * Thrown when the required parts of a prompt do not fit the hard token limit.
 * Carries the full report so the caller can show what was too big.
 */
export class ContextWindowExceededError extends Error {
  readonly code = 'CONTEXT_WINDOW_EXCEEDED';

  readonly report: ContextReport;

  constructor({ report }: { report: ContextReport }) {
    super('Required context does not fit hard token limit ' + report.hardTokenLimit);
    this.report = report;
  }
}

/** The full result of fitting a prompt: steps, token counts, and what compaction did. */
export interface ContextReport {
  model: string;
  tokenEstimator: string;
  steps: ContextStep[];
  runningTokens: number;
  hardTokenLimit: number;
  avgTokensPerTurn: number;
  recentTokensPerTurn: number;
  maxTokensPerTurnRate: number;
  compacted: boolean;
  triggerReason: 'growth_rate' | 'hard_window_cap' | null;
  triggerReasons: string[];
  fitsInWindow: boolean;
  before: { turns: ContextTurn[]; tokens: number };
  after: { turns: ContextTurn[]; tokens: number };
  tokensReclaimed: number;
  summary: string;
  retrievedChunks: string[];
  question: string;
  toolTokens: number;
}

/**
 * Fits a prompt under the token limit and reports each step.
 * Pure token arithmetic: calls no model.
 * Throws if the limit or the rate is not a valid number.
 * If the last six turns average more than the allowed tokens per turn: older turns become one summary turn.
 * If the prompt is still over the hard limit: all history is summarized, then the oldest turns are dropped, then retrieved chunks are shortened or dropped from the last one.
 * If the prompt still does not fit: the report says fitsInWindow is false. assertContextFits turns that into an error.
 * The onStep callback receives each step as it is made.
 * Without this, a growing chat would be sent whole and the model would reject it.
 */
export async function buildContext({
  input,
  onStep,
}: {
  input: ContextInput;
  onStep?: ({ step }: { step: ContextStep }) => void | Promise<void>;
}): Promise<ContextReport> {
  /** The hard limit: the caller's value, else the model's window, else 32,768. */
  const hard = input.hardTokenLimit ?? MODEL_WINDOWS[input.model || 'claude-haiku-4-5'] ?? 32768,
    rate = input.maxTokensPerTurnRate ?? 160;
  if (!Number.isFinite(hard) || hard < 1 || !Number.isFinite(rate) || rate < 0)
    throw new Error('Invalid context budget');
  /** The history turns with their token counts. */
  const before = (input.turns || []).map((t) => ({
    ...t,
    content: String(t.content),
    tokens: countTokens({ text: String(t.content) }),
  }));
  let turns = [...before],
    chunks = [...(input.retrievedChunks || [])];
  /** The last six turns, which measure how fast the chat is growing. */
  const recent = before.slice(-6);
  /**
   * Average tokens per turn over the last six turns.
   * If there is no history: the size of the question.
   */
  const recentRate = recent.length
    ? recent.reduce((a, t) => a + t.tokens, 0) / recent.length
    : countTokens({ text: input.question });
  /** Average tokens per turn over the whole history, for the report. */
  const avg = before.length
    ? before.reduce((a, t) => a + t.tokens, 0) / before.length
    : countTokens({ text: input.question });
  /** Tokens in a list of turns. Each turn adds four for its framing. */
  const historyTokens = ({ ts }: { ts: ContextTurn[] }) =>
    ts.reduce((a, t) => a + countTokens({ text: t.content }) + 4, 0);
  /** Tokens that never shrink: system prompt, tools, question and a 128 token framing reserve. */
  const base =
    countTokens({ text: input.systemPrompt }) +
    countTokens({ text: JSON.stringify(input.tools || []) }) +
    countTokens({ text: input.question }) +
    128;
  /** Current estimate for the whole prompt. Reads the live chunks and turns. */
  const total = () =>
    base + chunks.reduce((a, t) => a + countTokens({ text: t }), 0) + historyTokens({ ts: turns });
  const beforeTokens = total(),
    reasons: string[] = [];
  let summary = '';
  const preserve = Math.max(0, input.preserveRecentTurns ?? 2);
  /**
   * Replaces all but the last keep turns with one summary turn.
   * Returns false and changes nothing if fewer than two turns would be summarized.
   * Also returns false if the summary would not make the history smaller.
   * The summary keeps ticket and escalation ids, and the first 80 characters of each old turn.
   * The summary is cut to a third of the old text, between 40 and 600 characters.
   * Without the ids, the LLM would lose which ticket the chat is about.
   */
  const compact = ({ keep, reason }: { keep: number; reason: string }) => {
    const n = turns.length - keep;
    if (n < 2) return false;
    const old = turns.slice(0, n);
    const identifiers = [
      ...new Set(old.flatMap((t) => t.content.match(/(?:TCK|ESC)-[\w-]+/g) || [])),
    ];
    const raw =
      '[Compacted Conversation Summary]\nIdentifiers: ' +
      identifiers.join(', ') +
      '\nPrior intents and outcomes: ' +
      old.map((t) => t.role + ': ' + t.content.replace(/\s+/g, ' ').slice(0, 80)).join(' | ');
    const budget = Math.max(40, Math.min(600, old.reduce((a, t) => a + t.content.length, 0) / 3));
    summary = raw.slice(0, budget);
    const next = [
      { role: 'user', content: summary, tokens: countTokens({ text: summary }) },
      ...turns.slice(n),
    ];
    if (historyTokens({ ts: next }) >= historyTokens({ ts: turns })) return false;
    turns = next;
    if (!reasons.includes(reason)) reasons.push(reason);
    return true;
  };
  if (recentRate > rate && turns.length > preserve + 1)
    compact({ keep: preserve, reason: 'growth_rate' });
  if (total() > hard) {
    compact({ keep: 0, reason: 'hard_window_cap' });
    while (total() > hard && turns.length) {
      turns = turns.slice(1);
      if (!reasons.includes('hard_window_cap')) reasons.push('hard_window_cap');
    }
    while (total() > hard && chunks.length) {
      const last = chunks.length - 1;
      const excess = (total() - hard) * 3;
      if (chunks[last].length > excess + 80)
        chunks[last] = chunks[last].slice(0, chunks[last].length - excess - 32);
      else chunks.pop();
      if (!reasons.includes('hard_window_cap')) reasons.push('hard_window_cap');
    }
  }
  const steps: ContextStep[] = [];
  let running = 0;
  /** The five parts of the prompt, in the order the page shows them. */
  const parts = [
    ['System Prompt', countTokens({ text: input.systemPrompt }) + 128],
    ['Tool Definitions', countTokens({ text: JSON.stringify(input.tools || []) })],
    ['Retrieved Chunks', chunks.reduce((a, t) => a + countTokens({ text: t }), 0)],
    ['Conversation History', historyTokens({ ts: turns })],
    ['Current User Question', countTokens({ text: input.question })],
  ] as const;
  for (const [i, [component, tokens]] of parts.entries()) {
    running += tokens;
    const step: ContextStep = {
      index: i + 1,
      component,
      tokens,
      runningTokens: running,
      phase: 'added',
      recentTokensPerTurn: recentRate,
    };
    steps.push(step);
    await onStep?.({ step });
  }
  if (reasons.length)
    await onStep?.({
      step: {
        index: 6,
        component: 'Context Compaction',
        tokens: beforeTokens - running,
        runningTokens: running,
        phase: 'compacted',
        recentTokensPerTurn: recentRate,
        summary,
      },
    });
  const fits = running <= hard;
  if (!fits)
    await onStep?.({
      step: {
        index: 7,
        component: 'Hard Window Gate',
        tokens: 0,
        runningTokens: running,
        phase: 'rejected',
        recentTokensPerTurn: recentRate,
      },
    });
  return {
    model: input.model || 'claude-haiku-4-5',
    tokenEstimator: 'UTF-8 / 3 estimate + 128 framing reserve',
    steps,
    runningTokens: running,
    hardTokenLimit: hard,
    avgTokensPerTurn: avg,
    recentTokensPerTurn: recentRate,
    maxTokensPerTurnRate: rate,
    compacted: reasons.length > 0,
    triggerReason: reasons.includes('hard_window_cap')
      ? 'hard_window_cap'
      : reasons.length
        ? 'growth_rate'
        : null,
    triggerReasons: reasons,
    fitsInWindow: fits,
    before: { turns: before, tokens: beforeTokens },
    after: { turns, tokens: running },
    tokensReclaimed: beforeTokens - running,
    summary,
    retrievedChunks: chunks,
    question: input.question,
    toolTokens: parts[1][1],
  };
}

/** Throws ContextWindowExceededError if the report says the prompt does not fit. */
export function assertContextFits({ report }: { report: ContextReport }): void {
  if (!report.fitsInWindow) throw new ContextWindowExceededError({ report });
}
