/**
 * Why this file exists: the four-layer prompt guard panel on the pipeline page.
 * Our server runs the guard layers and reports each result. This file shows the
 * results one card at a time, at a pace the user can follow. Without it, the
 * user could not see which layer caught an attack, or why.
 */
import { ATTACK_CASES } from './guard-attacks.js';

/** One guard layer's result, as our server reports it. */
interface Layer {
  id: string;
  name: string;
  enabled: boolean;
  status: string;
  blocked: boolean;
  latencyMs: number;
  reason: string;
  ruleId?: string;
  normalizedSnippet?: string;
  classifier?: {
    injectionProbability: number;
    threshold: number;
    backend: string;
    modelId: string;
    error?: string;
  };
}

/** The server's full verdict for one guarded question, with every layer's result. */
export interface GuardReport {
  id: string;
  checkedAt: string;
  blocked: boolean;
  blockedBy: string | null;
  latencyMs: number;
  layers: Layer[];
  config: GuardConfig;
  dataSeparation: {
    enabled: boolean;
    fenceId: string | null;
    sanitizedBreakoutAttempts: number;
    indirectInjectionDetected: boolean;
    systemInstruction: string;
    systemPrompt?: string;
    fencedUserBlock: string;
    fencedDocsPreview: string;
    fencedHistoryBlock: string;
    fencedPayload: string;
  };
}

/**
 * The guard switches. The first four turn a layer on or off.
 * `classifierThreshold` is the injection risk, from 0 to 1, at which the classifier blocks.
 * `simulateIndirectInjection` adds a poisoned document to the retrieved data, as a test.
 */
interface GuardConfig {
  naive: boolean;
  regex: boolean;
  classifier: boolean;
  dataSeparation: boolean;
  classifierThreshold: number;
  simulateIndirectInjection: boolean;
}

/** What GET /api/guard returns: the switches, the classifier model's status, and recent checks. */
interface GuardState {
  guardConfig: GuardConfig;
  classifier: { modelId: string; backend: string; ready: boolean; error?: string | null };
  recentChecks: GuardReport[];
}

/**
 * One live step from the server: a layer started checking, finished, was halted, or was bypassed.
 * `layerIndex` counts from 1.
 */
export interface GuardLayerEvent {
  layerIndex: number;
  layer: string;
  phase: string;
  enabled?: boolean;
  result?: Layer & { fenceId?: string; summary?: string; indirectInjectionDetected?: boolean };
}

/** Finds an element by id. The page's HTML is expected to contain every id used here. */
const $ = (id: string) => document.getElementById(id)!;

/** Turns text into safe HTML, so server text cannot run as markup on the page. */
const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** The four guard layers, in the order they run. */
const ids = ['naive', 'regex', 'classifier', 'dataSeparation'] as const;

/** Display name for each layer. Same order as `ids`. */
const names = [
  'Naive Substring',
  'Regex + Normalize',
  'Guard LLM Classifier',
  'Data-Side Isolation',
];

/**
 * The guard settings last received from our server.
 * Until the first reply, the page shows these starting values.
 */
let current: GuardState = {
  guardConfig: {
    naive: true,
    regex: true,
    classifier: true,
    dataSeparation: true,
    classifierThreshold: 0.5,
    simulateIndirectInjection: false,
  },
  classifier: { modelId: 'Llama-Prompt-Guard-2-22M', backend: 'transformers-onnx', ready: false },
  recentChecks: [],
};

/** The report of the latest finished check. Replay uses it to draw the final verdict again. */
let last: GuardReport | null = null;

/** The live steps of the current run, kept so the user can replay them. */
let timeline: GuardLayerEvent[] = [];

/** A chain of promises. Each step waits for the one before it, so steps show one at a time. */
let queue: Promise<void> = Promise.resolve();

/**
 * Counts runs. A new run adds one. `playing` is true while a run is being drawn.
 * Steps queued by an older run see the changed number and do nothing.
 * Without it, a slow old run would draw over the new question.
 */
