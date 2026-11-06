/**
 * Why this file exists: the pipeline page shows the real source code that did
 * each stage's work. The code is read from the files at request time. A copy
 * pasted into the page would go stale the first time someone edited the file.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from './config.js';

/** Longest snippet shown whole. Anything longer is cut and says where it continues. */
const MAX_SNIPPET_LINES = 40;

type SnippetSpec = {
  readonly title: string;
  /** File path from the project root. */
  readonly file: string;
  /** Matches the first line of the snippet. */
  readonly start: RegExp;
  /** Fixed line count, for a slice in the middle of a long function. */
  readonly lines?: number;
};

export type Snippet = {
  readonly title: string;
  readonly file: string;
  readonly startLine: number;
  readonly code: string;
};

/**
 * Which code does each stage's work. Adding a snippet means adding a row.
 * Keys match the stage ids in client/stage-player.ts.
 */
const STAGE_SNIPPETS: Record<string, readonly SnippetSpec[]> = {
  security: [
    { title: 'Unicode normalisation (NFKC) before pattern matching', file: 'src/guard/prompt-guard.ts', start: /^export function normalizeGuardText/ },
    { title: 'Regex rule scan', file: 'src/guard/prompt-guard.ts', start: /^export function regexMatch/ },
  ],
  cache: [
    { title: 'Semantic cache lookup: embed, nearest neighbour, threshold', file: 'src/query/semantic-cache.ts', start: /^ {2}async lookup\(/ },
  ],
  'query-rewrite': [
    { title: 'Heuristic gate: rewrite only when needed', file: 'src/query/query-rewriter.ts', start: /^export function evaluateRewriteGate/ },
  ],
  search: [
    { title: 'Reciprocal Rank Fusion: sum of 1 / (rank + k)', file: 'src/retrieval/search.ts', start: /const bm25RrfScore = /, lines: 3 },
    { title: 'Cross-encoder re-rank of the shortlist', file: 'src/ranking/reranker.ts', start: /^export async function rerankShortlist/ },
  ],
  context: [
    { title: 'Token budget check before the model call', file: 'src/generation/context-builder.ts', start: /^export function assertContextFits/ },
  ],
  router: [
    { title: 'Complexity-scored model selection', file: 'src/generation/model-router.ts', start: /^ {2}route\(input: RoutingInput\)/ },
  ],
  generate: [
    { title: 'Generation with fallback chain and tool loop', file: 'src/generation/generator.ts', start: /^export async function generateInfrastructure/ },
  ],
  'fact-check': [
    { title: 'Verbatim quote check', file: 'src/verification/citation-checker.ts', start: /^export function checkQuotes/ },
    { title: 'Citation verification: fetch, NLI, quote', file: 'src/verification/citation-checker.ts', start: /^export async function checkCitations/ },
  ],
  result: [
    { title: 'Confidence score that gates release', file: 'src/verification/confidence-scorer.ts', start: /^export function computeResponseConfidence/ },
  ],
};

/**
 * Cuts one snippet out of a file's lines.
 * Runs from the start line to the closing brace at the same indent.
 * Removes the start line's indent so every snippet sits at the left edge.
 * Returns null if the start line is missing, so a renamed function drops its snippet
 * instead of showing the wrong code.
 */
export const cutSnippet = ({ spec, lines }: { spec: SnippetSpec; lines: readonly string[] }): Snippet | null => {
  const startIndex = lines.findIndex((line) => spec.start.test(line));
  if (startIndex === -1) return null;
  const indent = (lines[startIndex].match(/^\s*/) || [''])[0];
  const closeIndex = lines.findIndex(
    (line, i) => i > startIndex && line.startsWith(`${indent}}`) && line.trim().match(/^}[);,]*$/) !== null,
  );
  const naturalEnd = closeIndex === -1 ? lines.length - 1 : closeIndex;
  const endIndex = spec.lines ? startIndex + spec.lines - 1 : Math.min(naturalEnd, startIndex + MAX_SNIPPET_LINES - 1);
  const shown = lines.slice(startIndex, endIndex + 1);
  const cut = !spec.lines && endIndex < naturalEnd;
  const note = cut ? [`${indent}// … ${naturalEnd - endIndex} more lines: see ${spec.file}:${endIndex + 2}`] : [];
  const margin = (shown[0].match(/^\s*/) || [''])[0].length;
  const code = [...shown, ...note].map((line) => line.slice(Math.min(margin, line.length - line.trimStart().length))).join('\n');
  return { title: spec.title, file: spec.file, startLine: startIndex + 1, code };
};

/**
 * Reads the source files and returns every stage's snippets.
 * Reads from disk. Throws if a listed file cannot be read.
 */
export const loadStageCode = async (): Promise<Record<string, Snippet[]>> => {
  const files = [...new Set(Object.values(STAGE_SNIPPETS).flatMap((specs) => specs.map(({ file }) => file)))];
  const contents = await Promise.all(
    files.map(async (file) => [file, (await readFile(path.join(PROJECT_ROOT, file), 'utf8')).split('\n')] as const),
  );
  const linesByFile = Object.fromEntries(contents);
  return Object.fromEntries(
    Object.entries(STAGE_SNIPPETS).map(([stage, specs]) => [
      stage,
      specs.flatMap((spec) => cutSnippet({ spec, lines: linesByFile[spec.file] }) || []),
    ]),
  );
};
