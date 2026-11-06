/**
 * Why this file exists: during development, an edited client file should
 * rebuild and refresh the open page on its own. This file holds the pages that
 * are waiting for that signal and the watchers that send it.
 */
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import {
  CLIENT_DIRECTORY,
  IS_HOT_RELOAD_ENABLED,
  PROJECT_ROOT,
  PUBLIC_DIRECTORY,
} from '../config.js';
import { startEventStream } from '../http-exchange.js';

/**
 * Waits this long after the last edit before rebuilding.
 * Why: an editor saves several times in a row. Without the wait, each save
 * would start its own build.
 */
const CLIENT_BUILD_DEBOUNCE_MS = 200;

const MAX_LOGGED_BUILD_ERROR_CHARACTERS = 400;

/**
 * Which signal each kind of changed file sends to the page.
 * A style change swaps the CSS in place. Any other change reloads the page.
 */
const RELOAD_EVENTS_BY_EXTENSION = new Map([
  ['.css', 'css'],
  ['.js', 'reload'],
  ['.html', 'reload'],
]);

/** Pages waiting for a reload signal. */
const waitingPages = new Set<ServerResponse>();

/**
 * The one piece of shared state in this file: the pending rebuild timer and
 * whether a rebuild is running. Both are needed so that edits during a build
 * queue one more build instead of starting two at once.
 */
const clientBuild: { timer: ReturnType<typeof setTimeout> | undefined; isRunning: boolean } = {
  timer: undefined,
  isRunning: false,
};

/** Sends one signal to every waiting page. A page that has gone away is dropped. */
const broadcastToPages = ({ event, data }: { event: string; data: string }): void => {
  const message = `event: ${event}\ndata: ${data}\n\n`;
  waitingPages.forEach((page) =>
    page.destroyed ? waitingPages.delete(page) : page.write(message),
  );
};

/** Runs the client build once. Starts a process, then signals the pages if it worked. */
const rebuildClient = ({ changedFile }: { changedFile: string }): void => {
  if (clientBuild.isRunning) return;
  clientBuild.isRunning = true;
  console.log(`[hot-reload] rebuilding client (${changedFile})…`);

  const build = spawn('npm', ['run', 'build:client', '--silent'], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  const errorOutput: string[] = [];
  build.stderr.on('data', (chunk: Buffer) => errorOutput.push(chunk.toString()));
  build.on('exit', (exitCode) => {
    clientBuild.isRunning = false;
    if (exitCode !== 0) {
      console.warn(
        '[hot-reload] client build failed:',
        errorOutput.join('').slice(0, MAX_LOGGED_BUILD_ERROR_CHARACTERS),
      );
      return;
    }
    console.log('[hot-reload] client build ok');
    broadcastToPages({ event: 'reload', data: 'client-rebuild' });
  });
};

/** Starts a rebuild after the quiet period. A newer edit restarts the wait. */
const scheduleClientBuild = ({ changedFile }: { changedFile: string }): void => {
  clearTimeout(clientBuild.timer);
  clientBuild.timer = setTimeout(() => rebuildClient({ changedFile }), CLIENT_BUILD_DEBOUNCE_MS);
};

/** Reacts to an edit in `client/`: only TypeScript files need a rebuild. */
const handleClientEdit = ({ filename }: { filename: string | null }): void => {
  if (!filename?.endsWith('.ts')) return;
  scheduleClientBuild({ changedFile: filename });
};

/** Reacts to a change in `public/`: signals the page with the event for that file type. */
const handlePublicChange = ({ filename }: { filename: string | null }): void => {
  if (!filename) return;
  const event = RELOAD_EVENTS_BY_EXTENSION.get(path.extname(filename));
  if (event) broadcastToPages({ event, data: filename });
};

/**
 * Watches one folder. A folder that cannot be watched only costs the
 * developer the automatic refresh, so this warns once and carries on.
 */
const watchFolder = ({
  folder,
  onChange,
}: {
  folder: string;
  onChange: (params: { filename: string | null }) => void;
}): void => {
  try {
    watch(folder, { recursive: true }, (_event, filename) => onChange({ filename }));
    console.log(`[hot-reload] watching ${folder}`);
  } catch (error) {
    console.warn(
      `[hot-reload] could not watch ${folder}:`,
      error instanceof Error ? error.message : error,
    );
  }
};

/**
 * Keeps the page open as a stream so it can be told to reload. Writes to the response.
 * Answers 204 when hot reload is switched off, so the page stops asking.
 */
export const handleHotReloadSubscription = ({
  request,
  response,
}: {
  request: IncomingMessage;
  response: ServerResponse;
}): void => {
  if (!IS_HOT_RELOAD_ENABLED) {
    response.writeHead(204);
    response.end();
    return;
  }
  startEventStream({ response });
  response.write(': connected\n\n');
  waitingPages.add(response);
  request.on('close', () => waitingPages.delete(response));
};

/**
 * Starts the folder watchers. Not called yet: the first version of this server
 * defined the watchers but never started them, and this refactor keeps that
 * behavior. Call it from `server.ts` to turn automatic rebuilds on.
 */
export const startHotReloadWatchers = (): void => {
  if (!IS_HOT_RELOAD_ENABLED) {
    console.log('HOT_RELOAD=0 — file watchers disabled');
    return;
  }
  watchFolder({ folder: CLIENT_DIRECTORY, onChange: handleClientEdit });
  watchFolder({ folder: PUBLIC_DIRECTORY, onChange: handlePublicChange });
};
