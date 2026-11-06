/**
 * Why this file exists: it proves citation checking works against a live server.
 * A person runs it as `npm run verify:citations`, with the server up and the real NLI model
 * loaded. It fetches real pages and checks a good citation, a dead link, a
 * claim the source contradicts, and a quote that is not in the source. It also checks a
 * network error and the streaming endpoint. The fast tests use a mock NLI model, so
 * without this script nobody would notice the real one failing.
 */
import assert from 'node:assert/strict';

/** The server to test. Defaults to the local demo port. */
const base = process.env.BASE_URL || 'http://127.0.0.1:3198';

const status = (await fetch(base + '/api/citations/status').then((r) => r.json())) as Record<
  string,
  any
>;

assert.equal(status.backend, 'transformers-onnx');

assert.equal(status.ready, true);

const response = await fetch(base + '/api/citations/check', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ simulation: 'all' }),
});

assert.equal(response.status, 200);

const result = (await response.json()) as Record<string, any>;

/** The built-in samples, in the order the server returns them: good, dead link, contradiction, missing quote. */
const [pass, url, nli, quote] = result.samples.map((s: Record<string, any>) => s.report);

assert.equal(pass.status, 'verified');

assert.equal(pass.rows[0].urlCheck.status, 200);

assert.equal(pass.rows[0].entailmentCheck.claims[0].backend, 'transformers-onnx');

assert.equal(pass.quoteCheck.passed, true);

assert.equal(url.rows[0].urlCheck.valid, false);

assert.equal(url.rows[0].urlCheck.status, 404);

const flipped = nli.rows[0].entailmentCheck.claims[0];

assert.equal(flipped.label, 'CONTRADICTION');

assert.equal(flipped.supported, false);

assert.ok(flipped.contradiction > 0.95);

assert.ok(flipped.lexicalSimilarity > 0.8);

assert.equal(quote.urlCheck.passed, true);

assert.equal(quote.entailmentCheck.passed, true);

assert.equal(quote.quoteCheck.passed, false);

/** A citation to a host that cannot be reached. The check must report it as invalid, not crash. */
const error = (await fetch(base + '/api/citations/check', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    answer: 'The source describes the refund policy.',
    sources: [{ url: 'https://citation-check-connection-error.invalid/' }],
  }),
}).then((r) => r.json())) as Record<string, any>;

assert.equal(error.rows[0].urlCheck.valid, false);

assert.match(error.rows[0].urlCheck.error, /fetch|ENOTFOUND/i);

/** The streaming version. It must send the expected citation_check events and the CONTRADICTION label. */
const stream = await fetch(base + '/api/citations/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ simulation: 'negation' }),
}).then((r) => r.text());

assert.equal((stream.match(/event: citation_check/g) || []).length, 6);

assert.match(stream, /CONTRADICTION/);

console.log(
  JSON.stringify({
    model: status.modelId,
    backend: status.backend,
    supportedEntailment: pass.rows[0].entailmentCheck.claims[0].entailment,
    negationContradiction: flipped.contradiction,
    lexicalCosine: flipped.lexicalSimilarity,
    url404: url.rows[0].urlCheck.status,
    networkError: error.rows[0].urlCheck.error,
    quoteMissing: !quote.quoteCheck.passed,
    normalizedQuoteFound: pass.quoteCheck.passed,
    streamEvents: 6,
  }),
);

console.log(
  'LIVE CITATIONS PASS: all-three-pass + actual 404 + real DeBERTa negation contradiction + normalized/fabricated quotes + network error + sequential SSE.',
);
