import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  evaluateRewriteGate,
  rewriteQuery,
  TRICKY_REWRITE_QUERIES,
} from '../src/query/query-rewriter.js';
import { chunkMarkdown } from '../src/ingest/chunker.js';
import { createSearcher } from '../src/retrieval/search.js';
import { embedText } from '../src/retrieval/embeddings.js';
import { DocumentStore } from '../src/ingest/doc-store.js';
import { IncrementalIndexer } from '../src/ingest/reindexer.js';
import { runSearchAgent } from '../src/ranking/search-agent.js';
import { buildContext, assertContextFits } from '../src/generation/context-builder.js';
import { stablePrefix, PromptCacheLedger } from '../src/generation/prompt-cache.js';
import { ModelRouter } from '../src/generation/model-router.js';
import { FallbackChain, FallbackExhaustedError } from '../src/generation/fallback-chain.js';
import {
  responseEnvelope,
  validateStructuredOutput,
  partialAnswer,
} from '../src/generation/structured-output.js';
import { generateInfrastructure } from '../src/generation/generator.js';
import { setLlmProvider } from '../src/generation/local-claude.js';
import { TOOL_DEFINITIONS, executeTool, type ToolRuntime } from '../src/generation/tools.js';
import { runAgentLoop, deterministicToolDecision, type AgentMessage } from '../src/generation/agent-loop.js';
import { computeResponseConfidence, numericFidelity } from '../src/verification/confidence-scorer.js';
import { ReviewQueue, seedDefaultReviewQueue } from '../src/handoff/review-queue.js';
import { evaluateHandoffTriggers, HumanHandoff } from '../src/handoff/human-handoff.js';
import { gradeResponseWithJudge } from '../src/evals/llm-judge.js';
import { GOLDEN_QUESTIONS } from '../src/evals/golden-questions.js';
import { evaluateGolden, runGoldenEvaluation } from '../src/evals/golden-eval.js';
import { QualityMeter } from '../src/evals/quality-meter.js';
import type { SearchTelemetry, RerankedItem } from '../src/types.js';
const docs = path.resolve('docs');
const fakeChunk = (id: string, text: string, sourceFile = id + '.md'): RerankedItem => ({
  id,
  sourceFile,
  headingPath: text,
  prefixedText: text,
  bm25Score: 1,
  bm25Rank: 1,
  bm25RrfScore: 0.03,
  vectorSimilarity: 0.8,
  vectorRank: 1,
  vectorRrfScore: 0.03,
  rrfScore: 0.06,
  rrfRank: 1,
  isRelevant: true,
  formula: '',
  roles: ['all'],
  rerankScore: 0.95,
  rerankRank: 1,
  rankDelta: 0,
  keptForLlm: true,
  rerankFormula: '',
});
const telemetry = (results: RerankedItem[], score = 0.95) =>
  ({
    query: '',
    topK: 3,
    shortlistTopK: 8,
    finalTopK: 3,
    rrfK: 30,
    minVectorSimilarity: 0.25,
    minRerankScore: 0,
    relevant: results.length > 0,
    maxBm25Score: 1,
    maxVectorSimilarity: score,
    maxRerankScore: score,
    rerankerBackend: 'mock',
    results,
    bm25List: [],
    vectorList: [],
    rrfShortlist: results,
    fusedResults: results,
    reranked: results,
  }) as SearchTelemetry;