let epoch = 0,
  playing = false;

/** The status and detail text last drawn on each layer's card. The answer view reuses it. */
let visual: Record<string, { status: string; detail: string }> = {};

/** Called for each step the page draws. The page uses it to move its own highlight. */
let onVisual: ((e: GuardLayerEvent) => void) | undefined;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Reads or changes the guard settings on our server. Returns the settings.
 * With no body: GET /api/guard. With a body: POST /api/guard/config.
 * Throws an error naming the HTTP status if the server does not answer with success.
 */
async function api(body?: object): Promise<GuardState> {
  const res = await fetch(
    body ? '/api/guard/config' : '/api/guard',
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  if (!res.ok) throw new Error(`Guard settings failed (${res.status})`);
  return (await res.json()) as GuardState;
}

/**
 * Draws the four layer cards and wires their buttons.
 * Each ON or OFF button posts the new setting to our server, then redraws the controls.
 * A changed setting applies to the next question, not the one in progress.
 * If the server rejects a change: the error text appears in the verdict line.
 * The Poison Doc button toggles the simulated poisoned document.
 * The Envelope button opens the dialog that shows the fenced prompt.
 */
function makeCards(): void {
  $('guard-toggles').innerHTML = ids
    .map(
      (id, i) => `<article id="guard-card-${id}" class="guard-card ready" data-guard-layer="${id}">
 <div class="guard-card-title"><b>${i + 1} · ${names[i]}</b><button type="button" data-guard-toggle="${id}" class="guard-switch" aria-label="Toggle ${names[i]}" aria-pressed="true">ON</button></div>
 <div class="guard-card-state" role="status">○ Ready</div>
 <div class="guard-card-result">${i === 3 ? 'After retrieval · Before Claude' : 'Waiting for query · Before cache'}</div>
 ${i === 2 ? '<div class="guard-model-badge" id="guard-model-badge">Llama-Prompt-Guard-2-22M (ONNX)</div><div class="guard-risk-meter"><i></i></div>' : ''}
 ${i === 3 ? '<div class="guard-card-tools"><button id="guard-poison-quick" type="button">🧪 Poison Doc</button><button id="guard-envelope-quick" type="button">🔍 Envelope</button></div>' : ''}
 </article>`,
    )
    .join('');
  document.querySelectorAll<HTMLButtonElement>('[data-guard-toggle]').forEach(
    (button) =>
      (button.onclick = () => {
        const id = button.dataset.guardToggle as (typeof ids)[number];
        void api({ [id]: !current.guardConfig[id] })
          .then((s) => {
            current = s;
            drawControls();
            setCard(
              id,
              current.guardConfig[id] ? 'ready' : 'off',
              'Setting updated · applies to next query',
            );
          })
          .catch((e) => {
            $('guard-verdict').textContent = String(e);
          });
      }),
  );
  $('guard-poison-quick').onclick = () =>
    updatePoison(!current.guardConfig.simulateIndirectInjection);
  $('guard-envelope-quick').onclick = () => {
    ($('guard-modal') as HTMLDialogElement).showModal();
    ($('guard-envelope') as HTMLDetailsElement).open = true;
  };
}

/**
 * Brings the buttons, model badge, poison switch and threshold slider in line with `current`.
 * While a run plays, the toggles, attack buttons and replay are disabled.
 * Without that, the user could change a setting halfway through a run.
 */
function drawControls(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-guard-toggle]').forEach((b) => {
    const enabled = current.guardConfig[b.dataset.guardToggle as (typeof ids)[number]];
    b.textContent = enabled ? 'ON' : 'OFF';
    b.setAttribute('aria-pressed', String(enabled));
    b.disabled = playing;
  });
  const model = current.classifier;
  $('guard-model-badge').textContent =
    `${model.backend === 'transformers-onnx' ? 'Llama-Prompt-Guard-2-22M (ONNX)' : 'Heuristic classifier (unit tests)'} · ${model.ready ? 'Ready' : model.error ? 'Unavailable' : 'Loading…'}`;
  ($('guard-poison') as HTMLInputElement).checked = current.guardConfig.simulateIndirectInjection;
  $('guard-poison-quick').classList.toggle('active', current.guardConfig.simulateIndirectInjection);
  $('guard-poison-quick').setAttribute(
    'aria-pressed',
    String(current.guardConfig.simulateIndirectInjection),
  );
  ($('guard-poison-quick') as HTMLButtonElement).disabled = playing;
  ($('guard-classifier-threshold') as HTMLInputElement).value = String(
    current.guardConfig.classifierThreshold,
  );
  $('guard-classifier-value').textContent =
    (current.guardConfig.classifierThreshold * 100).toFixed(0) + '%';
  ($('guard-replay') as HTMLButtonElement).disabled = playing || !timeline.length;
  document
    .querySelectorAll<HTMLButtonElement>('[data-attack]')
    .forEach((b) => (b.disabled = playing));
}

