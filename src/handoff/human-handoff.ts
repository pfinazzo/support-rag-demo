/**
 * Why this file exists: when the bot cannot help, the customer must reach a
 * person, and that person must see the whole conversation. This file decides
 * when to hand a conversation over and builds the package for the person.
 * The package stays in a local queue. Nothing is sent to a real support team.
 * Without it, a stuck customer would keep talking to the bot, and a person
 * would have to ask them to repeat everything.
 */
import { randomUUID } from 'node:crypto';
import { lexicalCosine } from '../verification/nli-model.js';
import { ticketStore } from './ticket-store.js';

/** One message in the conversation. */
export interface HandoffTurn {
  /** `user` or `assistant`. Other roles are ignored by the trigger rules. */
  role: string;
  content: string;
  /** ISO 8601 time of the message. */
  timestamp?: string;
  /** For an assistant message: its confidence from 0 to 1. */
  confidence?: number;
  /** For an assistant message: true if the fixed fallback message was sent. */
  fallback?: boolean;
  /** For an assistant message: the name of the tool it called. */
  toolCall?: string;
}

/**
 * `confidenceScore` is the confidence of the latest answer, from 0 to 1.
 * `reviewQueueCount` is how many of this conversation's answers are held for review.
 */
type EvaluateHandoffTriggersParams = {
  turns: HandoffTurn[];
  confidenceScore?: number;
  reviewQueueCount?: number;
};

/**
 * Decides whether a conversation should go to a person, and why.
 * Each reason is a separate rule, listed in this order:
 * - `stuck_bot`, if any one of these is true:
 *   the last two assistant replies are nearly the same;
 *   the last two tool calls used the same tool;
 *   the last three replies were all fallbacks or under 0.5 confidence.
 * - `repeated_human_request`: the customer asked for a person at least twice.
 * - `explicit_human_request`: the latest message asks for a person.
 * - `low_confidence`: confidence is under 0.45, or two answers are held for review.
 * - `sensitive_billing_dispute`: the latest message names a chargeback,
 *   overcharge, disputed invoice, legal dispute or erasure, or a regulator.
 * `triggerReason` is the first reason that applies, and null if none does.
 * Nothing is changed. Without these rules, a customer would have no way out of a failing chat.
 */
export function evaluateHandoffTriggers({
  turns,
  confidenceScore = 1,
  reviewQueueCount = 0,
}: EvaluateHandoffTriggersParams) {
  const users = turns.filter((t) => t.role === 'user'),
    assistants = turns.filter((t) => t.role === 'assistant'),
    /** Words that mean the customer wants a person. */
    human = /\b(?:human|real person|live agent|talk to a person|specialist)\b/i;
  const requests = users.filter((t) => human.test(t.content)).length,
    last = users.at(-1)?.content || '';
  /** How alike the last two assistant replies are, from 0 to 1. Above 0.88 means the bot is repeating itself. */
  const similarity =
    assistants.length >= 2
      ? lexicalCosine({ a: assistants.at(-1)!.content, b: assistants.at(-2)!.content })
      : 0;
  const tools = turns.filter((t) => t.toolCall).slice(-2);
  const repeatedTool = tools.length === 2 && tools[0].toolCall === tools[1].toolCall;
  const unresolved = assistants
    .slice(-3)
    .filter((t) => t.fallback || (t.confidence ?? 1) < 0.5).length;
  const reasons: string[] = [];
  if (similarity > 0.88 || repeatedTool || unresolved >= 3) reasons.push('stuck_bot');
  if (requests >= 2) reasons.push('repeated_human_request');
  else if (human.test(last)) reasons.push('explicit_human_request');
  if (confidenceScore < 0.45 || reviewQueueCount >= 2) reasons.push('low_confidence');
  if (/chargeback|overcharg|disputed invoice|legal.*(?:erasure|dispute)|regulator/i.test(last))
    reasons.push('sensitive_billing_dispute');
  return {
    triggered: reasons.length > 0,
    triggerReason: reasons[0] || null,
    reasons,
    diagnostics: {
      assistantSimilarity: similarity,
      repeatedTool,
      unresolvedTurns: unresolved,
      humanRequestCount: requests,
      reviewQueueCount,
    },
  };
}

/** What a person receives when a conversation is handed over. */
export interface HandoffPackage {
  id: string;
  createdAt: string;
  /** Every message, each with a time. */
  conversationHistory: HandoffTurn[];
  /** The last eight messages, each cut to 180 characters. */
  conversationSummary: string;
  /** The first rule that fired. */
  triggerReason: string;
  /** The full result of the trigger rules. */
  triggerDiagnostics: unknown;
  confidenceScore: number;
  /** Ids of the held answers in the review queue. */
  reviewQueueItems: string[];
  /** Id of the support ticket for this conversation. */
  escalationId: string;
  /** The team that should pick it up. */
  queue: string;
  /** What the customer is told. */
  customerMessage: string;
  /** Always the local queue. Nothing is sent to a person yet. */
  delivery: 'local-queue-pending-dispatch';
}

/** The hand-off queue. One shared instance, `humanHandoff`, is exported at the bottom. */
export class HumanHandoff {
  /** The latest 200 hand-offs, oldest first. */
  private records: HandoffPackage[] = [];

  /**
   * Hands a conversation over if a trigger rule applies, and returns the package.
   * Returns null if no rule applies.
   * If no `escalationId` is given: opens a high-severity support ticket.
   * Adds the package to the queue and keeps the latest 200.
   * Without the stored package, a person would have to ask the customer to start over.
   */
  create(input: {
    turns: HandoffTurn[];
    confidenceScore: number;
    reviewQueueItems?: string[];
    escalationId?: string | null;
    queue?: string;
  }) {
    const triggers = evaluateHandoffTriggers({
      turns: input.turns,
      confidenceScore: input.confidenceScore,
      reviewQueueCount: input.reviewQueueItems?.length || 0,
    });
    if (!triggers.triggered) return null;
    const queue = input.queue || 'general',
      id = 'HND-' + randomUUID().slice(0, 8).toUpperCase();
    const summary = input.turns
      .slice(-8)
      .map((t) => t.role + ': ' + t.content.slice(0, 180))
      .join('\n');
    const escalation =
      input.escalationId ||
      ticketStore.create({ summary, severity: 'high', queue, ticketId: null }).id;
    const record: HandoffPackage = {
      id,
      createdAt: new Date().toISOString(),
      conversationHistory: input.turns.map((t) => ({
        ...t,
        timestamp: t.timestamp || new Date().toISOString(),
      })),
      conversationSummary: summary,
      triggerReason: triggers.triggerReason!,
      triggerDiagnostics: triggers,
      confidenceScore: input.confidenceScore,
      reviewQueueItems: input.reviewQueueItems || [],
      escalationId: escalation,
      queue,
      customerMessage: `Your conversation is queued for a ${queue} specialist under transfer ${id}. The transfer package includes your full history and summary so you will not need to repeat the details. This console has recorded the transfer; external dispatch is not connected.`,
      delivery: 'local-queue-pending-dispatch',
    };
    this.records.push(record);
    this.records = this.records.slice(-200);
    return record;
  }

  /** Lists the hand-offs in the queue. */
  state() {
    return { handoffs: this.records };
  }

  /** Empties the queue. */
  reset() {
    this.records = [];
  }
}

/** The one shared hand-off queue. */
export const humanHandoff = new HumanHandoff();
