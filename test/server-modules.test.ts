import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toChatRequest } from '../src/chat-request.js';
import { buildChunkingTelemetry } from '../src/ingest/chunking-telemetry.js';
import { parseConversationTurns } from '../src/query/conversation-turns.js';
import {
  buildErrorResponse,
  createHttpError,
  isHttpError,
  runOrRejectWithBadRequest,
} from '../src/http-exchange.js';
import { applyRetrievalOverrides } from '../src/retrieval/retrieval-overrides.js';
import type { SearchTelemetry } from '../src/types.js';

/**
 * A search result with only the fields these tests read. The real type has
 * dozens of fields that the code under test never touches.
 */
const buildRetrieval = ({
  sourceFiles,
  isRelevant = true,
}: {
  sourceFiles: string[];
  isRelevant?: boolean;
}) =>
  ({
    relevant: isRelevant,
    maxRerankScore: 0.8,
    results: sourceFiles.map((sourceFile) => ({
      sourceFile,
      headingPath: 'Heading',
      prefixedText: 'text',
    })),
  }) as unknown as SearchTelemetry;

const expectBadRequest = ({ run, message }: { run: () => unknown; message: RegExp }): void =>
  assert.throws(
    run,
    (error: unknown) =>
      isHttpError(error) && error.statusCode === 400 && message.test(error.message),
  );

describe('error replies', () => {
  it('shows the caller the message of an error a route threw on purpose', () => {
    const error = createHttpError({
      statusCode: 403,
      message: 'Not allowed',
      details: { hint: 'log in' },
    });

    assert.deepEqual(buildErrorResponse({ error, requestId: 'req-1' }), {
      statusCode: 403,
      body: { error: 'Not allowed', hint: 'log in' },
    });
  });

  it('hides the message of an unexpected error and gives the request id instead', () => {
    const { statusCode, body } = buildErrorResponse({
      error: new Error('connect ECONNREFUSED 10.0.0.5:5432'),
      requestId: 'req-2',
    });

    assert.equal(statusCode, 500);
    assert.deepEqual(body, { error: 'Could not complete this request.', requestId: 'req-2' });
  });

  it('reports a plain validation error as a 400 with the same message', () => {
    expectBadRequest({
      run: () =>
        runOrRejectWithBadRequest({
          run: () => {
            throw new Error('threshold must be between 0.10 and 0.99');
          },
        }),
      message: /threshold must be between/,
    });
  });

  it('returns the value when the check passes', () => {
    assert.equal(runOrRejectWithBadRequest({ run: () => 42 }), 42);
  });
});

describe('chat requests', () => {
  it('reads the question from query when message is missing', () => {
    assert.equal(
      toChatRequest({ body: { query: 'How do refunds work?' } }).message,
      'How do refunds work?',
    );
  });

  it('treats a topK of 0 or text as "use the default"', () => {
    assert.equal(toChatRequest({ body: { message: 'x', topK: 0 } }).topK, undefined);
    assert.equal(toChatRequest({ body: { message: 'x', topK: 'many' } }).topK, undefined);
    assert.equal(toChatRequest({ body: { message: 'x', topK: '4' } }).topK, 4);
  });

  it('rejects a semantic cache threshold outside 0.10 to 0.99 with a 400', () => {
    expectBadRequest({
      run: () => toChatRequest({ body: { message: 'x', cacheThreshold: 2 } }),
      message: /threshold/,
    });
  });

  it('keeps a valid semantic cache threshold', () => {
    assert.equal(
      toChatRequest({ body: { message: 'x', cacheThreshold: 0.5 } }).semanticCacheThreshold,
      0.5,
    );
  });

  it('rejects injected failures that are not text with a 400', () => {
    expectBadRequest({
      run: () => toChatRequest({ body: { message: 'x', faults: { model: 3 } } }),
      message: /faults/,
    });
  });

  it('only bypasses the semantic cache when the request says exactly true', () => {
    assert.equal(
      toChatRequest({ body: { message: 'x', bypassCache: 'true' } }).shouldBypassSemanticCache,
      false,
    );
    assert.equal(
      toChatRequest({ body: { message: 'x', bypassCache: true } }).shouldBypassSemanticCache,
      true,
    );
  });
});