/**
 * Sets one layer card's look, status label and detail line, and remembers them in `visual`.
 * A status with no label is shown as its own text.
 */
function setCard(id: string, status: string, detail: string): void {
  const card = $('guard-card-' + id);
  card.className = 'guard-card ' + status;
  card.dataset.state = status;
  card.querySelector('.guard-card-state')!.textContent =
    (
      {
        ready: '○ Ready',
        checking: '⏳ Checking…',
        pass: '✓ PASS',
        blocked: '⛔ BLOCKED',
        error: '⛔ CLASSIFIER ERROR',
        off: '○ Off',
        halted: '⏭ Halted',
        fenced: '✓ FENCED',
        contained: '🛡 CONTAINED INJECTION',
        'cached-bypass': '⚡ Cache Bypass',
      } as Record<string, string>
    )[status] || status;
  card.querySelector('.guard-card-result')!.textContent = detail;
  (card.querySelector('.guard-card-result') as HTMLElement).title = detail;
  visual[id] = { status, detail };
}

/**
 * Draws one live step from the server onto its layer's card.
 * - checking: the card shows "Scanning input…". If the layer is disabled, its status is Off.
 * - halted: an earlier layer blocked, so this layer did not run.
 * - cached-bypass: the semantic cache answered, so the model was not called.
 * - done: the card shows the layer's own result. The classifier card also fills its risk meter.
 * Then calls `onVisual` and sends a `guard-visual-step` event on the window.
 * Other parts of the page listen for that event to follow along.
 */
function display(e: GuardLayerEvent): void {
  const l = e.result;
  let status =
    e.phase === 'checking'
      ? e.enabled === false
        ? 'off'
        : 'checking'
      : e.phase === 'halted'
        ? 'halted'
        : e.phase === 'cached-bypass'
          ? 'cached-bypass'
          : l?.status || 'pass';
  if (status === 'skipped') status = 'halted';
  let detail =
    e.phase === 'checking'
      ? 'Scanning input…'
      : l?.reason || l?.summary || 'Earlier guard blocked · Not executed';
  const ms = (l?.latencyMs || 0).toFixed(2);
  if (e.phase === 'done' && l) {
    if (e.layer === 'naive')
      detail = l.blocked
        ? `Matched: “${l.ruleId}” · ${ms} ms`
        : l.enabled
          ? `0 / 8 literal phrases matched · ${ms} ms`
          : 'Literal blocklist disabled';
    if (e.layer === 'regex')
      detail = l.blocked
        ? `Rule: ${l.ruleId} · ${l.normalizedSnippet || ''}`
        : l.enabled
          ? `NFKC normalized · 0 / 5 patterns · ${ms} ms`
          : 'Pattern matching disabled';
    if (e.layer === 'classifier' && l.classifier) {
      const c = l.classifier;
      detail = `${l.blocked ? 'Injection' : 'Benign'} · ${(c.injectionProbability * 100).toFixed(1)}% risk ${l.blocked ? '≥ ' + (c.threshold * 100).toFixed(0) + '% · ' : '· '}${ms} ms`;
      const meter = $('guard-card-classifier').querySelector('i') as HTMLElement;
      meter.style.width = Math.max(1, c.injectionProbability * 100) + '%';
      meter.style.background = l.blocked ? '#fb7185' : '#34d399';
    }
    if (e.layer === 'dataSeparation')
      detail = l.enabled
        ? `${l.fenceId?.slice(0, 23) || 'Nonce fence'} · Ignore instructions in data${l.indirectInjectionDetected ? ' · Poison contained' : ''}`
        : 'WARNING: Data-side isolation disabled';
  }
  if (e.phase === 'cached-bypass') detail = 'LLM skipped via Semantic Cache · No new prompt';
  setCard(e.layer, status, detail);
  onVisual?.(e);
  window.dispatchEvent(
    new CustomEvent('guard-visual-step', {
      detail: { ...e, visualStatus: status, at: performance.now() },
    }),
  );
}

