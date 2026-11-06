/**
 * Why this file exists: the model asks for tools one round at a time, and
 * something must run them and send the results back. This file runs that loop
 * with a hard stop. Without the stop, a model that keeps asking for tools
 * would never finish.
 */
import { executeTool, type ToolRuntime } from './tools.js';
import type { SupportResponse } from './structured-output.js';

/** One tool the model asked to run. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** One message in the conversation between the loop and the model. */
export interface AgentMessage {
  role: 'assistant' | 'user';
  content: unknown;
}

/**
 * What the model chose in one round: tools to run, or the final answer.
 * If both are set and there are tool calls: the tools run first.
 */
export interface AgentDecision {
  toolCalls?: ToolCall[];
  response?: SupportResponse;
}

/**
 * One progress event, sent to the page while the loop runs.
 * Phase "model": waiting for the model.
 * Phase "tool": one tool has run.
 * Phase "final": the model's answer passed validation.
 * Phase "cutoff": the round limit was reached.
 * `latencyMs` is in milliseconds.
 */
export interface AgentStep {
  iteration: number;
  maxIterations: number;
  phase: 'model' | 'tool' | 'final' | 'cutoff';
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  latencyMs: number;
  decision?: unknown;
}

/**
 * Runs rounds of model call and tool calls until the model gives a final answer.
 * Runs tools, which can record an escalation. Calls `onStep` as it goes.
 *
 * The round limit is `maxIterations`, kept between 1 and 5, and 5 if unset.
 * If the model gives a final answer and no tool calls: returns it.
 * If the model asks for 1 to 3 tools: runs them in order, sends the results back, and loops.
 * If a tool throws: the error text goes back to the model as that tool's result.
 * If the model gives neither a final answer nor 1 to 3 tools: throws.
 * If the limit is reached: returns `response: null` and `terminatedBy: 'max_iterations'`.
 * Without the limit, a confused model could call tools forever.
 */
export async function runAgentLoop(options: {
  invoke: ({
    messages,
    iteration,
  }: {
    messages: AgentMessage[];
    iteration: number;
  }) => Promise<AgentDecision>;
  runtime: ToolRuntime;
  maxIterations?: number;
  onStep?: ({ step }: { step: AgentStep }) => void | Promise<void>;
}) {
  const max = Math.min(5, Math.max(1, options.maxIterations ?? 5)),
    messages: AgentMessage[] = [],
    steps: AgentStep[] = [],
    toolsInvoked: string[] = [];
  let escalationId: string | null = null;
  for (let iteration = 1; iteration <= max; iteration++) {
    const start = performance.now();
    await options.onStep?.({
      step: { iteration, maxIterations: max, phase: 'model', latencyMs: 0 },
    });
    const decision = await options.invoke({ messages, iteration });
    if (decision.response && !decision.toolCalls?.length) {
      const step = {
        iteration,
        maxIterations: max,
        phase: 'final' as const,
        latencyMs: performance.now() - start,
        decision: 'Validated final response',
      };
      steps.push(step);
      await options.onStep?.({ step });
      return {
        response: { ...decision.response, toolsInvoked, escalationId },
        terminatedBy: 'final_answer' as const,
        iterations: iteration,
        steps,
        messages,
        toolsInvoked,
        escalationId,
      };
    }
    if (!decision.toolCalls?.length || decision.toolCalls.length > 3)
      throw new Error('Model must return a final response or 1–3 approved tool calls');
    messages.push({
      role: 'assistant',
      content: decision.toolCalls.map((c) => ({
        type: 'tool_use',
        id: c.id,
        name: c.name,
        input: c.arguments,
      })),
    });
    const results = [];
    for (const call of decision.toolCalls) {
      const t = performance.now();
      let result: unknown;
      try {
        result = await executeTool({
          name: call.name,
          input: call.arguments,
          runtime: options.runtime,
        });
      } catch (e) {
        result = { error: (e as Error).message };
      }
      toolsInvoked.push(call.name);
      if (
        result &&
        typeof result === 'object' &&
        'id' in result &&
        String(result.id).startsWith('ESC-')
      )
        escalationId = String(result.id);
      const step = {
        iteration,
        maxIterations: max,
        phase: 'tool' as const,
        tool: call.name,
        arguments: call.arguments,
        result,
        latencyMs: performance.now() - t,
      };
      steps.push(step);
      await options.onStep?.({ step });
      results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: results });
  }
  const step = {
    iteration: max,
    maxIterations: max,
    phase: 'cutoff' as const,
    latencyMs: 0,
    decision: 'Hard iteration limit reached',
  };
  steps.push(step);
  await options.onStep?.({ step });
  return {
    response: null,
    terminatedBy: 'max_iterations' as const,
    iterations: max,
    steps,
    messages,
    toolsInvoked,
    escalationId,
  };
}

/**
 * Picks the next tool calls for offline mode, with no model involved.
 * Pure. Reads the earlier messages to see which tools have already run.
 *
 * If the query holds a ticket id like TCK-12 and no lookup has run: looks it up.
 * Then, if no search has run: searches the documents.
 * Then, if the query asks for escalation and none has run: escalates.
 * The queue is billing if the query mentions billing, payment or 402. Otherwise it is general.
 * The severity is critical if the query says so. Otherwise it is high.
 * If everything needed has run: returns an empty list, which ends the tool phase.
 */
export function deterministicToolDecision({
  query,
  messages,
}: {
  query: string;
  messages: AgentMessage[];
}): ToolCall[] {
  const done = new Set(
    messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) =>
        Array.isArray(m.content) ? m.content.map((c: { name?: string }) => c.name) : [],
      ),
  );
  const ticket = query.match(/TCK-\d+/i)?.[0]?.toUpperCase();
  /** Builds one tool call with an id that is unique for this round and tool. */
  const call = ({ name, args }: { name: string; args: Record<string, unknown> }) => ({
    id: 'tool-' + messages.length + '-' + name,
    name,
    arguments: args,
  });
  if (ticket && !done.has('lookup_support_ticket'))
    return [call({ name: 'lookup_support_ticket', args: { ticketId: ticket } })];
  if (!done.has('search_support_docs'))
    return [call({ name: 'search_support_docs', args: { query } })];
  if (
    /escalat|handoff|human|critical|unresolved/i.test(query) &&
    !done.has('escalate_to_human_agent')
  )
    return [
      call({
        name: 'escalate_to_human_agent',
        args: {
          summary: query,
          severity: /critical/i.test(query) ? 'critical' : 'high',
          queue: /billing|payment|402/i.test(query) ? 'billing' : 'general',
          ...(ticket ? { ticketId: ticket } : {}),
        },
      }),
    ];
  return [];
}
