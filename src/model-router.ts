/**
 * Why this file exists: each question needs a Claude model that is strong enough
 * but not wasteful. This file scores how hard a question looks and picks Haiku,
 * Sonnet or Opus. Without it, every question would go to one model. Easy ones would
 * cost too much, or hard ones would get a weak answer.
 */
import { lexicalCosine } from './nli-model.js';
import { countTokens } from './context-builder.js';

/**
 * The Anthropic models we allow, from smallest to largest.
 * The fallback chain refuses any model that is not in this list.
 */
export const CLAUDE_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-6'] as const;

export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

/** What the router reads about a question. Only `query` is required. */
export interface RoutingInput {
  query: string;
  activeTools?: number;
  documentCount?: number;
  historyTurns?: number;
}

/** A past result the router can learn from. `quality` runs from 0 to 1. */
type ObserveParams = { query: string; model: ClaudeModel; quality: number };

/**
 * Chooses a Claude model for a question from five signals, and remembers past quality.
 * The history lives in this instance. The module exports one shared instance.
 */
export class ModelRouter {
  /**
   * Past results, newest last. Starts with one seeded example.
   * Why: the history signal needs something to compare against before any real answer exists.
   */
  private history: Array<{ query: string; model: ClaudeModel; quality: number; source: string }> = [
    {
      query: 'analyze compare why root cause trade-off multiple systems',
      model: 'claude-sonnet-4-5',
      quality: 0.95,
      source: 'seeded-prior',
    },
  ];

  /**
   * Scores a question and picks a model.
   * Each signal adds points: long prompt, analytical words, several questions, tools or
   * ticket mentions, and a similar past question that a larger model answered well.
   * Score 8 or more: Opus. Score 2 to 7: Sonnet. Below 2: Haiku.
   * The tier is "small" for Haiku and "escalated" for the others.
   * Returns the signals too, so the page can show why this model was chosen.
   */
  route(input: RoutingInput) {
    const q = input.query,
      tells =
        q.match(
          /\b(compare|analy[sz]e|why|how does|trade.off|difference|root cause|investigate)\b/gi,
        ) || [],
      questions = (q.match(/\?/g) || []).length;
    const similar = this.history
      .filter((h) => lexicalCosine({ a: h.query, b: q }) > 0.2)
      .sort((a, b) => b.quality - a.quality)[0];
    const signals = [
      {
        id: 'prompt_length',
        active: countTokens({ text: q }) > 180,
        score: countTokens({ text: q }) > 180 ? 2 : 0,
        detail: `${q.length} chars / ~${countTokens({ text: q })} tokens`,
      },
      {
        id: 'linguistic_tells',
        active: tells.length > 0,
        score: Math.min(4, tells.length * 2),
        detail: tells.join(', ') || 'No analytical markers',
      },
      {
        id: 'multiple_questions',
        active: questions > 1 || /\band\b.*\b(?:why|how|what|check|compare)\b/i.test(q),
        score: questions > 1 ? 2 : /\band\b.*\b(?:why|how|what|check|compare)\b/i.test(q) ? 1 : 0,
        detail: `${questions} explicit questions`,
      },
      {
        id: 'tool_involvement',
        active:
          /(?:TCK-\d+|escalat|critical)/i.test(q) ||
          (input.activeTools || 0) > 1 ||
          (input.documentCount || 0) > 1,
        score: /(?:TCK-\d+|escalat|critical)/i.test(q)
          ? 2
          : (input.activeTools || 0) > 1
            ? 2
            : (input.documentCount || 0) > 1
              ? 1
              : 0,
        detail: `${input.activeTools || 0} active tools; ${input.documentCount || 1} source documents`,
      },
      {
        id: 'historical_quality',
        active: Boolean(similar),
        score: similar && similar.model !== 'claude-haiku-4-5' && similar.quality > 0.8 ? 2 : 0,
        detail: similar
          ? `${similar.model} quality ${similar.quality.toFixed(2)} (${similar.source})`
          : 'No comparable quality record',
      },
    ];
    const score = signals.reduce((a, s) => a + s.score, 0),
      model: ClaudeModel =
        score >= 8 ? 'claude-opus-4-6' : score >= 2 ? 'claude-sonnet-4-5' : 'claude-haiku-4-5';
    return { model, tier: model.includes('haiku') ? 'small' : 'escalated', score, signals };
  }

  /**
   * Saves how well a model answered a question, for later routing.
   * Clamps `quality` to 0 through 1. Keeps only the newest 200 results.
   */
  observe({ query, model, quality }: ObserveParams) {
    this.history.push({
      query,
      model,
      quality: Math.max(0, Math.min(1, quality)),
      source: 'citation-schema-evaluation',
    });
    this.history = this.history.slice(-200);
  }

  /** Forgets every real result. Keeps the seeded example. */
  reset() {
    this.history = this.history.filter((h) => h.source === 'seeded-prior');
  }

  /** Reports the allowed models, the last 20 results and the names of the five signals. */
  status() {
    return {
      models: CLAUDE_MODELS,
      history: this.history.slice(-20),
      signals: [
        'prompt_length',
        'linguistic_tells',
        'multiple_questions',
        'tool_involvement',
        'historical_quality',
      ],
    };
  }
}

/** The shared router used by the answer generator and the pipeline. */
export const modelRouter = new ModelRouter();
