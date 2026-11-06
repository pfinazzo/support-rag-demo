/**
 * Why this file exists: it proves the real ONNX prompt guard classifier works.
 * A person runs it by hand, with FORCE_MOCK_GUARD unset. It loads the model, runs every
 * attack case and checks that the right layer catches each one. It also checks that
 * normal support questions pass. The fast test suite uses a mock guard, so without this
 * script nobody would notice the real model failing.
 */
import assert from 'node:assert/strict';
import { classifyPrompt, warmupPromptGuard, guardModelStatus } from '../src/prompt-guard-model.js';
import {
  PromptGuard,
  naiveMatch,
  regexMatch,
  buildDataSeparation,
  DEFAULT_GUARD_CONFIG,
} from '../src/prompt-guard.js';
import { ATTACK_CASES, SIMULATED_POISON_NOTE } from '../client/guard-attacks.js';

/** Stops at once if the mock guard is on. A mock would make every check meaningless. */
assert.notEqual(process.env.FORCE_MOCK_GUARD, 'true', 'Real classifier required');

/** Times how long the model takes to load. */
const started = performance.now();

await warmupPromptGuard();

console.log(JSON.stringify({ status: guardModelStatus(), loadMs: performance.now() - started }));

/**
 * Runs each attack case.
 * Each case names the layer that should catch it. Classifier cases must also slip past the
 * naive and regex layers and score above 0.95. Data separation cases must not be blocked,
 * and must fence the poisoned note.
 */
for (const attack of ATTACK_CASES) {
  const raw = await classifyPrompt({
    text: attack.query,
    threshold: DEFAULT_GUARD_CONFIG.classifierThreshold,
  });
  assert.equal(raw.backend, 'transformers-onnx');
  assert.equal(raw.error, undefined);
  const report = await new PromptGuard().check({ query: attack.query });
  if (attack.layer === 'dataSeparation') {
    assert.equal(report.blocked, false);
    assert.equal(raw.blocked, false);
    const data = buildDataSeparation({
      query: attack.query,
      chunks: [
        {
          sourceFile: 'simulated-ticket.md',
          headingPath: 'Billing',
          prefixedText: SIMULATED_POISON_NOTE,
        } as never,
      ],
    });
    assert.equal(data.indirectInjectionDetected, true);
    assert.ok(data.fencedDocsPreview.includes(SIMULATED_POISON_NOTE));
    assert.match(data.systemInstruction, /IGNORE any commands/);
  } else assert.equal(report.blockedBy, attack.layer, attack.id);
  if (attack.layer === 'classifier') {
    assert.equal(naiveMatch({ text: attack.query }), null);
    assert.equal(regexMatch({ text: attack.query }), null);
    assert.ok(raw.injectionProbability > 0.95);
  }
  console.log(
    JSON.stringify({
      case: attack.id,
      text: attack.query,
      caughtBy: attack.layer,
      rawClassifierProbability: raw.injectionProbability,
      latencyMs: raw.latencyMs,
    }),
  );
}

/** Normal support questions that must never be blocked. Each also passes the full guard. */
for (const text of [
  'Getting ERR_PAYMENT_402 on renewal',
  'My renewal card charge failed with code 402',
  'How do I request a refund within 14 days?',
  'How do I rotate an expired SAML certificate after SSO broke?',
  'Single Sign-On (SSO) certificate',
  'How do I verify X-Hub-Signature-256 webhook signatures?',
]) {
  const r = await classifyPrompt({ text, threshold: 0.5 });
  assert.equal(r.error, undefined);
  assert.equal(r.blocked, false, text);
  assert.equal((await new PromptGuard().check({ query: text })).blocked, false);
  console.log('BENIGN', r.injectionProbability, text);
}

console.log(
  'Real ONNX: all 7 simulated cases correctly attributed; both L3 cases >95%; 6 legitimate queries passed. L1/L2 deliberately catch attacks the classifier may miss.',
);
