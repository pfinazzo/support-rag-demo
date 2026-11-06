/**
 * Why this file exists: one search can miss part of a question, such as the second
 * half of a comparison. This file searches again with a narrower query until every
 * part is covered or the limit is reached. Without it, the answer would be built
 * from whatever the first search happened to find.
 */
import type { SearchTelemetry, RerankedItem } from '../types.js';

/**
 * What one round of searching found, shown to the page as the search runs.
 * `confidence` runs from 0 to 1. `refinedQuery` is the next query, or null if it stopped.
 */
export interface SearchPass {
  iteration: number;
  query: string;
  snippets: Array<{ id: string; sourceFile: string; text: string; contextHeader?: string }>;
  confidence: number;
  missingFacets: string[];
  refinedQuery: string | null;
  terminationReason: 'confident' | 'refining' | 'max_iterations';
}

/** `search` runs one search and returns its results. `options.facets` replaces the automatic split. */
type RunSearchAgentParams = {
  query: string;
  search: ({ query }: { query: string }) => Promise<SearchTelemetry>;
  options?: {
    maxIterations?: number;
    onPass?: ({ pass }: { pass: SearchPass }) => void | Promise<void>;
    facets?: string[];
  };
};

/**
 * Searches repeatedly until every part of the question is covered, or the limit is hit.
 * Calls `search` once per round and calls `options.onPass` after each round.
 * Rounds: at least 1 and at most 4. The default is 4.
 * The question is split into parts. A comparison such as "A versus B" splits at the
 * "and", "versus" or "vs". Any other question is one part.
 * A part is covered when a result's heading or text contains one of its words of 3
 * or more characters.
 * Confidence is the share of parts covered, times the best reranker score.
 * If every part is covered and confidence is at least 0.55: stops as "confident".
 * If a part is missing: the next round searches for the first missing part.
 * If the limit is reached: stops as "max_iterations".
 * Results from all rounds are merged by id. A later round replaces an earlier one.
 * Without the extra rounds, a part of the question with no good match would be
 * answered from unrelated passages.
 */
export async function runSearchAgent({ query, search, options = {} }: RunSearchAgentParams) {
  const max = Math.min(4, Math.max(1, options.maxIterations ?? 4));
  const facets =
    options.facets ||
    (/compare|difference|versus|\bvs\b/i.test(query)
      ? query
          .replace(/compare|difference between/gi, '')
          .split(/\band\b|\bversus\b|\bvs\b/i)
          .map((s) => s.trim())
          .filter(Boolean)
      : [query]);
  const passes: SearchPass[] = [],
    collected = new Map<string, RerankedItem>();
  let current = query,
    last!: SearchTelemetry;
  const covered = new Set<number>();
  for (let iteration = 1; iteration <= max; iteration++) {
    last = await search({ query: current });
    last.results.forEach((c) => collected.set(c.id, c));
    for (const [i, facet] of facets.entries()) {
      const words = facet.toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
      if (
        last.results.some((c) =>
          words.some((w) => (c.headingPath + ' ' + c.prefixedText).toLowerCase().includes(w)),
        )
      )
        covered.add(i);
    }
    const missing = facets.filter((_, i) => !covered.has(i));
    const strength = Math.max(0, Math.min(1, last.maxRerankScore));
    const confidence = (covered.size / facets.length) * strength;
    const stop = missing.length === 0 && confidence >= 0.55;
    const refined = stop ? null : missing[0] || facets[iteration % facets.length];
    const pass: SearchPass = {
      iteration,
      query: current,
      snippets: last.results.map((c) => ({
        id: c.id,
        sourceFile: c.sourceFile,
        text: c.prefixedText.slice(0, 480),
        contextHeader: c.contextHeader,
      })),
      confidence,
      missingFacets: missing,
      refinedQuery: refined,
      terminationReason: stop ? 'confident' : iteration === max ? 'max_iterations' : 'refining',
    };
    passes.push(pass);
    await options.onPass?.({ pass });
    if (stop) break;
    current = refined!;
  }
  return {
    passes,
    iterations: passes.length,
    terminationReason: passes.at(-1)!.terminationReason,
    retrieval: { ...last, results: [...collected.values()], relevant: collected.size > 0 },
    confidence: passes.at(-1)!.confidence,
  };
}