describe('conversation turns', () => {
  it('treats a missing or non-list value as no turns', () => {
    assert.deepEqual(parseConversationTurns({ value: undefined, fieldName: 'history' }), []);
    assert.deepEqual(parseConversationTurns({ value: 'hello', fieldName: 'history' }), []);
  });

  it('keeps extra fields on a turn, because the hand-off package records them', () => {
    const turns = [{ role: 'user', content: 'hi', timestamp: '2026-11-06T00:00:00Z' }];

    assert.deepEqual(parseConversationTurns({ value: turns, fieldName: 'history' }), turns);
  });

  it('names the field in the 400 when a turn has no text content', () => {
    expectBadRequest({
      run: () =>
        parseConversationTurns({ value: [{ role: 'user', content: 7 }], fieldName: 'turns' }),
      message: /turns must be a list/,
    });
  });
});

describe('retrieval overrides', () => {
  it('counts a payment-error question as unanswered when the billing guide was not found', () => {
    const retrieval = buildRetrieval({ sourceFiles: ['sso-and-authentication.md'] });

    const result = applyRetrievalOverrides({
      retrieval,
      message: 'What is ERR_PAYMENT_402?',
      shouldSimulatePoison: false,
    });

    assert.equal(result.relevant, false);
    assert.deepEqual(result.results, []);
  });

  it('keeps the search as found when the billing guide is among the results', () => {
    const retrieval = buildRetrieval({ sourceFiles: ['billing-and-refunds.md'] });

    const result = applyRetrievalOverrides({
      retrieval,
      message: 'What is ERR_PAYMENT_402?',
      shouldSimulatePoison: false,
    });

    assert.equal(result, retrieval);
  });

  it('leaves a question about something else alone', () => {
    const retrieval = buildRetrieval({ sourceFiles: ['sso-and-authentication.md'] });

    const result = applyRetrievalOverrides({
      retrieval,
      message: 'How do I rotate a SAML certificate?',
      shouldSimulatePoison: false,
    });

    assert.equal(result, retrieval);
  });

  it('does not change the search result it was given', () => {
    const retrieval = buildRetrieval({ sourceFiles: ['sso-and-authentication.md'] });

    applyRetrievalOverrides({ retrieval, message: '402', shouldSimulatePoison: false });

    assert.equal(retrieval.relevant, true);
    assert.equal(retrieval.results.length, 1);
  });
});

describe('chunking report', () => {
  const searchSettings = {
    rrfK: 30,
    shortlistTopK: 8,
    finalTopK: 3,
    minVectorSimilarity: 0.25,
    minRerankScore: -2.5,
  };

  const buildReport = () =>
    buildChunkingTelemetry({
      documents: [
        { id: 'b-second.md', content: '# Second\n\nText.' },
        { id: 'a-first.md', content: '# First\n\n## Part\n\nBody.' },
      ],
      indexedChunks: [],
      searchSettings,
      rerankerBackend: 'mock',
      llmProvider: 'mock',
      isMockEmbeddings: true,
      pinecone: {},
    });

  it('lists documents in file-name order', () => {
    assert.deepEqual(
      buildReport().documents.map((document) => document.sourceFile),
      ['a-first.md', 'b-second.md'],
    );
  });

  it('records each heading with its level and line number', () => {
    const [first] = buildReport().documents;

    assert.deepEqual(
      first.headings.map(({ level, title, line }) => ({ level, title, line })),
      [
        { level: 1, title: 'First', line: 1 },
        { level: 2, title: 'Part', line: 3 },
      ],
    );
  });

  it('gives a chunk the id the live index gave it', () => {
    const report = buildChunkingTelemetry({
      documents: [{ id: 'a-first.md', content: '# First\n\nBody.' }],
      indexedChunks: [
        {
          id: 'chunk-7',
          sourceFile: 'a-first.md',
          headingPath: 'First',
          rawContent: 'Body.',
          prefixedText: 'Topic: First\n\nBody.',
          embedding: [0.1, 0.2],
          roles: ['all'],
        },
      ],
      searchSettings,
      rerankerBackend: 'mock',
      llmProvider: 'mock',
      isMockEmbeddings: true,
      pinecone: {},
    });

    assert.equal(report.documents[0].chunks[0].id, 'chunk-7');
    assert.equal(report.flatChunks[0].embeddingDims, 2);
  });
});
