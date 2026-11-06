/**
 * Why this file exists: an answer the system is unsure about must wait for a
 * person instead of going to the customer. This file holds those waiting
 * answers. A reviewer approves, edits or rejects each one, and this file records
 * what was released and why others were rejected.
 * Without it, a low-confidence answer would reach the customer unchecked.
 * The queue lives in memory. A restart empties it.
 */
import { randomUUID } from 'node:crypto';
import { responseEnvelope, type SupportResponse } from './structured-output.js';
import { computeResponseConfidence, type ConfidenceInput } from './confidence-scorer.js';

/** One held answer waiting for a person. */
export interface ReviewItem {
  id: string;
  /** ISO 8601 time the answer was queued. */
  createdAt: string;
  question: string;
  /** From 0 to 1. The answer was held because this was below `threshold`. */
  confidenceScore: number;
  /** The lowest confidence score that is released without review. */
  threshold: number;
  /** The signals that made up the score. The confidence scorer decides the shape. */
  signalBreakdown: unknown;
  /** Short codes saying why the answer was held. Rejections are counted by these. */
  caughtReasons: string[];
  /** The evidence the model saw when it wrote the answer. */
  originalSources: Array<{ sourceFile: string; text: string }>;
  /** What the pipeline would have sent. Usually an object with an `answer`. It can hold an error instead. */
  proposedOutput: unknown;
  /** Starts as pending. A reviewer sets it once, and it never changes after. */
  status: 'pending' | 'approved' | 'edited' | 'rejected';
  reviewerNotes: string;
  /** The reviewer's replacement answer. Null unless the action was edit. */
  editedAnswer: string | null;
  /** A label for the kind of problem. Only the seeded examples set it. */
  category?: string;
  sessionId?: string;
}

/** `action` is `approve`, `edit` or `reject`. `answer` is the replacement text and is required for `edit`. */
type ActionParams = { id: string; action: string; notes?: string; answer?: string };

/** The review queue. One shared instance, `reviewQueue`, is exported at the bottom. */
export class ReviewQueue {
  /** Every item, oldest first. Capped at 1000. */
  private items: ReviewItem[] = [];

  /** How many rejections each kind of problem has caused. */
  private patterns: Record<string, number> = {};

  /** Answers a person let through, with the structured output that went out. */
  private released: Array<{
    reviewId: string;
    answer: string;
    at: string;
    pipelineStage: string;
    structuredOutput: SupportResponse;
  }> = [];

