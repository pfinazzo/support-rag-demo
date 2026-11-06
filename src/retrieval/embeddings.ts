/**
 * Why this file exists: search, the semantic cache and the HNSW index all
 * compare meaning, and they need text as numbers to do it. This file turns text
 * into embedding vectors and measures how close two vectors are.
 * Normally: OpenAI makes the vectors.
 * If MOCK_AI is on: a local mock makes them, so the app runs offline.
 * Without one shared place, each step could use a different vector length or a
 * different distance rule, and their scores would not match.
 */
import crypto from 'node:crypto';
import { isMockAi } from '../env.js';

/** The OpenAI model that makes the vectors in production. */
export const EMBEDDING_MODEL = 'text-embedding-3-small';

/** Length of each mock vector. OpenAI vectors have their own length. */
export const EMBEDDING_DIM = 256;

/**
 * Common words the mock ignores.
 * They say nothing about the topic. Without this list, two unrelated texts
 * would look alike because both contain "the" and "is".
 */
const MOCK_STOP = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
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
  'by',
  'with',
  'from',
  'that',
  'this',
  'it',
  'i',
  'me',
  'my',
  'we',
  'you',
  'your',
  'our',
  'their',
  'what',
  'when',
  'where',
  'which',
  'who',
  'how',
  'do',
  'does',
  'did',
  'good',
  'best',
  'very',
  'just',
  'not',
  'no',
  'yes',
  'can',
  'could',
  'would',
  'should',
]);

/**
 * Measures how closely two vectors point the same way, from -1 to 1.
 * Returns 0 if a vector is missing, empty or all zeros, or if the lengths differ.
 * Without that 0, a bad vector would give NaN and break every ranking it joins.
 */
export function cosineSimilarity({ a, b }: { a: number[]; b: number[] }): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Splits text into the lowercase words the mock counts.
 * Drops stop words and words of two letters or fewer.
 * Keeps terms like ERR_PAYMENT_402 and X-Hub-Signature-256 whole.
 */
function tokenizeForMock({ text }: { text: string }): string[] {
  const raw =
    String(text)
      .toLowerCase()
      .match(/[a-z0-9_]+(?:-[a-z0-9_]+)*/g) || [];
  return raw.filter((t) => t.length > 2 && !MOCK_STOP.has(t));
}

/**
 * Makes an offline stand-in vector for a text. The same text always gives the same vector.
 * This is not a learned model. It counts words, then adds fixed topic slots for
 * billing, sign-in, the API and data export.
 * Without the topic slots, two questions on one topic that share no words would look unrelated.
 * Used when MOCK_AI is on, and by tests.
 */
export function mockEmbed({ text, dim = EMBEDDING_DIM }: { text: string; dim?: number }): number[] {
  const vec = new Float64Array(dim);
  const tokens = tokenizeForMock({ text });
  for (const tok of tokens) {
    const h = crypto.createHash('sha256').update(tok).digest();
    /** Slots 0 to 31 stay free for the topic slots below. Word counts start at slot 32. */
    const offset = dim >= 64 ? 32 : 0;
    const idx = offset + (h.readUInt32BE(0) % (dim - offset));
    /** Each word adds this much to its slot. The topic slots below carry the meaning. */
    const weight = 1;
    vec[idx] += weight;
    vec[(idx + 1) % dim] += weight * 0.25;
    vec[(idx + dim - 1) % dim] += weight * 0.25;
  }
  /**
   * Adds the topic slots. Only vectors of 64 or more slots have room for them.
   * Texts on one topic then score close to each other, even with different words.
   */
  if (dim >= 64) {
    const t = text.toLowerCase();
    const billing = /bill|refund|invoice|payment|renewal|card|charge|402/.test(t);
    const auth = /saml|sso|certificate|password|authentication|login|mfa/.test(t);
    const api = /webhook|api|429|rate limit|signature/.test(t);
    const data = /export|gdpr|delet|workspace backup/.test(t);
    /**
     * The topic slots. Each row is: slot number, whether this text matches, weight.
     * Slots 0 to 3 are the four broad topics. Slots 4 to 12 are narrower topics inside them.
     */
    const concepts: Array<[number, boolean, number]> = [
      [0, billing, 0.78],
      [1, auth, 0.78],
      [2, api, 0.78],
      [3, data, 0.78],
      [
        4,
        /err_payment_402|\b402\b|declin|payment.*fail|fail.*payment|renewal|card charge/.test(t),
        0.64,
      ],
      [5, /refund|14.day/.test(t), 0.64],
      [6, /invoice/.test(t), 0.24],
      [7, /cert|saml/.test(t), 0.64],
      [8, /password|mfa|backup code/.test(t), 0.64],
      [9, /webhook|signature/.test(t), 0.64],
      [10, /429|rate limit/.test(t), 0.64],
      [11, /export/.test(t), 0.64],
      [12, /gdpr|delet/.test(t), 0.64],
    ];
    if (billing || auth || api || data) {
      /** Shrinks the word counts so the topic slots count for more in the final score. */
      const lexicalNorm = Math.hypot(...vec) || 1;
      for (let i = 32; i < dim; i++) vec[i] = (0.36 * vec[i]) / lexicalNorm;
      /** Word counts also spill into slots next to the one they hash to. This clears slots 0 to 31. */
      for (let i = 0; i < 32; i++) vec[i] = 0;
      for (const [axis, present, weight] of concepts) if (present) vec[axis] = weight;
    }
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) out[i] = vec[i] / norm;
  return out;
}

/**
 * Turns one text into an embedding vector.
 * Normally: sends the text to OpenAI and returns its vector.
 * If MOCK_AI is on: makes the mock vector and calls no vendor.
 * Throws if OPENAI_API_KEY is missing or OpenAI answers with an error.
 * Without the early key check, the user would see a bare 401 from OpenAI.
 */
export async function embedText({ text }: { text: string }): Promise<number[]> {
  if (isMockAi()) return mockEmbed({ text });

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      'OPENAI_API_KEY is missing. Set it in .env, or run with MOCK_AI=true for an offline dry-run.',
    );
  }
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI embeddings HTTP ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return json.data[0].embedding;
}

/**
 * Turns many texts into vectors, one at a time and in the same order.
 * Calls `onProgress` after each text so a caller can show how far along it is.
 * Makes one OpenAI request per text unless MOCK_AI is on.
 */
export async function embedMany({
  texts,
  onProgress,
}: {
  texts: string[];
  onProgress?: ({ done, total }: { done: number; total: number }) => void;
}): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    out.push(await embedText({ text: texts[i] }));
    onProgress?.({ done: i + 1, total: texts.length });
  }
  return out;
}
