/**
 * Why this file exists: the answer step can run on several providers, and
 * tests and offline runs have none. This file holds the system prompt and one
 * path for each provider, plus a plain answer built from the top passages.
 * Without it, a missing API key or a failed provider would leave the user with
 * no answer at all.
 *
 * The provider comes from getLlmProvider and does not depend on MOCK_AI,
 * which only affects embeddings. The providers are:
 * - local-claude: the Claude Code CLI on this machine.
 * - anthropic-api: the Anthropic Messages API.
 * - openai: the OpenAI chat API.
 * - mock: an answer built from the top retrieved passages, with no LLM.
 */
import { getLlmProvider, generateWithLocalClaude, type LlmProvider } from './local-claude.js';
import type { ChatHistoryTurn, RerankedItem } from '../types.js';
import {
  buildDataSeparation,
  naiveMatch,
  regexMatch,
  type DataSeparation,
} from '../guard/prompt-guard.js';

/** The Anthropic model used when ANTHROPIC_MODEL is not set. */
export const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

/**
 * The answer given when no passage is available to this user's role.
 * The LLM is not called in that case, so it cannot make up an answer.
 */
export const FALLBACK_MESSAGE =
  'No matching support documentation is available for this question under your active role.';

/**
 * The base instructions sent to the LLM with every question.
 * They limit the LLM to facts in the context blocks and ask for a short, direct answer.
 * The data fence rule is added to them when data separation is on.
 */
export const SYSTEM_PROMPT = `You are Example Cloud's support assistant answering a customer directly.

Rules:
- Answer ONLY using facts from the <context> blocks.
- Give the actual, direct, actionable answer right away in 2 to 4 clear sentences (or a short numbered list of steps when appropriate).
- Do NOT include any sign-off, escalation footer, "
- Do NOT start with "According to …", document titles, Markdown headings (#), or meta commentary about retrieval, chunks, or AI.
- Do not invent policies, URLs, or error codes not present in <context>.`;

/** Inputs for one answer: the question, the history, and the passages to answer from. */
export interface GenerateArgs {
  message: string;
  history?: ChatHistoryTurn[];
  chunks: RerankedItem[];
  dataSeparation?: DataSeparation;
  infrastructureOptions?: import('./generator.js').InfrastructureOptions;
}

/**
 * One generated answer, with the model and provider that produced it.
 * usedMock is true when no LLM wrote the answer.
 */
export interface GenerateResult {
  answer: string;
  model: string | null;
  usedMock: boolean;
  provider: LlmProvider;
  infrastructure?: Awaited<
    ReturnType<typeof import('./generator.js').generateInfrastructure>
  >['infrastructure'];
  structuredOutput?: import('./structured-output.js').SupportResponse;
}

/**
 * Builds the user prompt without a data fence: context blocks, then the question.
 * Used only when data separation is off, so planted text in a passage is not marked as untrusted.
 */
function buildUserPrompt({ message, chunks }: { message: string; chunks: RerankedItem[] }): string {
  const contextBlocks = chunks
    .map(
      (c, i) =>
        `<context id="${i + 1}" source="${c.sourceFile}" section="${c.headingPath}">\n${c.prefixedText}\n</context>`,
    )
    .join('\n\n');
  return `${contextBlocks}\n\nCustomer question: ${message}`;
}

/**
 * Answers the question with the chosen provider.
 * Calls the provider's API or CLI.
 * If there are no passages: returns the fallback message and calls no LLM.
 * If the local Claude CLI fails: logs a warning and returns the passage-based answer.
 * If the Anthropic key is missing: returns the passage-based answer.
 * Throws if the OpenAI key is missing, or if the OpenAI or Anthropic API replies with an error.
 * With data separation on, the fenced payload carries the history, so the Anthropic path adds no history turns.
 * At most 600 tokens are requested.
 */
