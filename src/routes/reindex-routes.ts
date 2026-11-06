/**
 * Why this file exists: the page can edit a document in the database and watch
 * the index react. The edit fires a database trigger, the re-indexer embeds
 * only what changed, and the semantic cache is cleared. These routes drive that
 * loop and put the documents back afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATABASE_SEED_DIRECTORY } from '../config.js';
import { DATABASE_DOCS } from '../doc-store.js';
import { createHttpError, readJsonBody, sendJson } from '../http-exchange.js';
import { documentStore, reindexer, semanticCache } from '../runtime.js';
import type { RouteContext } from './route-types.js';

const DEFAULT_MUTATION_DOCUMENT = 'api-and-webhooks.md';

/**
 * The note appended when an edit sends no new text.
 * Why: the demo needs a real content change to show the re-indexer embedding
 * only that document. The time makes each note different from the last, so
 * the content fingerprint changes every time.
 */
const buildOperationalChange = ({ revisionMs }: { revisionMs: number }): string =>
  `\n\n### Operational Change\nSupport operations revision ${revisionMs}.`;

/** Shows the re-indexer's fingerprints and the latest events. */
export const handleReindexState = ({ response }: RouteContext): void =>
  sendJson({ response, body: reindexer.status() });

/**
 * Changes or deletes one database document, then re-indexes it. Writes to the
 * document database and clears the semantic cache.
 * The semantic cache is cleared because a saved answer may quote text that no longer exists.
 * Only database documents can change. The Markdown files on disk are read-only.
 */
export const handleReindexMutate = async ({ request, response }: RouteContext): Promise<void> => {
  const body = await readJsonBody({ request });
  const documentId = String(body.id || DEFAULT_MUTATION_DOCUMENT);
  if (!DATABASE_DOCS.includes(documentId)) {
    throw createHttpError({ statusCode: 400, message: 'Only database documents can be changed' });
  }

  if (body.operation === 'delete') {
    documentStore.delete({ id: documentId });
  } else {
    const content =
      typeof body.content === 'string'
        ? body.content
        : (documentStore.read({ id: documentId }) || '') +
          buildOperationalChange({ revisionMs: Date.now() });
    documentStore.write({ id: documentId, content });
  }

  const events = await reindexer.drain();
  semanticCache.clear();
  sendJson({ response, body: { ...reindexer.status(), events } });
};

/** Puts the database documents back to their original text, then re-indexes. Clears the semantic cache. */
export const handleReindexRestore = async ({ response }: RouteContext): Promise<void> => {
  DATABASE_DOCS.forEach((documentId) =>
    documentStore.write({
      id: documentId,
      content: fs.readFileSync(path.join(DATABASE_SEED_DIRECTORY, documentId), 'utf8'),
    }),
  );
  await reindexer.drain();
  semanticCache.clear();
  sendJson({ response, body: reindexer.status() });
};
