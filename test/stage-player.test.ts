import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StagePlayer, STAGES } from '../client/stage-player.js';
function prepared() {
  let time = 0;
  const p = new StagePlayer(1250, () => time);
  p.start();
  p.ingest('guard', { layers: [], blocked: false });
  p.ingest('cache', { hit: false });
  p.ingest('query_rewrite', {
    needsRewrite: true,
    originalQuery: 'idp cert exp',
    rewrittenQuery: 'SAML signing certificate expiration',
  });
  p.ingest('reranking', { results: [] });
  p.ingest('context', { runningTokens: 100 });
  p.ingest('routing', { model: 'claude-haiku-4-5', tier: 'small' });
  p.ingest('token_delta', { text: 'Hello ' });
  return {
    p,
    advance: (ms = 1300) => {
      time += ms;
      return p.tick();
    },
  };
}
describe('Spotlight playback queue', () => {
  it('holds each fast step for a watchable beat', () => {
    const { p, advance } = prepared();
    assert.equal(p.state.active, 'security');
    assert.equal(advance(1000), false);
    assert.equal(advance(251), true);
    assert.equal(p.state.active, 'cache');
  });
  it('does not jump past a missing intermediate stage even if later events arrive', () => {
    let now = 0;
    const p = new StagePlayer(1200, () => now);
    p.start();
    p.ingest('guard', {});
    p.ingest('routing', { model: 'sonnet' });
    now = 5000;
    assert.equal(p.tick(), false);
    assert.equal(p.state.active, 'security');
  });
  it('pauses indefinitely and supports previous, next and direct completed-step selection', () => {
    const { p, advance } = prepared();
    advance();
    p.pause();
    advance(999999);
    assert.equal(p.state.active, 'cache');
    p.move(1);
    assert.equal(p.state.active, 'query-rewrite');
    p.move(-1);
    assert.equal(p.state.active, 'cache');
    p.select('context');
    assert.equal(p.state.active, 'context');
    assert.equal(p.state.playing, false);
  });
  it('security blocks stop every downstream stage and remain in Security', () => {
    const { p } = prepared();
    p.ingest('done', { blockedByGuard: true, guard: { blocked: true }, answer: 'Blocked' });
    assert.equal(p.state.active, 'security');
    assert.equal(p.state.playing, false);
    assert.ok(STAGES.slice(1).every((s) => p.state.stages[s.id].status === 'stopped'));
  });
  it('cache hits skip rewrite through fact-check and move directly to Result', () => {
    let now = 0;
    const p = new StagePlayer(1200, () => now);
    p.start();
    p.ingest('guard', {});
    p.ingest('cache', { hit: true });
    p.ingest('done', { answer: 'Saved answer', cache: { hit: true } });
    now = 1300;
    p.tick();
    assert.equal(p.state.active, 'cache');
    now = 2600;
    p.tick();
    assert.equal(p.state.active, 'result');
    assert.ok(STAGES.slice(2, 8).every((s) => p.state.stages[s.id].status === 'skipped'));
  });
  it('holds generation while tokens are arriving, not just for a fixed duration', () => {
    const { p, advance } = prepared();
    p.select('generate');
    p.play();
    advance(9999);
    assert.equal(p.state.active, 'generate');
    assert.equal(p.state.stages.generate.data.answer, 'Hello ');
    p.ingest('token_delta', { text: 'customer' });
    assert.equal(p.state.stages.generate.data.answer, 'Hello customer');
  });
  it('stream errors remain recorded and partial output resets cleanly on fallback', () => {
    const { p } = prepared();
    p.ingest('stream_error', { error: 'timeout', recoverable: true });
    p.ingest('stream_reset', {});
    assert.equal(p.state.stages.generate.data.answer, '');
    assert.equal(
      p.state.stages.generate.events.filter((e) => e.event === 'stream_error').length,
      1,
    );
  });
  it('replays recorded real data without invoking a second request', () => {
    const { p } = prepared();
    p.ingest('done', { answer: 'Final', sources: [], citationCheck: { rows: [] } });
    const before = p.state.stages.generate.data.answer;
    p.select('result');
    p.replay();
    assert.equal(p.state.active, 'security');
    assert.equal(p.state.playing, true);
    assert.equal(p.state.stages.generate.data.answer, before);
  });
  it('types buffered server tokens during generation instead of flashing a finished paragraph', () => {
    const { p, advance } = prepared();
    p.ingest('token_delta', { text: 'A'.repeat(100) });
    for (let i = 0; i < 6; i++) advance();
    assert.equal(p.state.active, 'generate');
    assert.equal(p.displayedAnswer(), '');
    advance(50);
    assert.ok(p.displayedAnswer().length > 0 && p.displayedAnswer().length < 100);
  });
  it('waits for the fourth real security gate and gives its result a watchable beat', () => {
    let now = 0;
    const p = new StagePlayer(1250, () => now);
    p.start();
    p.ingest('guard', {
      layers: [{ status: 'pass' }, { status: 'pass' }, { status: 'pass' }, { status: 'pending' }],
    });
    p.ingest('cache', { hit: false });
    now = 4000;
    assert.equal(p.tick(), false);
    p.ingest('guard_layer', { layerIndex: 4, phase: 'checking' });
    assert.equal(p.tick(), false);
    p.ingest('guard_layer', { layerIndex: 4, phase: 'done', result: { status: 'fenced' } });
    assert.equal(p.tick(), false);
    now = 5300;
    assert.equal(p.tick(), true);
    assert.equal(p.state.active, 'cache');
  });
});
