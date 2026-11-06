/**
 * Why this file exists: a request may carry its own prompt-guard settings for
 * one check. The saved settings must not change when it does. This builds the
 * settings for that one request and leaves the saved ones alone.
 */
import { runOrRejectWithBadRequest } from '../http-exchange.js';
import type { GuardConfig } from './prompt-guard.js';
import { PromptGuard } from './prompt-guard.js';
import { promptGuard } from '../runtime.js';

/**
 * Starts from the saved settings and applies what the request asked for.
 * A scratch guard does the checking, so the guard's own validation rules
 * decide what is allowed and an unknown or mistyped setting becomes a 400.
 */
export const resolveRequestGuardConfig = ({
  guardConfig,
  simulateIndirectInjection,
}: {
  guardConfig: unknown;
  simulateIndirectInjection: unknown;
}): GuardConfig => {
  const scratchGuard = new PromptGuard();
  scratchGuard.config = { ...promptGuard.config };

  runOrRejectWithBadRequest({
    run: () => {
      if (guardConfig !== undefined) scratchGuard.update({ partial: guardConfig });
      if (simulateIndirectInjection !== undefined)
        scratchGuard.update({ partial: { simulateIndirectInjection } });
    },
  });
  return scratchGuard.config;
};
