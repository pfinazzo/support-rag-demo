/**
 * Why this file exists: the prompt guard has settings a person can change and
 * a log of recent checks. These routes expose both, so the page can switch a
 * defense on or off and show what each one caught.
 */
import { resolveRequestGuardConfig } from '../guard/guard-config.js';
import { readJsonBody, runOrRejectWithBadRequest, sendJson } from '../http-exchange.js';
import { promptGuard } from '../runtime.js';
import type { RouteContext } from './route-types.js';

/** Shows the saved guard settings, the classifier status and the recent checks. */
export const handleGuardState = ({ response }: RouteContext): void =>
  sendJson({ response, body: promptGuard.state() });

/**
 * Checks one piece of text and returns the full report. Does not save settings.
 * Settings sent with the text apply to this check only.
 */
export const handleGuardCheck = async ({ request, response }: RouteContext): Promise<void> => {
  const body = await readJsonBody({ request });
  const guardConfig = resolveRequestGuardConfig({
    guardConfig: body.guardConfig,
    simulateIndirectInjection: undefined,
  });
  const text = String(body.text || body.message || body.query || '');
  sendJson({ response, body: await promptGuard.check({ query: text, overrides: guardConfig }) });
};

/**
 * Saves new guard settings. Changes the guard for every later request.
 * The settings may arrive wrapped in `guardConfig` or as the whole body.
 */
export const handleGuardConfigUpdate = async ({
  request,
  response,
}: RouteContext): Promise<void> => {
  const body = await readJsonBody({ request });
  runOrRejectWithBadRequest({
    run: () => promptGuard.update({ partial: body.guardConfig || body }),
  });
  sendJson({ response, body: promptGuard.state() });
};

/** Clears the list of recent checks. Does not change the settings. */
export const handleGuardAuditClear = ({ response }: RouteContext): void => {
  promptGuard.clearAudit();
  sendJson({ response, body: promptGuard.state() });
};
