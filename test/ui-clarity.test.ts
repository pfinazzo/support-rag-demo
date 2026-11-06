import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { GLOSSARY } from '../client/glossary-tooltips.js';
let dom: JSDOM, ui: typeof import('../client/spotlight.js');
const realFetch = globalThis.fetch;
const errors: unknown[] = [];
describe('UI · Single-step spotlight and accessible glossary', () => {
  before(async () => {
    dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), {
      url: 'http://localhost:3000',
      pretendToBeVisual: true,
    });
    for (const k of [
      'window',
      'document',
      'location',
      'Element',
      'HTMLElement',
      'HTMLInputElement',
      'HTMLTextAreaElement',
      'HTMLButtonElement',
      'Node',
      'NodeFilter',
      'Text',
      'MutationObserver',
    ])
      Object.defineProperty(globalThis, k, {
        configurable: true,
        writable: true,
        value: (dom.window as any)[k],
      });
    dom.window.addEventListener('error', (e) => errors.push(e.error));
    Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: 1440 });
    Object.defineProperty(globalThis, 'innerHeight', { configurable: true, value: 900 });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: dom.window.requestAnimationFrame.bind(dom.window),
    });
    Object.defineProperty(globalThis, 'addEventListener', {
      configurable: true,
      value: dom.window.addEventListener.bind(dom.window),
    });
    globalThis.fetch = async () => new Response('{}');
    ui = await import('../client/spotlight.js');
    await new Promise((r) => setTimeout(r, 70));
  });
  after(() => {
    globalThis.fetch = realFetch;
    dom.window.close();
  });
  it('idle shows only the input and three understated examples', () => {
    assert.equal(document.getElementById('idle-state')!.hidden, false);
    assert.equal(document.getElementById('playback-bar')!.hidden, true);
    assert.equal(document.getElementById('spotlightContainer')!.hidden, true);
    assert.equal(document.querySelectorAll('[data-example]').length, 3);
    assert.equal(document.getElementById('tools-menu')!.hidden, true);
  });
  it('contains no old workspace tabs, WebGL canvas, sliders or permanent inspector panels', () => {
    assert.equal(
      document.querySelectorAll(
        'canvas,#workspace-tabs,input[type=range],.ops-grid,.focus-panel,.semantic-cache-bar,.prompt-guard-bar',
      ).length,
      0,
    );
  });
  it('Step 3 renders ONLY Query Rewrite; every other step view is unmounted', () => {
    ui.player.start();
    ui.player.ingest('query_rewrite', {
      originalQuery: 'idp cert exp',
      rewrittenQuery: 'SAML certificate expiration',
      needsRewrite: true,
      reasons: ['domain_abbreviation'],
    });
    ui.player.select('query-rewrite');
    ui.renderSpotlight();
    const views = document.querySelectorAll('[data-step-view]');
    assert.equal(views.length, 1);
    assert.equal(views[0].getAttribute('data-step-view'), 'query-rewrite');
    for (const id of [
      'security',
      'cache',
      'search',
      'context',
      'router',
      'generate',
      'fact-check',
      'result',
    ])
      assert.equal(document.querySelector(`[data-step-view="${id}"]`), null);
    assert.match(
      document.getElementById('spotlightContainer')!.textContent!,
      /SAML certificate expiration/,
    );
  });
  it('the thin stepper has nine steps and pause/prev/next/replay controls', () => {
    assert.equal(document.querySelectorAll('[data-step]').length, 9);
    for (const id of ['play-pause', 'prev-step', 'next-step', 'replay'])
      assert.ok(document.getElementById(id));
  });
  it('completed step selection replaces rather than stacks stage visuals', () => {
    ui.player.ingest('context', {
      runningTokens: 100,
      recentTokensPerTurn: 30,
      hardTokenLimit: 20000,
    });
    ui.player.select('context');
    ui.renderSpotlight();
    assert.equal(document.querySelectorAll('[data-step-view]').length, 1);
    assert.equal(document.querySelector('[data-step-view="query-rewrite"]'), null);
    assert.ok(document.querySelector('[data-step-view="context"]'));
  });
  it('live token data renders incrementally in the generation spotlight', () => {
    ui.player.ingest('token_delta', { text: 'Hello ' });
    ui.player.ingest('token_delta', { text: 'customer' });
    ui.player.select('generate');
    ui.renderSpotlight();
    assert.equal(document.querySelectorAll('[data-step-view]').length, 1);
    assert.match(document.querySelector('.live-answer')!.textContent!, /Hello customer/);
  });
  it('all technical terms retain accessible focusable portal explanations', async () => {
    const term = document.createElement('h3');
    term.textContent = 'DeBERTa NLI';
    document.body.append(term);
    await new Promise((r) => setTimeout(r, 70));
    const target = term.querySelector<HTMLElement>('[data-tooltip]')!;
    assert.ok(target);
    assert.equal(target.tabIndex, 0);
    target.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }));
    const portal = document.getElementById('glossary-tooltip')!;
    assert.equal(portal.hidden, false);
    assert.equal(portal.parentElement, document.body);
    assert.equal(portal.getAttribute('popover'), 'manual');
    assert.equal(target.getAttribute('aria-describedby'), portal.id);
    document.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    assert.equal(portal.hidden, true);
  });
  it('the centralized whole-surface glossary remains concise and complete', () => {
    assert.deepEqual(errors, []);
    assert.ok(GLOSSARY.length >= 55);
    for (const e of GLOSSARY) assert.ok(e.explanation.length > 30 && e.explanation.length < 360);
  });
  it('blocked security gates are not shown as passed and downstream stages stay absent', () => {
    ui.player.ingest('done', {
      blockedByGuard: true,
      guard: {
        blocked: true,
        layers: [
          { blocked: true, status: 'blocked', reason: 'Known phrase' },
          { blocked: false, status: 'skipped' },
          { blocked: false, status: 'skipped' },
          { blocked: false, status: 'skipped' },
        ],
      },
      answer: 'Request blocked',
    });
    ui.renderSpotlight();
    assert.equal(document.querySelectorAll('[data-step-view]').length, 1);
    assert.ok(document.querySelector('[data-step-view=security]'));
    assert.equal(document.querySelectorAll('.security-gate.pass').length, 0);
    assert.equal(document.querySelectorAll('.step-pill.stopped').length, 8);
  });
});
