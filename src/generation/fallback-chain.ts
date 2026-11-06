/**
 * Why this file exists: when the Anthropic model we chose fails, the next model
 * should answer instead. This file holds the order of models to try and a record
 * of recent failures. Without it, one timeout or rate limit would give the user an
 * error even though another model could have answered.
 */
import { CLAUDE_MODELS, type ClaudeModel } from './model-router.js';

/** The reasons a model call can fail, as shown on the operations page. */
export type FailureType = 'timeout' | 'http_503' | 'rate_limit_429' | 'unavailable';

/**
 * One try at one model, kept for the operations page.
 * `at` is an ISO timestamp. `latencyMs` is milliseconds.
 */
export interface Attempt {
  model: string;
  success: boolean;
  errorType?: FailureType;
  error?: string;
  latencyMs: number;
  at: string;
}

/**
 * Thrown when every model in the chain failed.
 * The `attempts` list says what happened to each model, in the order tried.
 */
export class FallbackExhaustedError extends Error {
  readonly code = 'FALLBACK_EXHAUSTED';

  readonly attempts: Attempt[];

  constructor({ attempts }: { attempts: Attempt[] }) {
    super('All permitted model links failed');
    this.attempts = attempts;
  }
}

/**
 * Sorts an error into one of the four failure types.
 * Checks the HTTP status first, then the message text, because some vendor errors carry only text.
 * Rate limit is checked before 503, then timeout. Anything else counts as unavailable.
 */
export function failureType({ error }: { error: unknown }): FailureType {
  const e = error as { status?: number; name?: string; message?: string };
  return e.status === 429 || /429|rate.?limit/i.test(e.message || '')
    ? 'rate_limit_429'
    : e.status === 503 || /503/.test(e.message || '')
      ? 'http_503'
      : /timeout|timed out|Abort|Timeout/.test((e.name || '') + ' ' + (e.message || ''))
        ? 'timeout'
        : 'unavailable';
}

/**
 * Tries models in order until one answers, and remembers how each try went.
 * The history lives in this instance. The module exports one shared instance.
 */
export class FallbackChain {
  /**
   * When true, the local Ollama model is added as the last resort.
   * Off by default, so a normal request never reaches it.
   */
  localEnabled = false;

  /** Recent tries, newest last. Trimmed to one hour and 1000 entries on each write. */
  private events: Attempt[] = [];

  /**
   * Lists the models to try, starting with `primary`.
   * Haiku falls back to Sonnet, then Opus. Sonnet falls back to Opus, then Haiku.
   * Opus falls back to Sonnet, then Haiku.
   * Throws if `primary` is not an approved Claude model. Without this check, a typo
   * would send user questions to a model nobody approved.
   */
  order({ primary }: { primary: ClaudeModel }): string[] {
    if (!CLAUDE_MODELS.includes(primary))
      throw new Error('Only approved Claude cloud models are allowed');
    const order = primary.includes('haiku')
      ? [primary, 'claude-sonnet-4-5', 'claude-opus-4-6']
      : primary.includes('sonnet')
        ? [primary, 'claude-opus-4-6', 'claude-haiku-4-5']
        : [primary, 'claude-sonnet-4-5', 'claude-haiku-4-5'];
    return this.localEnabled ? [...order, 'ollama/qwen2.5:1.5b'] : order;
  }

  /**
   * Calls `invoke` with each model in order and returns the first answer.
   * Records every try in the history. Calls `onEvent` after each try.
   * If a model fails: moves on to the next model. The error is kept in the attempt list.
   * If all models fail: throws FallbackExhaustedError with the full attempt list.
   */
  async run<T>({
    primary,
    invoke,
    onEvent,
  }: {
    primary: ClaudeModel;
    invoke: ({ model }: { model: string }) => Promise<T>;
    onEvent?: ({ attempt }: { attempt: Attempt }) => void | Promise<void>;
  }) {
    const attempts: Attempt[] = [];
    for (const model of this.order({ primary })) {
      const start = performance.now();
      try {
        const value = await invoke({ model });
        const row = {
          model,
          success: true,
          latencyMs: performance.now() - start,
          at: new Date().toISOString(),
        };
        attempts.push(row);
        this.record({ row });
        await onEvent?.({ attempt: row });
        return { value, model, attempts };
      } catch (error) {
        const row = {
          model,
          success: false,
          errorType: failureType({ error }),
          error: (error as Error).message,
          latencyMs: performance.now() - start,
          at: new Date().toISOString(),
        };
        attempts.push(row);
        this.record({ row });
        await onEvent?.({ attempt: row });
      }
    }
    throw new FallbackExhaustedError({ attempts });
  }

  /**
   * Adds one try to the history and drops entries older than one hour.
   * Keeps at most the newest 1000. Without the limit, the list would grow forever.
   */
  private record({ row }: { row: Attempt }) {
    this.events.push(row);
    this.events = this.events.filter((e) => Date.now() - Date.parse(e.at) < 3600000).slice(-1000);
  }

  /** Clears the history and turns the local model off. */
  reset() {
    this.events = [];
    this.localEnabled = false;
  }

  /**
   * Reports the last hour of tries for every model, including the local one.
   * Each model gets its attempts, failures, successes, failure rate and last 20 events.
   * Models never tried show zeros. Drops entries older than one hour first.
   */
  status() {
    this.events = this.events.filter((e) => Date.now() - Date.parse(e.at) < 3600000);
    return {
      localEnabled: this.localEnabled,
      windowMs: 3600000,
      models: [...CLAUDE_MODELS, 'ollama/qwen2.5:1.5b'].map((model) => {
        const events = this.events.filter((e) => e.model === model),
          failures = events.filter((e) => !e.success).length;
        return {
          model,
          attempts: events.length,
          failures,
          successes: events.length - failures,
          failureRate: events.length ? failures / events.length : 0,
          recentEvents: events.slice(-20),
        };
      }),
    };
  }
}

/** The shared chain used by the answer generator and the router probe. */
export const fallbackChain = new FallbackChain();