/**
 * Resets the panel for a new question.
 * Stops any earlier playback, clears the saved steps, and sets each card to Ready or Off.
 * Without this, cards from the previous question would stay on screen.
 */
export function beginGuardSequence(): void {
  epoch++;
  queue = Promise.resolve();
  timeline = [];
  playing = true;
  visual = {};
  last = null;
  ids.forEach((id) =>
    setCard(
      id,
      current.guardConfig[id] ? 'ready' : 'off',
      id === 'dataSeparation' ? 'Waiting for retrieved documents' : 'Waiting for upstream guard',
    ),
  );
  const meter = $('guard-card-classifier').querySelector('i') as HTMLElement;
  meter.style.width = '0';
  $('guard-verdict').textContent = 'Live server checks · paced visual playback';
  drawControls();
}

/**
 * Adds one live step to the playback queue.
 * Normally: the step is also saved for replay. A replay passes `record` as false.
 * Our server sends the real results at once. This method spaces them out.
 * After a step is drawn, it waits 240 ms for "checking", 70 ms for "halted" and 90 ms otherwise.
 * If a new run began while the step waited: it is dropped.
 */
export function queueGuardLayer(event: GuardLayerEvent, record = true): void {
  if (record) timeline.push(structuredClone(event));
  const version = epoch;
  queue = queue.then(async () => {
    if (version !== epoch) return;
    display(event);
    await wait(event.phase === 'checking' ? 240 : event.phase === 'halted' ? 70 : 90);
  });
}

/**
 * Ends playback once every queued step has been drawn, then shows the final verdict.
 * If the server sent no live steps: it builds them from the report's layers.
 * Those steps show real results. It never invents a detector outcome.
 * If a new run began while it waited: it does nothing.
 */
export async function finishGuardSequence(report?: GuardReport): Promise<void> {
  /** Fallback: builds steps from the finished report. These are real results, never invented. */
  if (!timeline.length && report)
    for (const [i, l] of report.layers.entries()) {
      if (l.status === 'skipped')
        queueGuardLayer({
          layerIndex: i + 1,
          layer: l.id,
          phase: report.blocked ? 'halted' : 'cached-bypass',
          result: l,
        });
      else {
        queueGuardLayer({ layerIndex: i + 1, layer: l.id, phase: 'checking', enabled: l.enabled });
        queueGuardLayer({ layerIndex: i + 1, layer: l.id, phase: 'done', result: l });
      }
    }
  const version = epoch;
  await queue;
  if (version !== epoch) return;
  playing = false;
  if (report) renderGuard(report);
  drawControls();
}

/**
 * Returns HTML for four small tiles, one per layer, to put in the answer view.
 * Each tile shows what its card last showed. If a card never ran, it falls back to the report.
 */
