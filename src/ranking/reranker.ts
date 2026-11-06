/**
 * Why this file exists: search returns a rough shortlist, and the best
 * passage is often not first. This file re-scores each shortlist item against
 * the question with a cross-encoder reranker and picks the few to send to the
 * LLM. Without it, the LLM would get the shortlist in its rough order.
 *
 * The scorer is chosen at run time:
 * - If MOCK_AI is true: a fixed scoring rule, so tests are instant.
 * - If COHERE_API_KEY is set: the Cohere rerank API.
 * - Otherwise: a local ONNX cross-encoder, which needs no API key.
 *   USE_LOCAL_RERANKER=true forces this one.
 */
import { isMockAi, envNumber } from '../env.js';
import type { RerankedItem, RrfShortlistItem } from '../types.js';

/**
 * The local cross-encoder, an ONNX model run through transformers.js.
 * It installs cleanly, loads in about a second, and scores each question and passage pair with a real neural model.
 */
export const LOCAL_RERANKER_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';

/** The Cohere model used when COHERE_RERANK_MODEL is not set. */
export const COHERE_RERANK_MODEL = 'rerank-v3.5';

/**
 * The lowest reranker score a passage may have and still go to the LLM.
 * A passage below it is dropped, even if it ranks in the top few.
 * The scale is the cross-encoder's raw score, so the value fits the local model.
 */
export const DEFAULT_MIN_RERANK_SCORE = -2.5;

/** How many passages go to the LLM when FINAL_TOP_K is not set. */
export const DEFAULT_FINAL_TOP_K = 3;

/**
 * How many passages reciprocal rank fusion hands to the reranker when SHORTLIST_TOP_K is not set.
 */
export const DEFAULT_SHORTLIST_TOP_K = 8;

/** The three scorers the reranker can use. */
export type RerankerBackend = 'mock' | 'cohere' | 'xenova-minilm';

/**
 * The local model, loaded once on first use.
 * A shared promise means that two early questions wait for one load instead of starting two.
 */
let xenovaReady: Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tokenizer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any;
}> | null = null;

/**
 * Picks the scorer from the environment.
 * USE_LOCAL_RERANKER wins, then mock mode, then a Cohere key, then the local model.
 */
export function resolveRerankerBackend(): RerankerBackend {
  if (process.env.USE_LOCAL_RERANKER === 'true') return 'xenova-minilm';
  if (isMockAi()) return 'mock';
  if (process.env.COHERE_API_KEY) return 'cohere';
  return 'xenova-minilm';
}

/**
 * Loads the local tokenizer and model once and returns them.
 * Downloads the model on the first run and caches it on disk.
 * Local model files are not used, so the model always comes from the Hugging Face download.
 */
async function loadXenova() {
  if (!xenovaReady) {
    xenovaReady = (async () => {
      const { AutoTokenizer, AutoModelForSequenceClassification, env } =
        await import('@huggingface/transformers');
      env.cacheDir = process.env.TRANSFORMERS_CACHE || './.cache/transformers';
      env.allowLocalModels = false;
      const tokenizer = await AutoTokenizer.from_pretrained(LOCAL_RERANKER_MODEL);
      const model = await AutoModelForSequenceClassification.from_pretrained(LOCAL_RERANKER_MODEL);
      return { tokenizer, model };
    })();
  }
  return xenovaReady;
}

/**
 * Reads the first score from the model output.
 * The output may be a tensor, a plain array or a number, so this checks each shape.
 * If the output is empty: returns 0.
 */
function firstLogit({ logits }: { logits: unknown }): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = logits as any;
  if (!t) return 0;
  if (typeof t.data === 'function') {
    const data = t.data();
    return Number(Array.from(data as ArrayLike<number>)[0] ?? 0);
  }
  if (t.data) return Number(Array.from(t.data as ArrayLike<number>)[0] ?? 0);
  if (typeof t.tolist === 'function') {
    const list = t.tolist();
    const flat = Array.isArray(list[0]) ? list[0] : list;
    return Number(flat[0] ?? 0);
  }
  if (Array.isArray(t)) return Number(t[0] ?? 0);
  return Number(t);
}

/**
 * Scores one passage against the question with the local cross-encoder.
 * Higher means a better match.
 * The question and passage are cut to the model's input length.
 */
async function scoreWithXenova({
  query,
  document,
}: {
  query: string;
  document: string;
}): Promise<number> {
  const { tokenizer, model } = await loadXenova();
  const inputs = tokenizer(query, {
    text_pair: document,
    padding: true,
    truncation: true,
  });
  const output = await model(inputs);
  return firstLogit({ logits: output.logits });
}

/**
 * Scores all passages against the question with one Cohere rerank request.
 * Calls the Cohere API.
 * Throws if the key is missing or Cohere replies with an error.
 * A passage Cohere does not return gets negative infinity, so it ranks last.
 */
