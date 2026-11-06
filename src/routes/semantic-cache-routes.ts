/**
 * Why this file exists: the semantic cache has a similarity threshold and can be
 * emptied. These routes let the page show hit counts, change how close a match
 * must be, and start over.
 */
import { readJsonBody, runOrRejectWithBadRequest, sendJson } from '../http-exchange.js';
import { resolveCallerRoles } from '../retrieval/roles.js';
import { semanticCache } from '../runtime.js';
import type { RouteContext } from './route-types.js';

/**
 * Shows semantic cache counts and entries. With `?rolePreset=`, shows only the entries
 * that role can see, because each role keeps its own saved answers.
 */
export const handleSemanticCacheState = ({ response, url }: RouteContext): void => {
  const rolePreset = url.searchParams.get('rolePreset');
  const roleKey =
    rolePreset === null ? undefined : [...resolveCallerRoles({ rolePreset })].sort().join(',');
  sendJson({ response, body: semanticCache.state({ roleKey }) });
};

/** Empties the semantic cache. The next question of every kind is a miss. */
export const handleSemanticCacheClear = ({ response }: RouteContext): void => {
  semanticCache.clear();
  sendJson({ response, body: semanticCache.state() });
};

/** Changes the cosine similarity a saved question needs to reuse its answer. Throws a 400 for a value outside 0.10 to 0.99. */
export const handleSemanticCacheThreshold = async ({
  request,
  response,
}: RouteContext): Promise<void> => {
  const body = await readJsonBody({ request });
  runOrRejectWithBadRequest({ run: () => semanticCache.setThreshold({ value: body.threshold }) });
  sendJson({ response, body: semanticCache.state() });
};
