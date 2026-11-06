/**
 * Why this file exists: a user message, or a retrieved document, can hide text
 * that tries to give the LLM new orders. This file runs the prompt guard's
 * classifier, a small model that scores how likely a text is such an attack.
 * MOCK_AI does not switch this model off. Only FORCE_MOCK_GUARD=true does, and
 * that is for unit tests.
 * Without it, only the word lists and regex rules would stand between an
 * attack and the LLM.
 */
import { performance } from 'node:perf_hooks';

/** A public Hugging Face copy of the Llama Prompt Guard 2 22M model, in ONNX form. */
export const GUARD_MODEL_ID = 'gravitee-io/Llama-Prompt-Guard-2-22M-onnx';

/** Pins one exact upload of the model, so a newer upload cannot change its scores silently. */
export const GUARD_MODEL_REVISION = 'da68d0f6023c7aeaf6b256eec549de295d5e8740';

/** The classifier's verdict on one text. */
export interface ClassifierResult {
  modelId: string;
  /** `transformers-onnx` is the real model. `heuristic-classifier-mock` is the test stand-in. */
  backend: 'transformers-onnx' | 'heuristic-classifier-mock';
  label: 'INJECTION' | 'BENIGN';
  /** From 0 to 1. For a long text, the highest score of any part. */
  injectionProbability: number;
  /** The probability at or above which the text is blocked. */
  threshold: number;
  blocked: boolean;
  latencyMs: number;
  /** The label the model itself gave to its top result, before we mapped it. */
  rawModelLabel?: string;
  /** Why the check failed. Set only when the check could not run. */
  error?: string;
  /** How many parts the text was cut into. */
  windowsScanned?: number;
}

/** What the model returns: a score for each of its labels. */
type Classification = Array<{ label: string; score: number }>;

/** The part of the Hugging Face pipeline we use. It classifies text, and its tokenizer counts and decodes tokens. */
type Pipeline = ((text: string, opts: object) => Promise<Classification>) & {
  tokenizer: ((
    text: string,
    opts: object,
  ) => { input_ids: { data: ArrayLike<number | bigint> } }) & {
    decode: (ids: number[], opts: object) => string;
  };
};

/**
 * The model load in progress, or finished. Null until the first load starts.
 * Every caller waits on this one promise, so the model loads once.
 */
let loading: Promise<Pipeline> | null = null;

/** True once the model has loaded. */
let ready = false;

/** The message from the latest failure. Null if there is none, or after a load succeeds. */
let lastError: string | null = null;

/** Reports which model is in use, whether it has loaded and whether it is loading. A mock is always ready. */
export function guardModelStatus() {
  const mock = process.env.FORCE_MOCK_GUARD === 'true';
  return {
    modelId: GUARD_MODEL_ID,
    revision: GUARD_MODEL_REVISION,
    backend: mock ? 'heuristic-classifier-mock' : 'transformers-onnx',
    precision: 'fp32',
    ready: mock || ready,
    loading: !mock && Boolean(loading) && !ready,
    error: lastError,
  };
}

/**
 * Loads the classifier once and returns it.
 * On first use this downloads the model from Hugging Face into the cache folder.
 * The folder is TRANSFORMERS_CACHE, or `./.cache/transformers` if that is unset.
 * It uses full 32-bit precision. The 8-bit export of this model gave scores that varied.
 */
async function load(): Promise<Pipeline> {
  if (!loading)
    loading = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = process.env.TRANSFORMERS_CACHE || './.cache/transformers';
      env.allowLocalModels = false;
      const c = await pipeline('text-classification', GUARD_MODEL_ID, {
        revision: GUARD_MODEL_REVISION,
        subfolder: '',
        model_file_name: 'model',
        dtype: 'fp32',
        session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
      });
      ready = true;
      lastError = null;
      return c as unknown as Pipeline;
    })();
  return loading;
}

