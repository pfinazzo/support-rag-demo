/**
 * Why this file exists: the citation checker must know whether a source passage
 * backs up a claim in the answer. This file runs an NLI model, a DeBERTa model
 * that runs inside our server. It reads a passage and a claim as a pair and says
 * if the passage supports the claim, contradicts it, or does not speak to it.
 * The model is called directly. A ready-made text-classification pipeline would
 * drop the second text of the pair.
 * Without it, an answer could quote a source that says the opposite.
 */
import { performance } from 'node:perf_hooks';

/** The Hugging Face model that does the NLI check. */
export const NLI_MODEL_ID = 'Xenova/nli-deberta-v3-xsmall';

/** Pins one exact upload of the model, so a newer upload cannot change its scores. */
export const NLI_REVISION = '2a4f614a701367a02d51389039afc998faeda637';

/** The NLI model's verdict on one passage and claim. */
export interface NliResult {
  modelId: string;
  /** `transformers-onnx` is the real model. `heuristic-nli-mock` is the word-overlap stand-in. */
  backend: 'transformers-onnx' | 'heuristic-nli-mock';
  /** The most likely verdict. `ERROR` means the check could not run. */
  label: 'ENTAILMENT' | 'CONTRADICTION' | 'NEUTRAL' | 'ERROR';
  /** Probability that the passage supports the claim, from 0 to 1. */
  entailment: number;
  /** Probability that the passage says the opposite, from 0 to 1. */
  contradiction: number;
  /** Probability that the passage does not speak to the claim, from 0 to 1. */
  neutral: number;
  /** True only if the label is ENTAILMENT and its probability is at least 0.55. */
  supported: boolean;
  latencyMs: number;
  /** Why the check failed. Set only when the label is `ERROR`. */
  error?: string;
}

/**
 * The model load in progress, or finished. Null until the first load starts.
 * Every caller waits on this one promise, so the model loads once.
 * If the load fails, the failure is kept and later calls fail the same way.
 */
let loading: Promise<{ tokenizer: any; model: any }> | null = null;

/** True once the model has loaded. */
let ready = false;

/** The message from the latest failed check. Null if none has failed. */
let lastError: string | null = null;

/**
 * Loads the tokenizer and the model once, and returns them.
 * On first use this downloads the model from Hugging Face into the cache folder.
 * The folder is TRANSFORMERS_CACHE, or `./.cache/transformers` if that is unset.
 * The model is the 8-bit version, which is smaller and faster. It runs on two CPU threads.
 */
async function load() {
  if (!loading)
    loading = (async () => {
      const { AutoTokenizer, AutoModelForSequenceClassification, env } =
        await import('@huggingface/transformers');
      env.cacheDir = process.env.TRANSFORMERS_CACHE || './.cache/transformers';
      env.allowLocalModels = false;
      const opts = {
        revision: NLI_REVISION,
        dtype: 'q8' as const,
        session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
      };
      const [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(NLI_MODEL_ID, opts),
        AutoModelForSequenceClassification.from_pretrained(NLI_MODEL_ID, opts),
      ]);
      ready = true;
      return { tokenizer, model };
    })();
  return loading;
}

/** Reports which NLI model is in use and whether it has loaded. A mock is always ready. */
export function nliModelStatus() {
  const mock = process.env.FORCE_MOCK_NLI === 'true';
  return {
    modelId: NLI_MODEL_ID,
    revision: NLI_REVISION,
    backend: mock ? 'heuristic-nli-mock' : 'transformers-onnx',
    ready: mock || ready,
    error: lastError,
  };
}

/**
 * Loads the NLI model ahead of time, unless the mock is on.
 * Without it, the first citation check would wait for the model to download.
 */
export async function warmupNli() {
  if (process.env.FORCE_MOCK_NLI !== 'true') await load();
}

/**
 * Measures how many words two texts share, from 0 to 1.
 * It counts each word, then takes the cosine of the two count lists.
 * Returns 0 if either text has no words.
 * It sees only the words, not their meaning. "Refunds are offered" and "Refunds are not offered" score high.
 */
