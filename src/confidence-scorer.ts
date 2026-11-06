/**
 * Why this file exists: a support answer should only go straight to the customer if
 * we trust it. This file turns the citation checks, retrieval strength and other
 * signals into one confidence score. An answer below the threshold is held for a
 * person to review. Without it, a wrong or unsupported answer would be sent as if
 * it were fine.
 */
/**
 * The checks that feed the confidence score.
 * `citation` holds the results of the URL check, the NLI model and the quote check.
 * `retrievalStrength` and `coverage` run from 0 to 1. `releaseThreshold` defaults to 0.72.
 */
export interface ConfidenceInput {
  citation?: {
    urlCheck?: { passed: boolean };
    entailmentCheck?: { passed: boolean };
    quoteCheck?: { passed: boolean };
    rows?: Array<{
      entailmentCheck: {
        claims: Array<{
          claim?: string;
          label: string;
          entailment: number;
          contradiction?: number;
          supported?: boolean;
        }>;
      };
    }>;
  };
  retrievalStrength: number;
  coverage?: number;
  schemaValid: boolean;
  numericFidelity?: number;
  modelConfidence?: number;
  releaseThreshold?: number;
}

/**
 * Combines the checks into one score from 0 to 1 and decides release or review.
 * The score is a weighted sum of five signals: citation support 0.4, retrieval 0.25,
 * schema 0.15, numeric fidelity 0.1 and the model's own confidence 0.1.
 * Some failures cap the score, whatever the weights say. A contradiction caps it at 0.35.
 * An invalid schema caps it at 0.2. Mismatched numbers cap it at 0.4.
 * A bad URL or a missing quote caps it at 0.6.
 * Why: a good average must not hide one serious fault, such as a wrong price.
 * A claim counts as contradicted only if no other row supports the same claim.
 * If the NLI model gave no claims: citation support is 1 when the entailment check
 * passed, otherwise 0.55.
 * Score at or above the threshold: auto_released. Otherwise: held_for_review.
 * Throws if the threshold is not a number from 0 to 1.
 */
export function computeResponseConfidence(input: ConfidenceInput) {
  const threshold = input.releaseThreshold ?? 0.72;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    throw new Error('Invalid release threshold');
  const allNli = input.citation?.rows?.flatMap((r) => r.entailmentCheck.claims) || [];
  const contradiction = allNli.some(
    (c) =>
      (c.label === 'CONTRADICTION' || (c.contradiction ?? 0) > 0.55) &&
      !allNli.some((other) => other.claim === c.claim && other.supported),
  );
  const reasons: string[] = [];
  if (contradiction) reasons.push('citation_contradiction');
  if (input.citation?.urlCheck?.passed === false) reasons.push('citation_url_invalid');
  if (input.citation?.quoteCheck?.passed === false) reasons.push('quote_missing');
  if (!input.schemaValid) reasons.push('schema_validation_failed');
  if (input.retrievalStrength < 0.3) reasons.push('weak_retrieval');
  if ((input.numericFidelity ?? 1) < 0.8) reasons.push('invoice_parse_mismatch');
  const clamp = ({ n }: { n: number }) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
  const claims = input.citation?.rows?.flatMap((r) => r.entailmentCheck.claims) || [];
  const byClaim = new Map<string, number>();
  for (const c of claims as Array<{ claim?: string; entailment: number }>) {
    const key = c.claim || String(byClaim.size);
    byClaim.set(key, Math.max(byClaim.get(key) || 0, c.entailment));
  }
  const nliStrength = byClaim.size
    ? [...byClaim.values()].reduce((a, b) => a + b, 0) / byClaim.size
    : null;
  const signals = {
    citationSupport: {
      weight: 0.4,
      value: contradiction
        ? 0
        : nliStrength !== null
          ? nliStrength
          : input.citation?.entailmentCheck?.passed?.valueOf()
            ? 1
            : 0.55,
    },
    retrieval: {
      weight: 0.25,
      value: clamp({ n: input.retrievalStrength }) * (input.coverage ?? 1),
    },
    schema: { weight: 0.15, value: input.schemaValid ? 1 : 0 },
    numericFidelity: { weight: 0.1, value: input.numericFidelity ?? 1 },
    modelSelfReport: { weight: 0.1, value: clamp({ n: input.modelConfidence ?? 0.5 }) },
  };
  let score = Object.values(signals).reduce((a, s) => a + s.weight * clamp({ n: s.value }), 0);
  if (contradiction) score = Math.min(score, 0.35);
  if (!input.schemaValid) score = Math.min(score, 0.2);
  if ((input.numericFidelity ?? 1) < 0.8) score = Math.min(score, 0.4);
  if (input.citation?.urlCheck?.passed === false || input.citation?.quoteCheck?.passed === false)
    score = Math.min(score, 0.6);
  return {
    confidenceScore: Math.round(score * 10000) / 10000,
    threshold,
    signalBreakdown: signals,
    caughtReasons: reasons,
    disposition: score >= threshold ? ('auto_released' as const) : ('held_for_review' as const),
  };
}

/**
 * Returns the share of amounts in the answer that also appear in the sources.
 * Commas are ignored, so $1,240 matches $1240. Matching is plain text, not numeric.
 * If the answer has no amounts: returns 1.
 * Why: a model can restate a price or a time limit wrongly. Without this check,
 * a wrong number would read as confident prose.
 */
export function numericFidelity({
  answer,
  sources,
}: {
  answer: string;
  sources: string[];
}): number {
  /** Finds dollar amounts, and counts like "30-day", "5 seats" or "3 business days". */
  const numbers = ({ s }: { s: string }) =>
    s.match(/\$\s*\d[\d,]*(?:\.\d{1,2})?|\b\d+(?:-day|\s+seats|\s+business days)\b/g) || [];
  const source = sources.join(' ').replace(/,/g, '');
  const values = numbers({ s: answer }).map((n) => n.replace(/,/g, ''));
  if (!values.length) return 1;
  return values.filter((n) => source.includes(n)).length / values.length;
}