/**
 * Loads the classifier ahead of time, unless the mock is on.
 * Records the error and rethrows if the load fails, so the caller can log it.
 * Without it, the first user question would wait for the model to download.
 */
export async function warmupPromptGuard(): Promise<void> {
  if (process.env.FORCE_MOCK_GUARD !== 'true') {
    try {
      await load();
    } catch (e) {
      lastError = (e as Error).message;
      throw e;
    }
  }
}

/**
 * Scores how likely a text is a prompt-injection attack and says whether to block it.
 * Blocks if the probability is at or above `threshold`.
 * If the check fails for any reason: does not throw. Returns INJECTION with probability 1 and `blocked` true.
 * A text is never let through just because the classifier broke.
 * A long text is read in parts, and the highest score wins.
 */
export async function classifyPrompt({
  text,
  threshold,
}: {
  text: string;
  threshold: number;
}): Promise<ClassifierResult> {
  const start = performance.now();
  const mock = process.env.FORCE_MOCK_GUARD === 'true';
  const backend = mock ? 'heuristic-classifier-mock' : 'transformers-onnx';
  try {
    let probability: number;
    let rawModelLabel: string | undefined;
    let windowsScanned = 1;
    if (mock) {
      /**
       * Test stand-in. It blocks texts that match known attack phrases.
       * Its result says `heuristic-classifier-mock`, so it is never mistaken for the real model.
       */
      const suspect =
        /ignore.{0,40}instructions|disregard.{0,40}rules|system override|hidden.{0,50}(initialization|instructions)|debugging.{0,100}verbatim|pretend.{0,100}(developer|policy|unrestricted)|print pwned|100% free forever|compliance mirror.{0,100}recite|unrestricted terminal assistant|important assistant rule|write OVERRIDE_ACCEPTED/i.test(
          text,
        );
      probability = suspect ? 0.98 : 0.002;
    } else {
      const c = await load();
      /**
       * The model reads at most 512 tokens. Cutting a long text would let an attack hide after the cutoff.
       * So a text over 480 tokens is read in parts of 480 tokens. Each part starts 384 tokens after the last.
       * Neighbouring parts overlap by 96 tokens, so a phrase at the edge of one part appears whole in the next.
       */
      const ids = Array.from(c.tokenizer(text, { truncation: false }).input_ids.data, Number);
      const windows: string[] = [];
      if (ids.length <= 480) windows.push(text);
      else
        for (let i = 0; i < ids.length; i += 384)
          windows.push(c.tokenizer.decode(ids.slice(i, i + 480), { skip_special_tokens: true }));
      probability = 0;
      windowsScanned = windows.length;
      for (const window of windows) {
        const result = await c(window, { top_k: null, truncation: true, max_length: 512 });
        /** Finds the model's attack label by its wording. Fails if no label looks like one. */
        const malicious = result.find((r) => /malicious|injection|jailbreak/i.test(r.label));
        if (!malicious || !Number.isFinite(malicious.score))
          throw new Error('Unexpected guard model labels');
        if (malicious.score >= probability) {
          probability = malicious.score;
          rawModelLabel = result[0]?.label;
        }
      }
    }
    const blocked = probability >= threshold;
    return {
      modelId: GUARD_MODEL_ID,
      backend,
      label: blocked ? 'INJECTION' : 'BENIGN',
      injectionProbability: probability,
      threshold,
      blocked,
      latencyMs: performance.now() - start,
      rawModelLabel,
      windowsScanned,
    };
  } catch (e) {
    /**
     * Fails closed. If the live classifier is unavailable, the text is blocked.
     * It is never replaced with the mock, which would hide the outage.
     */
    lastError = (e as Error).message;
    return {
      modelId: GUARD_MODEL_ID,
      backend,
      label: 'INJECTION',
      injectionProbability: 1,
      threshold,
      blocked: true,
      latencyMs: performance.now() - start,
      error: lastError,
    };
  }
}
