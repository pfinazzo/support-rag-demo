/**
 * Why this file exists: it gathers the search functions behind one import
 * path, so callers need not know which file each lives in.
 */
export { createSearcher, RRF_K } from './search.js';

export { runSearchAgent } from '../ranking/search-agent.js';
