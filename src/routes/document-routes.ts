/**
 * Why this file exists: citations link to the documents they quote, and the
 * fact-check step fetches those links to read the real text. This route serves
 * the documents, and only the ones in the document store.
 */
import path from 'node:path';

import { createHttpError, sendText } from '../http-exchange.js';
import { documentStore } from '../runtime.js';
import type { RouteContext } from './route-types.js';

const DOCUMENT_ROUTE_PREFIX = '/docs/';

/** Decodes a file name from a URL. Throws a 400 for a broken `%` sequence. */
const decodeFilename = ({ encodedFilename }: { encodedFilename: string }): string => {
  try {
    return decodeURIComponent(encodedFilename);
  } catch {
    throw createHttpError({ statusCode: 400, message: 'Invalid document name' });
  }
};

/**
 * Sends one document as Markdown, or a 404.
 * The name must be a bare file name that exists in the store. A name with a
 * folder in it is refused, so a request cannot reach a file outside the store.
 */
export const handleDocument = ({ url, response }: RouteContext): void => {
  const filename = decodeFilename({
    encodedFilename: url.pathname.slice(DOCUMENT_ROUTE_PREFIX.length),
  });
  const document = documentStore.documents().find((candidate) => candidate.id === filename);

  if (filename !== path.basename(filename) || !document) {
    return sendText({
      response,
      statusCode: 404,
      contentType: 'text/plain; charset=utf-8',
      text: 'Document not found',
    });
  }
  sendText({
    response,
    statusCode: 200,
    contentType: 'text/markdown; charset=utf-8',
    text: document.content,
    headers: { 'Cache-Control': 'no-cache' },
  });
};