export function lexicalCosine({ a, b }: { a: string; b: string }): number {
  /** Counts how often each lowercase word appears in a text. */
  const bag = ({ t }: { t: string }) => {
    const v = new Map<string, number>();
    for (const w of t.toLowerCase().match(/[a-z0-9_]+/g) || []) v.set(w, (v.get(w) || 0) + 1);
    return v;
  };
  const x = bag({ t: a }),
    y = bag({ t: b });
  let dot = 0,
    nx = 0,
    ny = 0;
  for (const [w, v] of x) {
    dot += v * (y.get(w) || 0);
    nx += v * v;
  }
  for (const v of y.values()) ny += v * v;
  return nx && ny ? dot / Math.sqrt(nx * ny) : 0;
}

/** `premise` is the source passage. `hypothesis` is the claim. `forceReal` runs the real model even when the mock is on. */
type InferNliParams = { premise: string; hypothesis: string; opts?: { forceReal?: boolean } };

/**
 * Judges whether the premise supports the hypothesis.
 * Normally: runs the NLI model on the pair and picks the likeliest of the three verdicts.
 * If FORCE_MOCK_NLI is true and `forceReal` is not set: uses a word-overlap stand-in, for tests.
 * If the check fails for any reason: does not throw. Returns the label ERROR with `supported` false.
 * A failed check then counts as unsupported. Without that, a broken model would let every claim through.
 */
export async function inferNli({
  premise,
  hypothesis,
  opts = {},
}: InferNliParams): Promise<NliResult> {
  const start = performance.now(),
    mock = !opts.forceReal && process.env.FORCE_MOCK_NLI === 'true';
  const backend = mock ? 'heuristic-nli-mock' : 'transformers-onnx';
  try {
    let scores: Record<string, number>;
    if (mock) {
      /**
       * The stand-in rules.
       * If the texts share many words and only one has a negation word: contradiction.
       * If they share enough words: entailment. Otherwise: neutral.
       */
      const similarity = lexicalCosine({ a: premise, b: hypothesis }),
        negative = ({ s }: { s: string }) => /\b(?:not|never|no|non-refundable)\b/i.test(s);
      const contradiction =
        similarity > 0.65 && negative({ s: premise }) !== negative({ s: hypothesis });
      scores = contradiction
        ? { contradiction: 0.98, entailment: 0.01, neutral: 0.01 }
        : similarity > 0.35
          ? { entailment: 0.97, contradiction: 0.01, neutral: 0.02 }
          : { neutral: 0.96, entailment: 0.02, contradiction: 0.02 };
    } else {
      const { tokenizer, model } = await load();
      /** Longer text is cut at 512 tokens. */
      const inputs = await tokenizer(premise, {
        text_pair: hypothesis,
        padding: true,
        truncation: true,
        max_length: 512,
      });
      const output = await model(inputs);
      /** Turns the model's three raw scores into probabilities that add up to 1. */
      const logits = Array.from(output.logits.data, Number),
        max = Math.max(...logits),
        exps = logits.map((v) => Math.exp(v - max)),
        sum = exps.reduce((a, b) => a + b, 0);
      scores = {};
      for (let i = 0; i < exps.length; i++) {
        const label = String(model.config.id2label[i]).toLowerCase();
        scores[label] = exps[i] / sum;
      }
      /** Fails if the model does not use the three labels we read. Without this, a wrong model would give `undefined` scores. */
      if (!['entailment', 'contradiction', 'neutral'].every((k) => Number.isFinite(scores[k])))
        throw new Error('Unexpected NLI label mapping');
    }
    const label = Object.entries(scores)
      .sort((a, b) => b[1] - a[1])[0][0]
      .toUpperCase() as NliResult['label'];
    return {
      modelId: NLI_MODEL_ID,
      backend,
      label,
      entailment: scores.entailment,
      contradiction: scores.contradiction,
      neutral: scores.neutral,
      supported: label === 'ENTAILMENT' && scores.entailment >= 0.55,
      latencyMs: performance.now() - start,
    };
  } catch (e) {
    lastError = (e as Error).message;
    return {
      modelId: NLI_MODEL_ID,
      backend,
      label: 'ERROR',
      entailment: 0,
      contradiction: 0,
      neutral: 0,
      supported: false,
      latencyMs: performance.now() - start,
      error: lastError,
    };
  }
}