export async function generateLegacyAnswer(args: GenerateArgs): Promise<GenerateResult> {
  const { message, history = [], chunks } = args;
  const provider = getLlmProvider();
  const separation =
    args.dataSeparation || buildDataSeparation({ query: message, chunks, history, enabled: true });
  const systemPrompt =
    SYSTEM_PROMPT + (separation.enabled ? '\n\n' + separation.systemInstruction : '');
  separation.systemPrompt = systemPrompt;
  const userPrompt = separation.enabled
    ? separation.fencedPayload
    : buildUserPrompt({ message, chunks });
  /**
   * The passages for the passage-based answer, with attack lines removed when data separation is on.
   * That answer cannot tell data from orders, so it must never copy a planted instruction into its text.
   */
  const offlineChunks = separation.enabled
    ? chunks.map((c) => ({
        ...c,
        prefixedText: c.prefixedText
          .split('\n')
          .filter((line) => !naiveMatch({ text: line }) && !regexMatch({ text: line }))
          .join('\n'),
      }))
    : chunks;

  if (!chunks || chunks.length === 0) {
    return {
      answer: FALLBACK_MESSAGE,
      model: null,
      usedMock: provider === 'mock',
      provider,
    };
  }

  if (provider === 'local-claude') {
    try {
      const { answer, model } = await generateWithLocalClaude({
        systemPrompt,
        userPrompt,
        model: process.env.CLAUDE_LOCAL_MODEL || null,
      });
      return { answer: stripBoilerplate({ text: answer }), model, usedMock: false, provider };
    } catch (err) {
      console.warn(
        'Local Claude generation failed; falling back to clean synthesizer:',
        (err as Error).message,
      );
      return {
        answer: mockAnswer({ chunks: offlineChunks }),
        model: 'clean-extractive-fallback',
        usedMock: true,
        provider: 'mock',
      };
    }
  }

  if (provider === 'mock') {
    return {
      answer: mockAnswer({ chunks: offlineChunks }),
      model: 'clean-extractive',
      usedMock: true,
      provider,
    };
  }

  if (provider === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is required for the OpenAI answer provider');
    const model = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 600,
      }),
    });
    if (!response.ok) throw new Error(`OpenAI answer HTTP ${response.status}`);
    const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    return {
      answer: stripBoilerplate({ text: data.choices[0]?.message.content || '' }),
      model,
      usedMock: false,
      provider,
    };
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return {
      answer: mockAnswer({ chunks: offlineChunks }),
      model: 'clean-extractive',
      usedMock: true,
      provider: 'mock',
    };
  }
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const turn of history.slice(-6)) {
    if (!turn?.content) continue;
    if (separation.enabled) continue;
    const role = turn.role === 'assistant' ? 'assistant' : 'user';
    messages.push({ role, content: String(turn.content) });
  }
  messages.push({ role: 'user', content: userPrompt });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      system: systemPrompt,
      messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic HTTP ${res.status}: ${body}`);
  }
  const json = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const answer = (json.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text || '')
    .join('\n')
    .trim();
  return { answer: stripBoilerplate({ text: answer }), model, usedMock: false, provider };
}

/** Removes a stray "Does that not answer your question?" line from the LLM's reply. */
function stripBoilerplate({ text }: { text: string }): string {
  return text.replace(/Does that not answer your question\?[^\n]*/gi, '').trim();
}

/**
 * Builds an answer from the top passages without calling an LLM.
 * Normally: uses the first passage with a how-to heading, else the first with numbered steps, else the top passage.
 * Used for tests, offline runs and as the fallback when a provider fails.
 * Without it, those cases would return nothing.
 */
export function mockAnswer({ chunks }: { chunks: RerankedItem[] }): string {
  const best =
    chunks.find((c) =>
      /\b(how to|rotating|uploading|recovering|downloading)\b/i.test(c.headingPath),
    ) ||
    chunks.find((c) => /^\s*1\.\s+/m.test(c.prefixedText)) ||
    chunks[0];

  return cleanChunkToAnswer({
    primaryPrefixed: best.prefixedText,
    leadPrefixed: chunks[0]?.prefixedText || '',
  });
}

/**
 * Turns a passage into plain answer text with no headings, code blocks or bold marks.
 * If the passage has numbered steps: starts with one summary line, then the steps.
 * If the passage is prose only: returns its first three lines.
 * The summary line comes from the top passage when the steps passage lacks one, and only if under 220 characters.
 */
function cleanChunkToAnswer({
  primaryPrefixed,
  leadPrefixed,
}: {
  primaryPrefixed: string;
  leadPrefixed: string;
}): string {
  /** Removes the topic line, code blocks, and bold and code marks from a passage. */
  const strip = ({ s }: { s: string }) =>
    s
      .replace(/^Topic:.*\n\n/, '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1');

  const primary = strip({ s: primaryPrefixed });
  const lead = primaryPrefixed !== leadPrefixed ? strip({ s: leadPrefixed }) : '';

  /** Splits a passage into lines and drops headings and filler openers such as "Users see". */
  const cleanLines = ({ block }: { block: string }) =>
    block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          !/^#{1,6}\s/.test(l) &&
          !/^(the dashboard shows|users? see|admins? receive|use this guide when)\b/i.test(l),
      );

  const lines = cleanLines({ block: primary });
  const numbered = lines.filter((l) => /^\d+\.\s+/.test(l));
  const prose = lines.filter((l) => !/^\d+\.\s+/.test(l));

  let intro = '';
  if (numbered.length > 0 && lead) {
    const leadFirst = cleanLines({ block: lead })[0] || '';
    if (leadFirst && leadFirst.length < 220) intro = leadFirst;
  } else if (prose.length > 0) {
    intro = prose[0];
  }

  if (numbered.length > 0) {
    const rest = prose.slice(intro === prose[0] ? 1 : 0, 2).join(' ');
    return [intro, numbered.join('\n'), rest].filter(Boolean).join('\n\n').trim();
  }

  return lines.slice(0, 3).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Answers the question through the generator module's infrastructure path.
 * The generator is loaded on demand, because the generator module also imports this file.
 */
export async function generateAnswer(args: GenerateArgs): Promise<GenerateResult> {
  const { generateInfrastructure } = await import('./generator.js');
  return generateInfrastructure(args, args.infrastructureOptions);
}