  /**
   * Adds an answer to the queue as pending and returns the new item.
   * If the queue passes 1000 items: drops the oldest.
   */
  enqueue({
    input,
  }: {
    input: Omit<ReviewItem, 'id' | 'createdAt' | 'status' | 'reviewerNotes' | 'editedAnswer'> & {
      id?: string;
    };
  }) {
    const item: ReviewItem = {
      ...input,
      id: input.id || 'REV-' + randomUUID().slice(0, 8).toUpperCase(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      reviewerNotes: '',
      editedAnswer: null,
    };
    this.items.push(item);
    this.items = this.items.slice(-1000);
    return item;
  }

  /**
   * Records a reviewer's decision on one pending item and returns the item.
   * Throws if the item is missing, already resolved, the action is unknown, or an edit has no answer.
   * Approve or edit: releases the answer. The edited text is used if given, otherwise the proposed answer.
   * The released output is marked `unverified`, because no one re-ran the citation check on it.
   * Reject: releases nothing and adds to the count for each problem kind that caused the hold.
   */
  action({ id, action, notes = '', answer }: ActionParams) {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new Error('Review item not found');
    if (item.status !== 'pending') throw new Error('Review item already resolved');
    if (!['approve', 'edit', 'reject'].includes(action)) throw new Error('Invalid review action');
    if (action === 'edit' && (!answer || !answer.trim()))
      throw new Error('Edited answer is required');
    item.reviewerNotes = notes;
    item.status = action === 'approve' ? 'approved' : action === 'edit' ? 'edited' : 'rejected';
    item.editedAnswer = action === 'edit' ? answer! : null;
    if (action === 'reject') {
      for (const reason of item.caughtReasons) {
        /**
         * Sorts a reason code into a problem kind by its wording.
         * A reason that matches none of the first three counts as a citation contradiction.
         */
        const category = /schema/.test(reason)
          ? 'schema_failure'
          : /invoice/.test(reason)
            ? 'invoice_parse_mismatch'
            : /retrieval/.test(reason)
              ? 'weak_retrieval'
              : 'citation_contradiction';
        this.patterns[category] = (this.patterns[category] || 0) + 1;
      }
    } else {
      const output = item.proposedOutput as Partial<SupportResponse>;
      const releasedAnswer = answer || String(output.answer || item.proposedOutput);
      this.released.push({
        reviewId: id,
        answer: releasedAnswer,
        at: new Date().toISOString(),
        pipelineStage: 'released_after_review',
        structuredOutput: responseEnvelope({
          answer: releasedAnswer,
          sources: item.originalSources.map((s) => ({ sourceFile: s.sourceFile })),
          extra: { confidence: item.confidenceScore, citationVerdict: 'unverified' },
        }),
      });
    }
    return item;
  }

  /** Describes the queue for the page: the pending count, every item, released answers and rejection counts. */
  state() {
    return {
      pending: this.items.filter((i) => i.status === 'pending').length,
      items: this.items,
      releasedResponses: this.released,
      rejectionPatterns: this.patterns,
    };
  }

  /** Empties the queue. Adds the example items back unless `seed` is false. */
  reset({ seed = true }: { seed?: boolean } = {}) {
    this.items = [];
    this.patterns = {};
    this.released = [];
    if (seed) seedDefaultReviewQueue({ queue: this });
  }
}

/**
 * Adds four example items so the review page has something to show.
 * Does nothing if the first example is already there.
 * The confidence scores are made-up numbers. The threshold is 0.72, the release threshold the scorer uses by default.
 */
export function seedDefaultReviewQueue({ queue }: { queue: ReviewQueue }) {
  if (queue.state().items.some((i) => i.id === 'REV-SEED-01')) return;
  const examples = [
    {
      category: 'low_confidence_citation',
      reason: 'citation_contradiction',
      question: 'Are unused-seat refunds automatic?',
      answer: 'Prorated mid-cycle seat refunds are issued automatically.',
      source: 'Partial refunds are not offered for unused seats. NLI contradiction: 0.99.',
    },
    {
      category: 'schema_validation_failure',
      reason: 'schema_validation_failed',
      question: 'Return billing support fields.',
      answer: { answer: 'Billing update', confidence: 1.45 },
      source: 'SupportResponse requires citedSources[] and confidence in [0,1].',
    },
    {
      category: 'retrieval_below_threshold',
      reason: 'weak_retrieval',
      question: 'Where do I send my hardware appliance for RMA?',
      answer: 'Ship the hardware appliance for replacement.',
      source: 'Support corpus has no hardware RMA policy. Retrieval match 0.18.',
    },
    {
      category: 'invoice_parse_mismatch',
      reason: 'invoice_parse_mismatch',
      question: 'Check INV-2026-0841 total.',
      answer: 'INV-2026-0841 subtotal is $12,400.00.',
      source:
        'INV-2026-0841: 35 seats × $32.00 + $120.00 SSO add-on = $1,240.00. Parsed $12,400.00 is a 10× decimal shift; line-item sum mismatch.',
    },
  ];
  examples.forEach((e, i) =>
    queue.enqueue({
      input: {
        id: 'REV-SEED-0' + (i + 1),
        question: e.question,
        confidenceScore: 0.18 + i * 0.04,
        threshold: 0.72,
        signalBreakdown: { detected: e.reason },
        caughtReasons: [e.reason],
        originalSources: [
          { sourceFile: i === 3 ? 'INV-2026-0841' : 'billing-and-refunds.md', text: e.source },
        ],
        proposedOutput: typeof e.answer === 'string' ? { answer: e.answer } : e.answer,
        category: e.category,
      },
    }),
  );
}

/** The one shared review queue. */
export const reviewQueue = new ReviewQueue();

seedDefaultReviewQueue({ queue: reviewQueue });