export function guardBreakdownHtml(report?: GuardReport): string {
  return `<div class="guard-answer-breakdown">${ids
    .map((id, i) => {
      const layer = report?.layers[i];
      const v = visual[id];
      const status = v?.status || layer?.status || 'ready';
      return `<div class="guard-mini ${esc(status)}"><b>${i + 1} · ${names[i]}</b><span>${esc(status.toUpperCase())}</span><small>${esc(v?.detail || layer?.reason || 'Waiting')}</small></div>`;
    })
    .join('')}</div>`;
}

/**
 * Draws the final verdict, the layer-by-layer details and the fenced prompt from a report.
 * Writes the verdict line, the step list and the envelope dialog content.
 * The envelope shows trusted instructions apart from untrusted data.
 * If the request was blocked: no prompt was built, and the envelope says so.
 */
export function renderGuard(report: GuardReport): void {
  last = report;
  drawControls();
  const verdict = $('guard-verdict');
  verdict.className = `guard-verdict ${report.blocked ? 'blocked' : report.dataSeparation.indirectInjectionDetected ? 'warning' : 'pass'}`;
  verdict.textContent = report.blocked
    ? `✕ Blocked by ${report.layers.find((l) => l.blocked)?.name} · Cache, retrieval & LLM not run`
    : report.dataSeparation.indirectInjectionDetected
      ? report.dataSeparation.enabled
        ? '⚠ Indirect injection detected in data · Fenced; instructions ignored'
        : '⚠ Indirect injection detected in data · Data Fence is OFF'
      : '✓ Query passed enabled guard layers';
  $('guard-waterfall').innerHTML = report.layers
    .map(
      (l, i) =>
        `<article class="guard-step ${l.status}"><div class="cache-kicker">SHIELD ${i + 1} · ${esc(l.status.toUpperCase())} · ${l.latencyMs.toFixed(2)} ms</div><h3>${esc(l.name)}</h3><p>${esc(l.reason)}</p>${l.ruleId ? `<code>${esc(l.ruleId)}</code>` : ''}${l.normalizedSnippet ? `<pre>${esc(l.normalizedSnippet)}</pre>` : ''}${l.classifier ? `<small>${esc(l.classifier.modelId)}<br>${esc(l.classifier.backend)} · ${(l.classifier.injectionProbability * 100).toFixed(2)}% injection probability</small>` : ''}</article>`,
    )
    .join('');
  const data = report.dataSeparation;
  $('guard-envelope-content').innerHTML = data.fenceId
    ? `<section><h4>TRUSTED SYSTEM INSTRUCTIONS</h4><pre>${esc(data.systemPrompt || data.systemInstruction)}</pre></section><section><h4>UNTRUSTED DATA · ${esc(data.fenceId)}</h4><small>${data.sanitizedBreakoutAttempts} breakout attempts escaped · ${data.indirectInjectionDetected ? '⚠ Poisoned document detected' : 'No data-side injection detected'}</small><pre>${esc(data.fencedPayload)}</pre></section>`
    : `<p class="muted">${report.blocked ? 'Blocked upstream — no data prompt or LLM request constructed.' : data.enabled ? 'No new prompt constructed (cache hit or still retrieving).' : 'Data separation is disabled for this diagnostic.'}</p>`;
}

/**
 * Turns the simulated poisoned document on or off on our server.
 * If the server rejects the change: the error text appears in the verdict line.
 */
async function updatePoison(value: boolean): Promise<void> {
  try {
    current = await api({ simulateIndirectInjection: value });
    drawControls();
  } catch (e) {
    $('guard-verdict').textContent = String(e);
  }
}