async function scoreWithCohere({
  query,
  documents,
}: {
  query: string;
  documents: string[];
}): Promise<number[]> {
  const key = process.env.COHERE_API_KEY;
  if (!key) throw new Error('COHERE_API_KEY missing');
  const res = await fetch('https://api.cohere.com/v2/rerank', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: process.env.COHERE_RERANK_MODEL || COHERE_RERANK_MODEL,
      query,
      documents,
      top_n: documents.length,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cohere rerank HTTP ${res.status}: ${body}`);
  }
  const json = (await res.json()) as {
    results: Array<{ index: number; relevance_score: number }>;
  };
  const scores = new Array<number>(documents.length).fill(-Infinity);
  for (const r of json.results) {
    scores[r.index] = r.relevance_score;
  }
  return scores;
}

/**
 * Scores a passage with fixed rules instead of a model.
 * Exact error codes and instruction wording lift a passage that fusion ranked lower.
 * This shows rank changes in the demo and keeps tests fast.
 * The same input always gives the same score.
 */
export function mockCrossEncoderScore({
  query,
  document,
}: {
  query: string;
  document: string;
}): number {
  const q = query.toLowerCase();
  const d = document.toLowerCase();
  const qTokens = new Set(
    (q.match(/[a-z0-9_]+(?:-[a-z0-9]+)*/g) || []).filter((t) => t.length > 2),
  );
  const dTokens = d.match(/[a-z0-9_]+(?:-[a-z0-9]+)*/g) || [];
  const dSet = new Set(dTokens);

  /** Starting score before bonuses. */
  let score = -4;

  /** Identifiers in the question, such as error codes and the webhook signature header. */
  const ids =
    q.match(/[a-z]*_?[a-z]+_\d+|\d{3}|x-hub-signature-256|saml_cert_expired|err_payment_402/gi) ||
    [];
  for (const id of ids) {
    if (d.includes(id.toLowerCase())) score += 6.5;
  }

  /** Topic words that earn a bonus when both the question and the passage contain them. */
  const phrases = [
    'expired',
    'certificate',
    'saml',
    'rotate',
    'rotation',
    'webhook',
    'signature',
    'hmac',
    'verify',
    'verification',
    'refund',
    'proration',
    'invoice',
    'grace',
    'deletion',
    'rate limit',
    'retry-after',
    'backup codes',
    'ownership',
  ];
  for (const p of phrases) {
    if (q.includes(p) && d.includes(p)) score += 1.8;
  }

  /** Counts words that the question and passage share. */
  let overlap = 0;
  for (const t of qTokens) if (dSet.has(t)) overlap++;
  score += overlap * 0.55;

  /** True if the question asks how to do something. */
  const intent = /\b(how|verify|rotate|fix|resolve|update|download|export|delete|transfer)\b/i.test(
    q,
  );
  /** True if the passage reads like steps to follow. */
  const instructional =
    /\b(click|open|settings|steps?|1\.|to resolve|to verify|upload|paste)\b/i.test(d);
  if (intent && instructional) score += 2.2;

  /** The first line of the passage, which holds its topic. */
  const topicLine = (document.split('\n')[0] || '').toLowerCase();
  for (const t of qTokens) {
    if (topicLine.includes(t)) score += 0.7;
  }

  score -= Math.min(1.5, document.length / 4000);

  return score;
}

/** Settings that override the environment for one rerank call. */
export interface RerankOptions {
  minRerankScore?: number;
  finalTopK?: number;
  backend?: RerankerBackend;
}

/** Inputs for reranking one shortlist. */
type RerankShortlistParams = { query: string; shortlist: RrfShortlistItem[]; opts?: RerankOptions };

/**
 * Re-ranks the shortlist and returns every item with its new score and rank.
 * Calls Cohere or the local model, depending on the scorer.
 * rankDelta is the old rank minus the new rank, so a positive number means the item moved up.
 * keptForLlm is true only if the item scores at least the minimum and ranks within the final top K.
 * An empty shortlist returns an empty list.
 * Without the minimum score, weak passages would reach the LLM just because they ranked near the top.
 */
export async function rerankShortlist({
  query,
  shortlist,
  opts = {},
}: RerankShortlistParams): Promise<{
  items: RerankedItem[];
  backend: RerankerBackend;
  maxRerankScore: number;
}> {
  const backend = opts.backend ?? resolveRerankerBackend();
  const minRerankScore =
    opts.minRerankScore ??
    envNumber({ name: 'MIN_RERANK_SCORE', fallback: DEFAULT_MIN_RERANK_SCORE });
  const finalTopK =
    opts.finalTopK ?? envNumber({ name: 'FINAL_TOP_K', fallback: DEFAULT_FINAL_TOP_K });

  if (shortlist.length === 0) {
    return { items: [], backend, maxRerankScore: 0 };
  }

  let scores: number[];
  if (backend === 'mock') {
    scores = shortlist.map((c) => mockCrossEncoderScore({ query, document: c.prefixedText }));
  } else if (backend === 'cohere') {
    scores = await scoreWithCohere({ query, documents: shortlist.map((c) => c.prefixedText) });
  } else {
    scores = [];
    for (const c of shortlist) {
      scores.push(await scoreWithXenova({ query, document: c.prefixedText }));
    }
  }

  const paired = shortlist.map((c, i) => ({ chunk: c, score: scores[i] ?? -Infinity }));
  paired.sort((a, b) => b.score - a.score);

  const maxRerankScore = paired.length ? paired[0].score : 0;

  const items: RerankedItem[] = paired.map((p, i) => {
    const rerankRank = i + 1;
    const rankDelta = p.chunk.rrfRank - rerankRank;
    const passesFloor = p.score >= minRerankScore;
    const keptForLlm = passesFloor && rerankRank <= finalTopK;
    /** Text for the rank change, such as "↑ +2". */
    const arrow = rankDelta > 0 ? `↑ +${rankDelta}` : rankDelta < 0 ? `↓ ${rankDelta}` : '· 0';
    return {
      ...p.chunk,
      rerankScore: p.score,
      rerankRank,
      rankDelta,
      keptForLlm,
      rerankFormula: `CE(${backend})=${p.score.toFixed(4)} · RRF#${p.chunk.rrfRank}→CE#${rerankRank} (${arrow})`,
    };
  });

  return { items, backend, maxRerankScore };
}

/**
 * Loads the local model ahead of time.
 * Does nothing for the mock and Cohere scorers.
 * Without it, the first question would wait for the model to load.
 */
export async function warmupReranker(): Promise<void> {
  if (resolveRerankerBackend() !== 'xenova-minilm') return;
  await loadXenova();
}
