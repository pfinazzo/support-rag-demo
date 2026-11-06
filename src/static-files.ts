/**
 * Why this file exists: the page, its scripts and its styles are plain files in
 * `public/`. This file is the only code that reads them from disk, so the rule
 * that keeps requests inside that folder lives in one place.
 */
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { PUBLIC_DIRECTORY } from './config.js';
import { createHttpError, sendText } from './http-exchange.js';

/**
 * A Map, not an object. The extension comes from the request path, and an
 * object would answer for names like `constructor`.
 */
const CONTENT_TYPES_BY_EXTENSION = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.map', 'application/json'],
]);

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/**
 * Files are never cached by the browser.
 * Why: while the client is being edited, a cached script would show an old
 * page and make a fixed bug look unfixed.
 */
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
};

/** Decodes a URL path. Throws a 400 for a broken `%` sequence. */
const decodePathname = ({ pathname }: { pathname: string }): string => {
  try {
    return decodeURIComponent(pathname);
  } catch {
    throw createHttpError({ statusCode: 400, message: 'Invalid path' });
  }
};

/** Maps a URL path to a file path inside `public/`. The bare `/` is the home page. */
const resolvePublicFilePath = ({ pathname }: { pathname: string }): string => {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const withoutParentSteps = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, '');
  return path.join(PUBLIC_DIRECTORY, withoutParentSteps);
};

/**
 * True when the path is a real file inside `public/`.
 * The folder name is checked with a trailing separator. Without it, a sibling
 * folder such as `public-secrets` would also pass the prefix check.
 */
const isServableFile = ({ filePath }: { filePath: string }): boolean =>
  filePath.startsWith(PUBLIC_DIRECTORY + path.sep) &&
  fs.existsSync(filePath) &&
  fs.statSync(filePath).isFile();

/**
 * Sends a file from `public/`, or a 404. Writes to the response.
 * A HEAD request gets the headers only.
 */
export const serveStaticFile = async ({
  request,
  response,
}: {
  request: IncomingMessage;
  response: ServerResponse;
}): Promise<void> => {
  const { pathname } = new URL(request.url || '/', 'http://localhost');
  const filePath = resolvePublicFilePath({ pathname: decodePathname({ pathname }) });

  if (!isServableFile({ filePath })) {
    return sendText({ response, statusCode: 404, contentType: 'text/plain', text: 'Not found' });
  }

  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES_BY_EXTENSION.get(path.extname(filePath)) || DEFAULT_CONTENT_TYPE,
    ...NO_CACHE_HEADERS,
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  await pipeline(fs.createReadStream(filePath), response);
};
