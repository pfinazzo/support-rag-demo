/**
 * Why this file exists: the pipeline page asks for the real source code behind
 * each stage. This route reads the files and sends the snippets back.
 */
import { sendJson } from '../http-exchange.js';
import { loadStageCode } from '../stage-code.js';
import type { RouteContext } from './route-types.js';

/** Sends the source snippets for every pipeline stage. */
export const handleStageCode = async ({ response }: RouteContext): Promise<void> =>
  sendJson({ response, body: { stages: await loadStageCode() } });