/**
 * Sets the panel up once, when the page loads.
 * `onPreset` runs when the user picks an attack. The page then asks that question.
 * `onStep` runs for each step drawn.
 * Loads the settings from our server and marks disabled layers as Off.
 * Draws the quick attack buttons and the full attack list.
 * Wires the inspector, replay, poison switch and threshold slider.
 * Replay draws the saved steps again with no calls to the server.
 * Then asks our server for the settings every 3000 ms to refresh the recent-checks list.
 * Times in that list are shown in Eastern time.
 * If a refresh fails: the list stays as it was, with no message.
 */
export async function wirePromptGuard(
  onPreset: (query: string, indirect: boolean) => void,
  onStep?: (e: GuardLayerEvent) => void,
): Promise<void> {
  onVisual = onStep;
  makeCards();
  drawControls();
  current = await api();
  drawControls();
  ids.forEach((id) => {
    if (!current.guardConfig[id]) setCard(id, 'off', 'Disabled for this demo');
  });
  $('guard-inspect').onclick = () => ($('guard-modal') as HTMLDialogElement).showModal();
  /** Positions in ATTACK_CASES for the four quick-test buttons, in layer order. */
  const primary = [0, 2, 4, 6];
  $('guard-quick-attacks').innerHTML = primary
    .map(
      (n, i) =>
        `<button class="guard-attack-chip" data-attack="${n}" data-sim-id="${ATTACK_CASES[n].id}" type="button">Test L${i + 1}: ${['Naive', 'Obfuscated Regex', 'Semantic Jailbreak', 'Poisoned Chunk'][i]}</button>`,
    )
    .join('');
  $('guard-attack-presets').innerHTML = ATTACK_CASES.map(
    (a, i) =>
      `<button class="pill" type="button" data-attack="${i}" data-sim-id="${a.id}" title="${esc(a.query)}">${a.id} · ${esc(a.label)}</button>`,
  ).join('');
  document.querySelectorAll<HTMLButtonElement>('[data-attack]').forEach(
    (b) =>
      (b.onclick = () => {
        if (playing) return;
        const a = ATTACK_CASES[Number(b.dataset.attack)];
        onPreset(a.query, 'indirect' in a && a.indirect);
      }),
  );
  $('guard-replay').onclick = () => {
    if (playing || !timeline.length) return;
    const saved = timeline.map((e) => structuredClone(e));
    const report = last;
    beginGuardSequence();
    timeline = saved;
    $('guard-verdict').textContent = '↻ Visual replay · No API, cache, retrieval or Claude calls';
    saved.forEach((e) => queueGuardLayer(e, false));
    void finishGuardSequence(report || undefined).then(() => {
      if (!playing)
        onVisual?.({ layerIndex: 4, layer: 'dataSeparation', phase: 'replay-complete' });
    });
  };
  $('guard-poison').onchange = () => {
    void updatePoison(($('guard-poison') as HTMLInputElement).checked);
  };
  $('guard-classifier-threshold').oninput = () => {
    const value = Number(($('guard-classifier-threshold') as HTMLInputElement).value);
    $('guard-classifier-value').textContent = (value * 100).toFixed(0) + '%';
    void api({ classifierThreshold: value })
      .then((s) => {
        current = s;
      })
      .catch((e) => {
        $('guard-verdict').textContent = String(e);
      });
  };
  $('guard-waterfall').innerHTML =
    '<p class="muted">The live four-card track is always visible. Expand this inspector for exact evidence.</p>';
  setInterval(() => {
    void api()
      .then((s) => {
        current = s;
        drawControls();
        $('guard-audit-list').innerHTML = s.recentChecks
          .map(
            (r) =>
              `<div class="guard-audit-row">${esc(new Date(r.checkedAt).toLocaleTimeString('en-US', { timeZone: 'America/New_York' }))} Eastern · ${r.blocked ? '✕ ' + esc(r.blockedBy) : '✓ Passed'} · ${r.latencyMs.toFixed(1)} ms</div>`,
          )
          .join('');
      })
      .catch(() => {});
  }, 3000);
}
