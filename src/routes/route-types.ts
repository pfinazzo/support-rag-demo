/**
 * Why this file exists: every route handler receives the same few things and
 * returns nothing. Naming that shape once means the route table can hold any
 * handler, and the server can call them all the same way.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export type RouteContext = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  /** Address the page uses to reach this server. Citations link back to it. */
  readonly baseUrl: string;
};

/** A handler writes its own response. The server only waits for it to finish. */
export type RouteHandler = (context: RouteContext) => void | Promise<void>;
