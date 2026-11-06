/**
 * Why this file exists: search must find exact words such as error codes,
 * which vector search can blur. This file ranks passages by keyword match
 * using Okapi BM25, written out in plain code with no library. Codes like
 * ERR_PAYMENT_402 and X-Hub-Signature-256 stay whole words. Without it,
 * hybrid search would have only the vector half, and a question that quotes an
 * exact error code could miss the passage that names it.
 */

/**
 * BM25 term saturation. Higher values let repeated words keep adding score for longer. 1.5 is a common default.
 */
export const DEFAULT_K1 = 1.5;

/**
 * BM25 length penalty from 0 to 1. At 0.75, long passages are discounted but not too harshly. 0.75 is a common default.
 */
export const DEFAULT_B = 0.75;

/**
 * Common English words that are dropped before matching.
 * They appear in almost every passage, so they would add noise to the score.
 */
export const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'by',
  'with',
  'from',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'into',
  'than',
  'then',
  'so',
  'such',
  'can',
  'could',
  'should',
  'would',
  'will',
  'just',
  'about',
  'above',
  'after',
  'again',
  'all',
  'also',
  'am',
  'any',
  'because',
  'before',
  'below',
  'between',
  'both',
  'did',
  'do',
  'does',
  'doing',
  'down',
  'during',
  'each',
  'few',
  'further',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  'i',
  'me',
  'my',
  'myself',
  'no',
  'nor',
  'not',
  'now',
  'off',
  'once',
  'only',
  'other',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'own',
  'same',
  'she',
  'some',
  'too',
  'under',
  'until',
  'up',
  'very',
  'we',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves',
  'they',
  'them',
  'their',
  'theirs',
]);

/**
 * Splits text into lower-case words for matching.
 * Joins parts with an underscore or hyphen into one word, so error codes and header names stay whole.
 * Drops one-letter words and stopwords.
 */
export function tokenize({ text }: { text: string }): string[] {
  const raw =
    String(text)
      .toLowerCase()
      .match(/[a-z0-9]+(?:[_\-][a-z0-9]+)*/g) || [];
  return raw.filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** One matching passage: its position in the document list, and its score. */
export interface Bm25Hit {
  index: number;
  score: number;
}

/** A built index. N is the passage count and avgdl is the average passage length in words. */
export interface Bm25Index {
  search: ({ query }: { query: string }) => Bm25Hit[];
  tokenize: typeof tokenize;
  k1: number;
  b: number;
  N: number;
  avgdl: number;
}

/**
 * Builds a BM25 index over the passages in memory.
 * Counts how often each word appears in each passage and in how many passages.
 * The search function returns only passages that score above zero, best first.
 * If the query has no usable words: search returns an empty list.
 * The index is built again for every set of documents, so it does not see later changes.
 */
export function buildBm25Index({
  documents,
  opts = {},
}: {
  documents: string[];
  opts?: { k1?: number; b?: number };
}): Bm25Index {
  const k1 = opts.k1 ?? DEFAULT_K1;
  const b = opts.b ?? DEFAULT_B;
  const N = documents.length;
  const docTokens = documents.map((text) => tokenize({ text }));
  const docLens = docTokens.map((t) => t.length);
  const avgdl = docLens.reduce((s, n) => s + n, 0) / (N || 1);

  /** Document frequency: how many passages contain each word. */
  const df = new Map<string, number>();
  /** Term frequency: for each passage, how often each word appears. */
  const tfs = docTokens.map((tokens) => {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1);
    return tf;
  });

  /**
   * How rare a word is across the passages. Rare words score higher.
   * The formula never goes below zero, so a word found in most passages cannot lower a score.
   */
  function idf({ term }: { term: string }): number {
    const n = df.get(term) || 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }

  /** Scores every passage against the query and returns the matches, best first. */
  function search({ query }: { query: string }): Bm25Hit[] {
    const qTerms = tokenize({ text: query });
    if (qTerms.length === 0) return [];
    const scores = new Array<number>(N).fill(0);
    for (const term of qTerms) {
      const termIdf = idf({ term });
      for (let i = 0; i < N; i++) {
        const tf = tfs[i].get(term) || 0;
        if (tf === 0) continue;
        const dl = docLens[i] || 0;
        const denom = tf + k1 * (1 - b + b * (dl / avgdl));
        scores[i] += termIdf * ((tf * (k1 + 1)) / denom);
      }
    }
    return scores
      .map((score, index) => ({ index, score }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  return { search, tokenize, k1, b, N, avgdl };
}