const runtime: ToolRuntime = {
  roles: ['admin', 'billing', 'engineering', 'all'],
  baseUrl: 'http://127.0.0.1:3000',
  search: async ({ query: q }) => ({
    results: [fakeChunk('billing', q, 'billing-and-refunds.md')],
  }),
};
describe('A · Gated query rewriting', () => {
  it('tricky short query triggers only one rewrite invocation', async () => {
    let calls = 0;
    const r = await rewriteQuery({
      query: 'idp cert exp',
      history: [],
      invoke: async () => {
        calls++;
        return 'SAML_CERT_EXPIRED signing certificate rotation';
      },
    });
    assert.equal(calls, 1);
    assert.equal(r.needsRewrite, true);
    assert.match(r.rewrittenQuery, /SAML_CERT_EXPIRED/);
  });
  it('rewrite improves target section retrieval', async () => {
    const store = await DocumentStore.open({ docsDir: docs }),
      idx = await new IncrementalIndexer({ store }).initialize();
    const q = 'wh hmac hdr',
      r = await rewriteQuery({ query: q });
    const raw = await idx.searcher.search({ query: q }),
      enhanced = await idx.searcher.search({ query: r.rewrittenQuery });
    assert.ok(enhanced.maxRerankScore > raw.maxRerankScore);
    assert.ok(enhanced.results.some((c) => c.sourceFile === 'api-and-webhooks.md'));
  });
  it('self-contained question skips model and has zero rewrite tokens', async () => {
    const r = await rewriteQuery({
      query: 'What is the refund policy for first-time annual subscriptions?',
      history: [],
      invoke: async () => {
        throw new Error('must not call');
      },
    });
    assert.equal(r.needsRewrite, false);
    assert.equal(r.tokensUsed, 0);
  });
  it('unrelated ambiguous query remains weak after rewriting', async () => {
    const idx = await new IncrementalIndexer({
      store: await DocumentStore.open({ docsDir: docs }),
    }).initialize();
    const r = await rewriteQuery({ query: 'quasar?' });
    assert.equal(r.needsRewrite, true);
    const hit = await idx.searcher.search({ query: r.rewrittenQuery });
    assert.ok(hit.maxRerankScore < 0.55);
    assert.ok(TRICKY_REWRITE_QUERIES.length >= 7);
  });
  it('pronouns and elliptical follow-ups are detected', () => {
    assert.equal(
      evaluateRewriteGate({
        query: 'How long does that take after I retry it?',
        history: [{ role: 'user', content: 'ERR_PAYMENT_402' }],
      }).needsRewrite,
      true,
    );
  });
});
describe('B · Contextual chunk ingestion', () => {
  it('prepends the parent and section header without mutating raw content', () => {
    const [c] = chunkMarkdown({
      markdown: '# Billing\n\n## Refunds\n\nRefunds take ten days.',
      sourceFile: 'billing-and-refunds.md',
    });
    assert.match(c.contextHeader!, /^From Billing, covering Refunds/);
    assert.ok(c.contextualizedContent!.startsWith(c.contextHeader!));
    assert.equal(c.rawContent, 'Refunds take ten days.');
    assert.ok(c.roles.includes('billing'));
  });
  it('embeds the contextual text and returns header plus access metadata', async () => {
    const inputs: string[] = [];
    const idx = await new IncrementalIndexer({
      store: await DocumentStore.open({ docsDir: docs }),
      embed: async ({ text: s }) => {
        inputs.push(s);
        return embedText({ text: s });
      },
    }).initialize();
    assert.ok(inputs.every((s) => s.startsWith('From ')));
    const result = await idx.searcher.search({ query: 'ERR_PAYMENT_402' });
    assert.ok(result.results.length);
    assert.ok(result.results.every((c) => c.contextHeader && c.roles?.length));
  });
});
describe('C · Multi-pass search agent', () => {
  it('stops high-confidence single facet in pass one', async () => {
    const r = await runSearchAgent({
      query: 'refund',
      search: async () => telemetry([fakeChunk('refund', 'refund approved')]),
    });
    assert.equal(r.iterations, 1);
    assert.equal(r.terminationReason, 'confident');
  });
  it('refines a two-document comparison and accumulates both', async () => {
    let calls = 0;
    const r = await runSearchAgent({
      query: 'compare refund and SSO',
      search: async (q) =>
        telemetry([
          calls++ === 0
            ? fakeChunk('bill', 'refund policy', 'billing.md')
            : fakeChunk('auth', 'SSO policy', 'auth.md'),
        ]),
      options: { facets: ['refund', 'SSO'] },
    });
    assert.equal(r.iterations, 2);
    assert.equal(new Set(r.retrieval.results.map((c) => c.sourceFile)).size, 2);
    assert.equal(r.passes[0].refinedQuery, 'SSO');
  });
  it('cuts off after four low-confidence passes', async () => {
    const r = await runSearchAgent({
      query: 'unavailable facet',
      search: async () => telemetry([], 0.1),
    });
    assert.equal(r.iterations, 4);
    assert.equal(r.terminationReason, 'max_iterations');
  });
});
describe('D · SQLite triggers and incremental re-indexing', () => {
  it('all three actual SQL triggers are installed', async () => {
    const s = await DocumentStore.open({ docsDir: docs });
    assert.equal(s.status().triggers?.length, 3);
  });
  it('updates only one changed chunk and reuses all remaining vectors', async () => {
    const store = await DocumentStore.open({ docsDir: docs }),
      idx = await new IncrementalIndexer({ store }).initialize(),
      id = 'api-and-webhooks.md';
    const prior = idx.chunks.filter((c) => c.sourceFile === id);
    store.write({ id, content: store.read({ id })!.replace('300', '301') });
    assert.equal(store.queue().at(-1)!.operation, 'update');
    const [r] = await idx.drain();
    assert.equal(r.embeddings, 1);
    assert.equal(r.reused, prior.length - 1);
    const unchanged = idx.chunks.find((c) => c.id === prior[0].id);
    assert.equal(unchanged, prior[0]);
  });
  it('skips an identical write with no embeddings', async () => {
    const s = await DocumentStore.open({ docsDir: docs }),
      idx = await new IncrementalIndexer({ store: s }).initialize();
    s.write({ id: 'api-and-webhooks.md', content: s.read({ id: 'api-and-webhooks.md' })! });
    const [r] = await idx.drain();
    assert.equal(r.status, 'skipped');
    assert.equal(r.embeddings, 0);
  });
  it('deletes a document from both vector and word indexes', async () => {
    const s = await DocumentStore.open({ docsDir: docs }),
      idx = await new IncrementalIndexer({ store: s }).initialize();
    s.delete({ id: 'api-and-webhooks.md' });
    assert.equal(s.queue().at(-1)!.operation, 'delete');
    await idx.drain();
    assert.ok(!idx.chunks.some((c) => c.sourceFile === 'api-and-webhooks.md'));
    assert.ok(
      !(await idx.searcher.search({ query: 'X-Hub-Signature-256' })).results.some(
        (c) => c.sourceFile === 'api-and-webhooks.md',
      ),
    );
  });
  it('insert trigger indexes a new database document', async () => {
    const s = await DocumentStore.open({ docsDir: docs }),
      idx = await new IncrementalIndexer({ store: s }).initialize();
    s.write({ id: 'new.md', content: '# New\n\n## Item\n\nUnique operational policy.' });
    assert.equal(s.queue().at(-1)!.operation, 'insert');
    await idx.drain();
    assert.ok(idx.chunks.some((c) => c.sourceFile === 'new.md'));
  });
});
describe('E · Context growth-rate compaction', () => {
  it('assembles five ordered blocks under budget', async () => {
    const r = await buildContext({
      input: {
        systemPrompt: 'support policy',
        tools: [],
        retrievedChunks: ['refund policy'],
        turns: [{ role: 'user', content: 'Hello' }],
        question: 'Refund?',
        hardTokenLimit: 2000,
      },
    });
    assert.equal(r.steps.length, 5);
    assert.equal(r.compacted, false);
    assert.equal(r.fitsInWindow, true);
    assert.ok(r.steps.every((s, i) => !i || s.runningTokens >= r.steps[i - 1].runningTokens));
  });
  it('compacts early on per-turn growth and preserves recent turns', async () => {
    const turns = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: ('turn ' + i + ' ').repeat(140),
    }));
    const r = await buildContext({
      input: {
        systemPrompt: 'support',
        turns,
        question: 'continue',
        hardTokenLimit: 20000,
        maxTokensPerTurnRate: 160,
      },
    });
    assert.equal(r.triggerReason, 'growth_rate');
    assert.ok(r.summary.startsWith('[Compacted Conversation Summary]'));
    assert.deepEqual(
      r.after.turns.slice(-2).map((t) => t.content),
      turns.slice(-2).map((t) => t.content),
    );
    assert.ok(r.tokensReclaimed > 0);
  });
  it('rejects irreducible required content before model call', async () => {
    const r = await buildContext({
      input: {
        systemPrompt: 'mandatory '.repeat(1000),
        question: 'request',
        turns: [{ role: 'user', content: 'old '.repeat(2000) }],
        hardTokenLimit: 100,
      },
    });
    assert.equal(r.fitsInWindow, false);
    assert.throws(() => assertContextFits({ report: r }), /does not fit/);
    assert.equal(r.triggerReason, 'hard_window_cap');
  });
});
describe('F · Anthropic stable-prefix prompt caching', () => {
  it('prefix bytes and fingerprints stay identical across variable questions', () => {
    const a = stablePrefix({ systemInstruction: 'stable policy', tools: [...TOOL_DEFINITIONS] }),
      b = stablePrefix({
        systemInstruction: 'stable policy',
        tools: [...TOOL_DEFINITIONS].reverse(),
      });
    assert.equal(a.bytes, b.bytes);
    assert.equal(a.prefixHash, b.prefixHash);
    assert.equal(a.system.at(-1)!.cache_control?.type, 'ephemeral');
    assert.equal((a.tools.at(-1) as any).cache_control?.type, 'ephemeral');
  });
  it('miss writes estimated tokens', () => {
    const l = new PromptCacheLedger({ now: () => 1000 }),
      r = l.record({ model: 'haiku', prefixHash: 'prefix', prefixTokens: 1800 });
    assert.equal(r.hit, false);
    assert.equal(r.cacheCreationInputTokens, 1800);
    assert.equal(r.tokensSaved, 0);
  });
  it('hit saves tokens within five-minute model-specific TTL', () => {
    let now = 1000;
    const l = new PromptCacheLedger({ now: () => now });
    l.record({ model: 'haiku', prefixHash: 'prefix', prefixTokens: 1800 });
    assert.equal(
      l.record({ model: 'haiku', prefixHash: 'prefix', prefixTokens: 1800 }).tokensSaved,
      1800,
    );
    assert.equal(
      l.record({ model: 'sonnet', prefixHash: 'prefix', prefixTokens: 1800 }).hit,
      false,
    );
    now += 300001;
    assert.equal(l.record({ model: 'haiku', prefixHash: 'prefix', prefixTokens: 1800 }).hit, false);
  });
  it('uses actual provider usage rather than estimated ledger', () => {
    const l = new PromptCacheLedger();
    const r = l.record({
      model: 'haiku',
      prefixHash: 'prefix',
      prefixTokens: 1800,
      source: 'anthropic_usage',
      usage: { cache_read_input_tokens: 1234, cache_creation_input_tokens: 0 },
    });
    assert.equal(r.tokensSaved, 1234);
    assert.equal(r.source, 'anthropic_usage');
  });
});
describe('G · Model routing and approved fallback chain', () => {
  it('routes simple prompts to Haiku and analytical prompts upward', () => {
    const r = new ModelRouter();
    assert.equal(r.route({ query: 'Hello there' }).tier, 'small');
    const hard = r.route({
      query: 'Compare SSO and API failures. Why? How does retrying help?',
      activeTools: 2,
    });
    assert.equal(hard.tier, 'escalated');
    assert.equal(hard.signals.length, 5);
  });
  it('historical quality changes the routing evidence', () => {
    const r = new ModelRouter();
    r.observe({ query: 'invoice retry policy', model: 'claude-sonnet-4-5', quality: 0.98 });
    assert.equal(
      r.route({ query: 'invoice retry policy' }).signals.find((s) => s.id === 'historical_quality')!
        .active,
      true,
    );
  });
  it('primary succeeds without calling backups', async () => {
    const f = new FallbackChain(),
      r = await f.run({ primary: 'claude-haiku-4-5', invoke: async (model) => model });
    assert.equal(r.attempts.length, 1);
    assert.equal(r.model, 'claude-haiku-4-5');
  });
  for (const fault of ['HTTP 503', '429 rate_limit', 'timeout'])
    it('fallback catches ' + fault, async () => {
      const f = new FallbackChain(),
        r = await f.run({
          primary: 'claude-haiku-4-5',
          invoke: async ({ model }) => {
            if (model.includes('haiku')) throw new Error(fault);
            return 'ok';
          },
        });
      assert.equal(r.model, 'claude-sonnet-4-5');
      assert.equal(r.attempts[0].success, false);
      assert.equal(f.status().models[0].failureRate, 1);
    });
  it('exhaustion is explicit and optional local link is last', async () => {
    const f = new FallbackChain();
    await assert.rejects(
      f.run({
        primary: 'claude-haiku-4-5',
        invoke: async () => {
          throw new Error('503');
        },
      }),
      FallbackExhaustedError,
    );
    f.localEnabled = true;
    assert.equal(f.order({ primary: 'claude-opus-4-6' }).at(-1), 'ollama/qwen2.5:1.5b');
    assert.ok(
      f
        .order({ primary: 'claude-opus-4-6' })
        .slice(0, 3)
        .every((m) => m.startsWith('claude-')),
    );
  });
});
describe('H · Streaming and strict structured outputs', () => {
  it('valid structured response passes and partial fragments assemble', () => {
    const r = responseEnvelope({ answer: 'Hello support customer' });
    assert.equal(validateStructuredOutput({ input: JSON.stringify(r) }).answer, r.answer);
    let json = '';
    for (const part of ['{"answer":"Hello', ' support', ' customer"']) json += part;
    assert.equal(partialAnswer({ json }), 'Hello support customer');
  });
  it('malformed fields and unknown fields are rejected', () => {
    assert.throws(() => validateStructuredOutput({ input: { answer: 'x' } }), /Required field/);
    assert.throws(
      () =>
        validateStructuredOutput({
          input: { ...responseEnvelope({ answer: 'valid' }), confidence: 2 },
        }),
      /\[0,1\]/,
    );
    assert.throws(
      () =>
        validateStructuredOutput({ input: { ...responseEnvelope({ answer: 'valid' }), extra: 1 } }),
      /Unexpected key/,
    );
  });
  it('provider SSE emits incremental answer tokens and parses cache usage', async () => {
    const realFetch = globalThis.fetch;
    setLlmProvider({ provider: 'anthropic-api' });
    const answer = responseEnvelope({ answer: 'A streamed valid support answer.' });
    const json = JSON.stringify(answer),
      split = json.indexOf('valid');
    const frames = [
      { type: 'message_start', message: { usage: { cache_read_input_tokens: 1000 } } },
      { type: 'content_block_start', content_block: { name: 'support_response', id: 'final' } },
      { type: 'content_block_delta', delta: { partial_json: json.slice(0, split) } },
      { type: 'content_block_delta', delta: { partial_json: json.slice(split) } },
      { type: 'content_block_stop' },
      { type: 'message_stop' },
    ];
    const events: Array<{ event: string; data: any }> = [];
    let body: any;
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(frames.map((f) => 'data: ' + JSON.stringify(f) + '\n\n').join(''), {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };
    try {
      const r = await generateInfrastructure(
        { message: 'Check support policy', chunks: [fakeChunk('c', 'support policy')] },
        { emit: ({ event, data }) => events.push({ event, data }) },
      );
      assert.equal(
        events
          .filter((e) => e.event === 'token_delta')
          .map((e) => e.data.text)
          .join(''),
        answer.answer,
      );
      assert.equal(r.infrastructure.structured.validated, true);
      assert.equal(body.stream, true);
      assert.equal(body.system.at(-1).cache_control.type, 'ephemeral');
      assert.ok(events.some((e) => e.event === 'prompt_cache' && e.data.tokensSaved === 1000));
    } finally {
      globalThis.fetch = realFetch;
      setLlmProvider({ provider: 'mock' });
    }
  });
  it('mid-stream interruption emits errors and exhausts safely', async () => {
    const realFetch = globalThis.fetch;
    setLlmProvider({ provider: 'anthropic-api' });
    const events: string[] = [];
    globalThis.fetch = async () =>
      new Response(
        'data: ' +
          JSON.stringify({
            type: 'content_block_start',
            content_block: { name: 'support_response', id: 'x' },
          }) +
          '\n\ndata: ' +
          JSON.stringify({
            type: 'content_block_delta',
            delta: { partial_json: '{"answer":"unfinished' },
          }) +
          '\n\n',
      );
    try {
      await assert.rejects(
        generateInfrastructure(
          { message: 'Check support policy', chunks: [fakeChunk('c', 'support policy')] },
          { emit: ({ event }) => events.push(event) },
        ),
        /All permitted/,
      );
      assert.ok(events.includes('stream_error'));
      assert.ok(!events.includes('structured_output'));
    } finally {
      globalThis.fetch = realFetch;
      setLlmProvider({ provider: 'mock' });
    }
  });
});
describe('I · Callable tools and bounded agent workflow', () => {
  it('search tool calls the hybrid search runtime', async () => {
    const r = (await executeTool({
      name: 'search_support_docs',
      input: { query: 'refund' },
      runtime,
    })) as any;
    assert.ok(r.results[0].url.includes('/docs/'));
  });
  it('ticket lookup returns seeded case and enforces access', async () => {
    const r = (await executeTool({
      name: 'lookup_support_ticket',
      input: { ticketId: 'TCK-1042' },
      runtime,
    })) as any;
    assert.equal(r.found, true);
    assert.equal(r.ticket.id, 'TCK-1042');
    await assert.rejects(
      executeTool({ name: 'lookup_support_ticket', input: { ticketId: 'bad' }, runtime }),
    );
  });
  it('escalation creates a local support record with summary', async () => {
    const r = (await executeTool({
      name: 'escalate_to_human_agent',
      input: { summary: 'Renewal unresolved after retries', severity: 'high', queue: 'billing' },
      runtime,
    })) as any;
    assert.match(r.id, /^ESC-/);
  });
  it('chooses ticket, document, and escalation tools in order', () => {
    assert.equal(
      deterministicToolDecision({ query: 'Look up TCK-1042', messages: [] })[0].name,
      'lookup_support_ticket',
    );
    assert.equal(
      deterministicToolDecision({ query: 'Refund policy', messages: [] })[0].name,
      'search_support_docs',
    );
    const done = [
      { role: 'assistant', content: [{ name: 'search_support_docs' }] },
    ] as AgentMessage[];
    assert.equal(
      deterministicToolDecision({ query: 'Escalate to human', messages: done })[0].name,
      'escalate_to_human_agent',
    );
  });
  it('single tool call resolves after one tool round and a final model turn', async () => {
    const r = await runAgentLoop({
      runtime,
      invoke: async ({ messages: m }) =>
        m.length
          ? { response: responseEnvelope({ answer: 'Resolved support request' }) }
          : {
              toolCalls: [
                { id: 'one', name: 'lookup_support_ticket', arguments: { ticketId: 'TCK-1042' } },
              ],
            },
    });
    assert.equal(r.steps.filter((s) => s.phase === 'tool').length, 1);
    assert.equal(r.iterations, 2);
    assert.equal((r.messages[1].content as any[])[0].type, 'tool_result');
  });
  it('multi-step search then escalation is observable', async () => {
    const r = await runAgentLoop({
      runtime,
      invoke: async ({ iteration: i }) =>
        i === 1
          ? {
              toolCalls: [{ id: 's', name: 'search_support_docs', arguments: { query: 'refund' } }],
            }
          : i === 2
            ? {
                toolCalls: [
                  {
                    id: 'e',
                    name: 'escalate_to_human_agent',
                    arguments: {
                      summary: 'Refund needs human review',
                      severity: 'high',
                      queue: 'billing',
                    },
                  },
                ],
              }
            : { response: responseEnvelope({ answer: 'Escalation recorded locally.' }) },
    });
    assert.deepEqual(r.toolsInvoked, ['search_support_docs', 'escalate_to_human_agent']);
    assert.match(r.escalationId!, /^ESC-/);
  });
  it('cuts off at exactly five model iterations', async () => {
    const r = await runAgentLoop({
      runtime,
      invoke: async () => ({
        toolCalls: [
          { id: 'repeat', name: 'search_support_docs', arguments: { query: 'unresolved' } },
        ],
      }),
    });
    assert.equal(r.iterations, 5);
    assert.equal(r.terminatedBy, 'max_iterations');
    assert.equal(r.response, null);
  });
});
describe('J · Confidence and seeded response review', () => {
  const good = {
    citation: { entailmentCheck: { passed: true } },
    retrievalStrength: 0.95,
    schemaValid: true,
    numericFidelity: 1,
    modelConfidence: 0.9,
  };
  it('high confidence passes and low confidence is queued', () => {
    assert.equal(computeResponseConfidence(good).disposition, 'auto_released');
    const c = computeResponseConfidence({ ...good, schemaValid: false });
    assert.equal(c.disposition, 'held_for_review');
    const q = new ReviewQueue();
    q.enqueue({
      input: {
        question: 'Invalid output',
        ...c,
        originalSources: [],
        proposedOutput: { answer: 'x' },
      },
    });
    assert.equal(q.state().pending, 1);
  });
  it('model self-report never dominates and invoice mismatch is caught', () => {
    const r = computeResponseConfidence({ ...good, numericFidelity: 0, modelConfidence: 1 });
    assert.ok(r.signalBreakdown.modelSelfReport.weight <= 0.15);
    assert.ok(r.caughtReasons.includes('invoice_parse_mismatch'));
    assert.equal(numericFidelity({ answer: 'Total $12,400.00', sources: ['Total $1,240.00'] }), 0);
    assert.ok(r.confidenceScore < 0.72);
  });
  it('all four seed categories are pending including the 10x invoice error', () => {
    const q = new ReviewQueue();
    seedDefaultReviewQueue({ queue: q });
    assert.equal(q.state().pending, 4);
    assert.equal(new Set(q.state().items.map((i) => i.category)).size, 4);
    assert.ok(JSON.stringify(q.state()).includes('INV-2026-0841'));
  });
  it('approve, edit/release, reject transitions and pattern tracking work', () => {
    const q = new ReviewQueue();
    seedDefaultReviewQueue({ queue: q });
    q.action({ id: 'REV-SEED-01', action: 'approve' });
    q.action({ id: 'REV-SEED-02', action: 'edit', notes: '', answer: 'Corrected answer' });
    q.action({ id: 'REV-SEED-04', action: 'reject', notes: 'Decimal shift' });
    assert.equal(q.state().releasedResponses.length, 2);
    assert.equal(q.state().releasedResponses[1].answer, 'Corrected answer');
    assert.equal(q.state().rejectionPatterns.invoice_parse_mismatch, 1);
    assert.throws(() => q.action({ id: 'REV-SEED-01', action: 'reject' }), /already resolved/);
  });
});
describe('K · Warm transfer and stuck-conversation detection', () => {
  it('detects repeated answers', () => {
    const t = [
      { role: 'assistant', content: 'Update your card and retry the failed payment.' },
      { role: 'assistant', content: 'Update your card and retry the failed payment.' },
    ];
    assert.equal(evaluateHandoffTriggers({ turns: t }).triggerReason, 'stuck_bot');
  });
  it('detects repeated and explicit requests for a person', () => {
    assert.equal(
      evaluateHandoffTriggers({
        turns: [
          { role: 'user', content: 'Need a human' },
          { role: 'user', content: 'A real person please' },
        ],
      }).triggerReason,
      'repeated_human_request',
    );
    assert.equal(
      evaluateHandoffTriggers({ turns: [{ role: 'user', content: 'Talk to a human' }] })
        .triggerReason,
      'explicit_human_request',
    );
  });
  it('handles sensitive disputes and low confidence', () => {
    assert.equal(
      evaluateHandoffTriggers({ turns: [{ role: 'user', content: 'Disputed invoice overcharge' }] })
        .triggerReason,
      'sensitive_billing_dispute',
    );
    assert.equal(
      evaluateHandoffTriggers({ turns: [], confidenceScore: 0.2 }).triggerReason,
      'low_confidence',
    );
  });
  it('payload includes full history, generated summary, diagnostics and next steps', () => {
    const h = new HumanHandoff(),
      turns = [{ role: 'user', content: 'Please transfer me to a human' }],
      r = h.create({ turns, confidenceScore: 0.4, reviewQueueItems: ['REV-ONE'] })!;
    assert.equal(r.conversationHistory.length, turns.length);
    assert.ok(r.conversationSummary.includes('human'));
    assert.deepEqual(r.reviewQueueItems, ['REV-ONE']);
    assert.match(r.escalationId, /^ESC-/);
    assert.ok(r.triggerDiagnostics);
    assert.match(r.customerMessage, /full history/);
    assert.match(r.customerMessage, /external dispatch is not connected/i);
  });
});
describe('L · Rubric judge and twenty-question full-pipeline replay', () => {
  const facts = 'Approved refunds appear on the original payment method within 5–10 business days.';
  const input = {
    question: 'When does a refund appear?',
    answer: facts,
    sources: [{ sourceFile: 'billing-and-refunds.md', text: facts }],
    expectedAnswer: facts,
    citationSupported: true,
  };
  it('high-quality response passes four dimensions', async () => {
    const r = await gradeResponseWithJudge(input);
    assert.equal(r.overallVerdict, 'pass');
    assert.equal(Object.keys(r.dimensions).length, 4);
  });
  it('unsupported response scores poorly', async () => {
    const r = await gradeResponseWithJudge({
      ...input,
      answer: 'Refund is $999999. Goodbye.',
      citationSupported: false,
    });
    assert.equal(r.overallVerdict, 'fail');
    assert.equal(r.dimensions.factualAccuracy.passed, false);
  });
  it('tone can fail independently while facts pass', async () => {
    const r = await gradeResponseWithJudge({ ...input, answer: facts + ' You idiot.' });
    assert.equal(r.dimensions.factualAccuracy.passed, true);
    assert.equal(r.dimensions.tone.passed, false);
    assert.equal(r.overallVerdict, 'fail');
  });
  it('strict required facts and sources independently detect drift', async () => {
    const q = GOLDEN_QUESTIONS[0];
    const pass = await evaluateGolden({
      question: q,
      actual: { answer: q.expectedAnswer, sources: [{ sourceFile: q.requiredSources[0] }] },
    });
    assert.equal(pass.status, 'passed');
    const bad = await evaluateGolden({
      question: q,
      actual: { answer: 'Different policy', sources: [] },
    });
    assert.deepEqual(bad.reasons, ['missing_required_facts', 'missing_required_sources']);
  });
  it('contains exactly twenty representative expectations', () => {
    assert.equal(GOLDEN_QUESTIONS.length, 20);
    assert.equal(GOLDEN_QUESTIONS.at(-1)!.id, 'GQ-20');
    assert.ok(
      GOLDEN_QUESTIONS.every(
        (q) => q.expectedAnswer && q.requiredSources.length && q.requiredKeywords.length,
      ),
    );
  });
  it('full twenty-question HTTP replay traverses the actual pipeline', async () => {
    const port = '3499';
    const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
      env: {
        ...process.env,
        PORT: port,
        MOCK_AI: 'true',
        FORCE_MOCK_LLM: 'true',
        FORCE_MOCK_GUARD: 'true',
        FORCE_MOCK_NLI: 'true',
        HOT_RELOAD: '0',
      },
      stdio: 'ignore',
    });
    try {
      let ready = false;
      for (let n = 0; n < 100; n++) {
        try {
          if ((await fetch('http://127.0.0.1:' + port + '/health')).ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(ready);
      const r = await fetch('http://127.0.0.1:' + port + '/api/eval/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const result = (await r.json()) as any;
      assert.equal(result.total, 20);
      assert.equal(
        result.passed,
        20,
        JSON.stringify(
          result.results
            .filter((r: any) => r.status !== 'passed')
            .map((r: any) => ({ id: r.id, reasons: r.reasons })),
        ),
      );
    } finally {
      child.kill('SIGTERM');
    }
  });
});
describe('M · Rolling quality and drift recovery', () => {
  const point = {
    responseConfidence: 0.9,
    citationPassRate: 0.98,
    promptGuardBlockRate: 0.05,
    retrievalMatchStrength: 0.85,
    schemaValidationRate: 1,
    llmJudgeScore: 0.9,
  };
  it('computes rolling average over configured sample window', () => {
    const q = new QualityMeter({ sampleWindow: 2 });
    q.record({ sample: { ...point, responseConfidence: 0.2 } });
    q.record({ sample: { ...point, responseConfidence: 0.8 } });
    q.record({ sample: { ...point, responseConfidence: 1 } });
    assert.equal(q.status().metrics.find((m) => m.metric === 'responseConfidence')!.value, 0.9);
  });
  it('low quality and guard-rate spike trigger visible drift alerts', () => {
    const q = new QualityMeter({ sampleWindow: 3 });
    q.batch({ degraded: true });
    assert.ok(q.status().metrics.every((m) => m.alertActive));
    assert.equal(
      q.status().metrics.find((m) => m.metric === 'promptGuardBlockRate')!.direction,
      'above',
    );
  });
  it('fresh healthy samples automatically clear and retain recovered state', () => {
    const q = new QualityMeter({ sampleWindow: 3 });
    q.batch({ degraded: true });
    q.batch({ degraded: false });
    assert.ok(q.status().metrics.every((m) => !m.alertActive));
    assert.ok(q.status().metrics.every((m) => m.status === 'recovered'));
  });
  it('startup history contains twenty-eight points with an active alert', () => {
    const q = new QualityMeter();
    q.seed();
    assert.equal(q.status().sampleCount, 28);
    assert.ok(q.status().metrics.some((m) => m.alertActive));
  });
});
