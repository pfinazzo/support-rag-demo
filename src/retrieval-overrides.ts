/**
 * Why this file exists: two rules change what the search found before the
 * answer is written. They sit apart from the search itself so each one can be
 * read, and tested, on its own.
 */
import { poisonRetrievedChunks } from './prompt-guard.js';
import type { SearchTelemetry } from './types.js';

const BILLING_ERROR_PATTERN = /ERR_PAYMENT_402|\b402\b/i;

const BILLING_GUIDE_FILE = 'billing-and-refunds.md';

/**
 * A question about the payment error code must be answered from the billing
 * guide. If the search found other documents but not the guide, the search
 * counts as finding nothing. Otherwise the answer would be a guess about a
 * customer's money.
 */
const withholdUnsupportedBillingAnswer = ({
  retrieval,
  message,
}: {
  retrieval: SearchTelemetry;
  message: string;
}): SearchTelemetry => {
  const isBillingErrorQuestion = BILLING_ERROR_PATTERN.test(message);
  const hasBillingGuide = retrieval.results.some(
    (result) => result.sourceFile === BILLING_GUIDE_FILE,
  );
  return isBillingErrorQuestion && !hasBillingGuide
    ? { ...retrieval, results: [], relevant: false }
    : retrieval;
};

/**
 * Adds a poisoned support-ticket note to the results.
 * Why: the demo can then show the data-separation layer catching a hidden
 * instruction that arrives inside a document, not inside the question.
 */
const withSimulatedPoison = ({ retrieval }: { retrieval: SearchTelemetry }): SearchTelemetry => ({
  ...retrieval,
  results: poisonRetrievedChunks({ chunks: retrieval.results }),
});

/** Applies both rules and returns a new search result. The input is not changed. */
export const applyRetrievalOverrides = ({
  retrieval,
  message,
  shouldSimulatePoison,
}: {
  retrieval: SearchTelemetry;
  message: string;
  shouldSimulatePoison: boolean;
}): SearchTelemetry => {
  const checked = withholdUnsupportedBillingAnswer({ retrieval, message });
  return shouldSimulatePoison ? withSimulatedPoison({ retrieval: checked }) : checked;
};
