/**
 * Why this file exists: the model may act only through three named tools.
 * This file lists them and checks every call before it runs. Without it, a
 * model could send bad arguments, or read tickets its caller's roles forbid.
 */
import { lookupTicket, ticketStore } from './ticket-store.js';
import { sourceDocUrl } from './citation-checker.js';

/**
 * The three tools the model may call, in the JSON Schema form Anthropic's API takes.
 * The generator also reads the names to check what the model asks for.
 * The `topK` limit of 5 and the escalation limits are enforced again in `executeTool`.
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'search_support_docs',
    description:
      'Run role-filtered BM25 + vector + RRF + cross-encoder support-document retrieval.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1 },
        topK: { type: 'integer', minimum: 1, maximum: 5 },
      },
    },
  },
  {
    name: 'lookup_support_ticket',
    description: 'Look up a support case visible to the current caller by TCK ID.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ticketId'],
      properties: { ticketId: { type: 'string', pattern: '^TCK-[0-9]+$' } },
    },
  },
  {
    name: 'escalate_to_human_agent',
    description:
      'Record a local human-agent handoff. This records an escalation; it does not send an external message.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'severity', 'queue'],
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 4000 },
        severity: { enum: ['low', 'medium', 'high', 'critical'] },
        queue: { enum: ['billing', 'engineering', 'privacy', 'general'] },
        ticketId: { type: 'string' },
      },
    },
  },
] as const;

/** What the tools need from the current request. */
export interface ToolRuntime {
  /** Roles of the person asking. Tickets and escalations are checked against them. */
  roles: string[];
  /** Site address that document links are built from. */
  baseUrl: string;
  /** Runs a document search for the model. */
  search: ({ query, topK }: { query: string; topK: number }) => Promise<{
    results: Array<{ sourceFile: string; headingPath: string; prefixedText: string }>;
    [key: string]: unknown;
  }>;
}

type ExecuteToolParams = { name: string; input: unknown; runtime: ToolRuntime };

/**
 * Checks one tool call from the model, then runs it.
 * Throws on any bad call. The caller turns that into an error result for the model.
 *
 * Checks, in order: arguments are an object, the tool exists, no unknown
 * arguments, no missing required ones, then the rules of that tool.
 *
 * search_support_docs: runs the search and adds a link to each result.
 * `topK` defaults to 3 and must be a whole number from 1 to 5.
 * lookup_support_ticket: returns the ticket if the caller's roles may see it.
 * escalate_to_human_agent: records a handoff in the local ticket store.
 * It sends no outside message.
 * A ticket named in it must exist and be visible to the caller.
 * The billing queue needs the billing or admin role.
 */
export async function executeTool({ name, input, runtime }: ExecuteToolParams): Promise<unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Tool arguments must be an object');
  const a = input as Record<string, unknown>,
    definition = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!definition) throw new Error('Unknown domain tool');
  const schema = definition.input_schema;
  for (const k of Object.keys(a))
    if (!Object.hasOwn(schema.properties, k)) throw new Error('Unexpected tool argument ' + k);
  for (const k of schema.required)
    if (!Object.hasOwn(a, k)) throw new Error('Missing tool argument ' + k);
  if (name === 'search_support_docs') {
    if (typeof a.query !== 'string' || !a.query.trim()) throw new Error('query must be non-empty');
    const k = a.topK ?? 3;
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > 5)
      throw new Error('topK must be 1–5');
    const result = await runtime.search({ query: a.query, topK: k });
    return {
      ...result,
      results: result.results.map((c) => ({
        ...c,
        url: sourceDocUrl({ baseUrl: runtime.baseUrl, source: c }),
      })),
    };
  }
  if (name === 'lookup_support_ticket') {
    if (typeof a.ticketId !== 'string' || !/^TCK-\d+$/i.test(a.ticketId))
      throw new Error('Invalid ticketId');
    return lookupTicket({ id: a.ticketId, roles: runtime.roles });
  }
  /** Every other known tool name is the escalation tool, so it is checked here. */
  if (typeof a.summary !== 'string' || !a.summary.trim() || a.summary.length > 4000)
    throw new Error('summary must contain 1–4000 characters');
  if (
    !['low', 'medium', 'high', 'critical'].includes(String(a.severity)) ||
    !['billing', 'engineering', 'privacy', 'general'].includes(String(a.queue))
  )
    throw new Error('Invalid escalation severity/queue');
  if (
    a.ticketId !== undefined &&
    (typeof a.ticketId !== 'string' ||
      !lookupTicket({ id: a.ticketId, roles: runtime.roles }).found)
  )
    throw new Error('Ticket not found or not authorized');
  if (a.queue === 'billing' && !runtime.roles.some((r) => ['billing', 'admin'].includes(r)))
    throw new Error('Billing escalation not authorized');
  return ticketStore.create({
    summary: a.summary,
    severity: a.severity as 'low' | 'medium' | 'high' | 'critical',
    queue: String(a.queue),
    ticketId: typeof a.ticketId === 'string' ? a.ticketId : null,
  });
}
