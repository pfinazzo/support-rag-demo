/**
 * Why this file exists: it builds the operations panels around the pipeline page.
 * These are the runtime panels, the Quality Meter and Governance tab, the Indexing and Context tab, and the Golden Eval tab.
 * It also feeds server events into those panels.
 * Without it, the page would show the 3D funnel only. The reader could not see query rewriting, model routing, held responses, re-indexing or the eval results.
 */
import { installGlossary, GLOSSARY } from './glossary-tooltips.js';

/** A JSON object from our server. Its fields are checked where they are read, not here. */
type Data = Record<string, any>;

/**
 * Escapes text for safe use inside HTML. Without it, a server value with angle brackets could inject markup into the page.
 */
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Formats a value as indented JSON, escaped for HTML. */
const pretty = (v: unknown) => esc(JSON.stringify(v, null, 2));

/**
 * Finds an element by id. The page must contain that id, or later use of the result fails.
 */
const el = (id: string) => document.getElementById(id)!;

/**
 * Returns the HTML for one titled panel.
 * If a glossary term appears in the title: the heading gets that term's explanation as a tooltip. The first matching glossary row wins.
 * The title is inserted as HTML. Callers pass fixed text only.
 */
const card = (id: string, title: string, body: string) => {
  const match = GLOSSARY.find((g) =>
    g.terms.some((term) => title.toLowerCase().includes(term.toLowerCase())),
  );
  return `<section class="ops-card" id="${id}"><h2${match ? ` tabindex="0" data-tooltip="${esc(match.explanation)}"` : ''}>${title}</h2>${body}</section>`;
};

/** Returns an HTML block that shows a value as JSON when the reader opens it. */
const details = (title: string, data: unknown) =>
  `<details><summary>${esc(title)}</summary><pre>${pretty(data)}</pre></details>`;

/**
 * Calls one of our server's JSON routes and returns the parsed reply.
 * If the body is given: sends a POST with that body. Otherwise: sends a GET.
 * If the server replies with an error status: throws with the server's message, or Request failed if it sent none.
 */
async function api(path: string, body?: unknown): Promise<any> {
  const r = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/**
 * The chat so far, for the current page. Our server uses it to rewrite follow-up questions and to build the context.
 * question is the text of the question in flight. streamText is the answer text received so far.
 */
let turns: Array<{ role: string; content: string }> = [],
  question = '',
  streamText = '';

/**
 * Returns the last twelve chat messages, a copy the caller may keep.
 * The page sends this with each question.
 */
export const conversationHistory = () => turns.slice(-12);

/** The four workspace tabs: view id first, then the label shown on the button. */
const tabs = [
  ['pipeline', 'Pipeline Runtime'],
  ['quality', 'Quality Meter & Governance'],
  ['ops', 'Indexing & Context Ops'],
  ['eval', 'Golden Eval Suite (20)'],
];

/** Draws the tab buttons. The first tab starts selected. */
el('workspace-tabs').innerHTML = tabs
  .map(
    ([id, title], i) =>
      `<button data-view="${id}" class="${i === 0 ? 'active' : ''}" aria-selected="${i === 0}">${title}</button>`,
  )
  .join('');

/**
 * When the reader clicks a tab: shows that view, hides the others and marks the button selected.
 * Opening the quality tab loads the governance data. Opening the ops tab loads the index status.
 * Without the reload, those tabs would show stale numbers.
 */
el('workspace-tabs').addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLButtonElement>('[data-view]');
  if (!b) return;
  document
    .querySelectorAll('.workspace-view')
    .forEach((v) => ((v as HTMLElement).hidden = v.id !== 'view-' + b.dataset.view));
  document.querySelectorAll('[data-view]').forEach((v) => {
    v.classList.toggle('active', v === b);
    v.setAttribute('aria-selected', String(v === b));
  });
  if (b.dataset.view === 'quality') void loadGovernance();
  if (b.dataset.view === 'ops') void loadIndex();
});

/**
 * The row of runtime panels. Each panel is filled in later by onInfrastructureEvent as the server reports progress.
 */
const runtime = document.createElement('div');

runtime.id = 'runtime-operations';

runtime.className = 'ops-grid';

runtime.innerHTML =
  card(
    'rewrite-panel',
    'Search Query Clarity (Query Rewriting)',
    '<p>Only unclear questions require an extra rewrite.</p><div id="rewrite-presets" class="ops-actions"></div><div id="rewrite-result" class="ops-result">Waiting for a request</div>',
  ) +
  card(
    'context-panel',
    'Call Assembly & Chat History Trimming (Compaction)',
    '<div id="context-rate">Turn Size Growth Rate · 0 tokens/turn</div><div id="context-steps" class="assembly-track"></div><div id="context-diff"></div>',
  ) +
  card(
    'routing-panel',
    'Model Selection & Backup Models (Router / Fallback Chain)',
    '<div class="routing-flow"><span id="route-request">Request</span><b>→</b><span id="route-signal">5 decision signals</span><b>→</b><div><span id="route-small">Small · Haiku</span><span id="route-large">Large · Sonnet / Opus</span></div></div><div id="route-signals"></div><div id="fallback-links" class="fallback-links"></div><div id="fallback-rates"></div><div class="ops-actions"><label><input id="local-fallback" type="checkbox"> Allow free local last resort</label><button id="fault-probe">Probe Primary HTTP 503</button></div><div id="probe-result"></div>',
  ) +
  card(
    'prefix-panel',
    'Shared Instructions Cache (Prompt Cache)',
    '<div id="prefix-state" class="metric-number">No model call yet</div><div id="prefix-hash"></div><small id="prefix-source">Provider usage and local estimates are labeled separately.</small>',
  ) +
  card(
    'search-panel',
    'Follow-up Search & Tool Steps (Search Agent / Agent Loop)',
    '<div id="search-passes"></div><div id="agent-steps"></div>',
  ) +
  card(
    'stream-panel',
    'Live Answer Stream (SSE)',
    '<div id="stream-status">Tokens arrive during generation. Drafts stay provisional until all checks complete.</div><div id="stream-answer" class="stream-answer" aria-live="polite"></div><div id="stream-metrics"></div>',
  ) +
  card(
    'schema-panel',
    'Required Response Format (JSON Schema)',
    '<div class="compare-grid"><div><h3>Required fields</h3><pre id="response-schema"></pre></div><div><h3>Validated output</h3><pre id="validated-output">Waiting for a response</pre></div></div>',
  ) +
  card(
    'chunks-panel',
    'Document Context Headers',
    '<label><input id="raw-chunks" type="checkbox"> Show Raw Chunk instead of Chunk-with-Context</label><div id="contextual-chunks"></div>',
  );

const workspace = document.querySelector('#view-pipeline .workspace')!;

/** Puts the runtime panels above the 3D pipeline workspace. */
workspace.before(runtime);

/**
 * Builds the Quality Meter and Governance tab. The metrics, held responses and judge results are filled in later.
 */
el('view-quality').innerHTML =
  '<div class="ops-page-head"><h1>Quality Meter & Governance</h1><p>Rolling health, held responses, and operator decisions.</p></div><div class="ops-actions"><button id="degrade">Inject Degraded Batch</button><button id="recover">Record Healthy Recovery Batch</button></div><div id="quality-metrics" class="metric-grid"></div><div class="ops-grid">' +
  card(
    'confidence-card',
    'Response Confidence Score',
    '<div id="confidence-current">No live response scored yet.</div>',
  ) +
  card('review-card', 'Held Responses (Review Queue)', '<div id="review-items"></div>') +
  card(
    'handoff-card',
    'Transfer to a Human (Warm Human Handoff)',
    '<p>Local transfer packages preserve the conversation. External live-agent dispatch is not connected.</p><div class="ops-actions"><button id="handoff-stuck">Check Stuck-Bot Detection</button><button id="handoff-repeat">Check Repeated Human Requests</button></div><div id="handoff-output"></div>',
  ) +
  card(
    'judge-card',
    'Independent Answer Review (LLM Judge Rubric)',
    '<div id="judge-dimensions" class="judge-grid"></div><label><input type="checkbox" id="live-judge"> Use separate live Claude judge</label><textarea id="judge-question" placeholder="Customer question"></textarea><textarea id="judge-answer" placeholder="Proposed answer"></textarea><textarea id="judge-evidence" placeholder="Source text"></textarea><button id="judge-run">Grade Response</button><div id="judge-source"></div>',
  ) +
  '</div>';

/** Builds the Indexing and Context tab with its two panels. */
el('view-ops').innerHTML =
  '<div class="ops-page-head"><h1>Indexing & Context Ops</h1><p>Change-driven document updates and conversation-size controls.</p></div><div class="ops-grid">' +
  card(
    'index-card',
    'Changed-Document Refresh (Mixed-Source Re-Indexing)',
    '<div class="ops-actions"><button id="mutate-doc">Change Database Document</button><button id="same-doc">Write Unchanged Document</button><button id="delete-doc">Delete Database Document</button><button id="restore-docs">Restore Corpus</button></div><div id="index-flow" class="assembly-track"><span>Database write</span> → <span>SQLite Write Trigger</span> → <span>SHA-256 Content Hash</span> → <span>Changed chunks embedded</span></div><div id="index-status"></div>',
  ) +
  card(
    'compaction-card',
    'Chat History Trimming Workbench',
    '<p>Growth rate is the early trigger; the hard window cap is enforced before any model call.</p><div class="ops-actions"><button id="context-normal">Normal Assembly</button><button id="context-bloat">High Turn Growth</button><button id="context-overflow">Hard Window Failure</button></div><div id="workbench-context"></div>',
  ) +
  '</div>';

/** Builds the Golden Eval tab. The questions are filled in after the server lists them. */
el('view-eval').innerHTML =
  '<div class="ops-page-head"><h1>Golden Eval Suite (20)</h1><p>Fixed support questions, hand-written expectations, and source requirements.</p></div><div class="ops-actions"><button id="eval-run">Run Full Suite</button><label><input type="checkbox" id="eval-judge" checked> Rubric scores</label><label><input type="checkbox" id="eval-live"> Separate live Claude judge</label><label><input type="checkbox" id="eval-canary"> Inject answer drift in first result</label><strong id="eval-status">Ready · 20 questions</strong></div><div id="eval-questions" class="eval-list"></div>';

/** The chunks from the last reranking event, kept so the checkbox can redraw them. */
let lastChunks: Data[] = [];

/**
 * Draws the chunk list in the document context panel.
 * If Show Raw Chunk is ticked: shows each chunk's raw text. Otherwise: shows the text with its context header.
 * If the server sent no raw text: rebuilds it by dropping the first two paragraphs of the prefixed text. This is how the code does it. The reason is not stated in the code.
 */
function renderChunks() {
  el('contextual-chunks').innerHTML = lastChunks
    .map(
      (c) =>
        `<details><summary>${esc(c.headingPath)}</summary><strong>${esc(c.contextHeader || 'Context header unavailable')}</strong><pre>${esc((el('raw-chunks') as HTMLInputElement).checked ? c.rawContent || String(c.prefixedText).split('\n\n').slice(2).join('\n\n') : c.contextualizedContent || c.prefixedText)}</pre></details>`,
    )
    .join('');
}

/** Redraws the chunk list when the reader ticks or clears Show Raw Chunk. */
el('raw-chunks').addEventListener('change', renderChunks);

/**
 * Draws a context assembly result: token growth rate, whether it fits the model window, and the before and after text.
 * target is the id of the element that receives the result. Normally: the runtime panel.
 * If the call would not fit: the result is marked bad, because our server refused to send it.
 */
function renderContext(data: Data, target = 'context-diff') {
  el('context-rate').innerHTML =
    `Turn Size Growth Rate · <b>${Number(data.recentTokensPerTurn).toFixed(0)}</b> tokens/turn / ${data.maxTokensPerTurnRate} limit · ${esc(data.triggerReason || 'under budget')}`;
  el(target).innerHTML =
    `<div class="ops-result ${data.fitsInWindow ? 'good' : 'bad'}">${data.runningTokens} / ${data.hardTokenLimit} tokens · ${data.fitsInWindow ? 'Fits model window' : 'Call rejected: ContextWindowExceededError'}</div><div class="compare-grid"><div><h3>Before</h3><pre>${pretty(data.before)}</pre></div><div><h3>After · ${esc(data.triggerReason || 'No trimming')}</h3><pre>${pretty(data.after)}</pre></div></div>`;
}

/**
 * Draws one card per judge dimension and the line saying who judged.
 * Each card shows pass or fail, the score and the judge's reason.
 */
function judgeCards(j: Data) {
  el('judge-dimensions').innerHTML = Object.entries(j.dimensions || {})
    .map(([name, v]) => {
      const d = v as Data;
      return `<div class="judge-dimension ${d.passed ? 'good' : 'bad'}"><strong>${esc(name.replace(/([A-Z])/g, ' $1'))}</strong><b>${Math.round(d.score * 100)}%</b><p>${esc(d.rationale)}</p></div>`;
    })
    .join('');
  el('judge-source').textContent = `${j.source} · ${j.model} · ${j.overallVerdict}`;
}

/**
 * Updates the panels for one event from our server's answer stream.
 * event is the event name. data is its payload. app.ts calls this for every event it receives.
 * The buttons on these tabs call it too.
 * Unknown events are ignored.
 */
export function onInfrastructureEvent(event: string, data: Data) {
  /**
   * When the prompt guard starts: remembers the question and clears the last run's stream, context steps and search steps.
   * Without the reset, the new run would draw under the old one.
   */
  if (event === 'guard' && data.layers) {
    question = (el('question') as HTMLInputElement).value;
    streamText = '';
    el('stream-answer').textContent = '';
    el('context-steps').innerHTML = '';
    el('search-passes').innerHTML = '';
    el('agent-steps').innerHTML = '';
  }
  /**
   * Adds one piece of the LLM's answer to the live stream. It is marked provisional until the checks finish.
   */
  if (event === 'token_delta') {
    streamText += data.text;
    el('stream-answer').textContent = streamText;
    el('stream-status').textContent = 'Live generation · provisional operator preview';
  }
  /**
   * Clears the draft when our server sends a stream reset.
   */
  if (event === 'stream_reset') {
    streamText = '';
    el('stream-answer').textContent = '';
  }
  /** Shows that the stream broke. */
  if (event === 'stream_error')
    el('stream-status').textContent =
      'Stream interrupted · ' + (data.error || 'retrying next model');
  /** Shows time to first token, token count and speed. */
  if (event === 'stream_metrics')
    el('stream-metrics').textContent =
      `TTFT ${Math.round(data.ttftMs || 0)} ms · ${data.tokens} tokens · ${Number(data.tokensPerSecond || 0).toFixed(1)} tokens/sec`;
  /** Shows whether the question was rewritten, why, and the before and after text. */
  if (event === 'query_rewrite')
    el('rewrite-result').innerHTML =
      `<span class="badge">${data.needsRewrite ? 'Rewrite triggered' : 'Rewrite skipped'}</span> ${esc(data.reasons?.join(', '))}<div class="compare-grid"><p>Before: ${esc(data.originalQuery)}</p><p>After: ${esc(data.rewrittenQuery)}</p></div><small>${esc(data.backend)} · ${data.tokensUsed} rewrite tokens · retrieval lift ${Number(data.retrievalLift || 0).toFixed(3)}</small>`;
  /** Adds one follow-up search pass to the list. */
  if (event === 'search_pass')
    el('search-passes').insertAdjacentHTML(
      'beforeend',
      `<details class="trace-step" open><summary>Pass ${data.iteration} · ${esc(data.query)} · ${Number(data.confidence).toFixed(2)}</summary><p>${esc(data.terminationReason)} · next query: ${esc(data.refinedQuery || 'none')}</p><pre>${pretty(data.snippets)}</pre></details>`,
    );
  /** Adds one tool step to the agent loop list. */
  if (event === 'agent_step')
    el('agent-steps').insertAdjacentHTML(
      'beforeend',
      `<details class="trace-step"><summary>Tool iteration ${data.iteration}/${data.maxIterations} · ${esc(data.phase)} · ${esc(data.tool || 'model decision')}</summary><pre>${pretty(data)}</pre></details>`,
    );
  /** Adds one block to the context assembly bar and updates the growth rate. */
  if (event === 'context_step') {
    el('context-steps').insertAdjacentHTML(
      'beforeend',
      `<span class="assembly-block ${esc(data.phase)}">${esc(data.component)}<b>${data.runningTokens} tokens</b></span>`,
    );
    el('context-rate').textContent =
      `Turn Size Growth Rate · ${Math.round(data.recentTokensPerTurn)} tokens/turn`;
  }
  /** Shows the final context result with before and after text. */
  if (event === 'context') renderContext(data);
  /**
   * Shows the model router's choice: the score, the small or large tier, and the signals behind it.
   * Clears the backup chain so it can fill for this run.
   * The class is removed and re-added on the next frame so the highlight animation plays again.
   */
  if (event === 'routing') {
    el('fallback-links').innerHTML = '';
    el('route-request').classList.remove('selected');
    requestAnimationFrame(() => el('route-request').classList.add('selected'));
    el('route-signal').textContent = `Decision score ${data.score}`;
    el('route-small').classList.toggle('selected', data.tier === 'small');
    el('route-large').classList.toggle('selected', data.tier !== 'small');
    el('route-signals').innerHTML = data.signals
      .map(
        (s: Data) =>
          `<span class="signal ${s.active ? 'selected' : ''}">${esc(s.id.replaceAll('_', ' '))} · ${esc(s.detail)}</span>`,
      )
      .join('');
  }
  /** Adds one attempt to the backup model chain and reloads the failure rates. */
  if (event === 'fallback') {
    void loadRouting();
    el('fallback-links').insertAdjacentHTML(
      'beforeend',
      `<span class="chain-link ${data.success ? 'good' : 'bad'}">${esc(data.model)} ${data.success ? '✓ caught request' : '✕ ' + esc(data.errorType)}</span>`,
    );
  }
  /** Shows the prompt cache result: hit or miss, tokens saved and tokens written. */
  if (event === 'prompt_cache') {
    el('prefix-state').textContent =
      `${data.hit ? 'HIT' : 'MISS'} · ${data.tokensSaved} tokens saved · ${data.cacheCreationInputTokens} written`;
    el('prefix-hash').textContent = 'SHA-256 Prefix Hash · ' + data.prefixHash;
    el('prefix-source').textContent = data.source + ' · 5-minute prefix lifetime';
  }
  /** Shows the validated response next to the required fields. */
  if (event === 'structured_output') el('validated-output').innerHTML = pretty(data.response);
  /** Stores the reranked chunks and redraws the chunk list. */
  if (event === 'reranking') {
    lastChunks = data.results || [];
    renderChunks();
  }
  /** Shows the response confidence score and how it was made. */
  if (event === 'confidence')
    el('confidence-current').innerHTML =
      `<div class="metric-number">${Math.round(data.confidenceScore * 100)}%</div><b>${esc(data.disposition)}</b>${details('Scoring signals', data)}`;
  /** Shows the message for the customer and the full handoff package. */
  if (event === 'handoff')
    el('handoff-output').innerHTML =
      `<p class="ops-result">${esc(data.customerMessage)}</p>${details('Full transfer payload', data)}`;
  /** Shows a checking placeholder for each judge dimension. */
  if (event === 'judge_start')
    el('judge-dimensions').innerHTML = data.dimensions
      .map(
        (name: string) =>
          `<div class="judge-dimension" data-dimension="${name}">${esc(name)} · checking…</div>`,
      )
      .join('');
  /**
   * Swaps one dimension's placeholder for its result.
   * If no placeholder exists: adds the result at the end.
   */
  if (event === 'judge_dimension') {
    const d = document.createElement('div');
    d.className = 'judge-dimension ' + (data.passed ? 'good' : 'bad');
    d.textContent = `${data.dimension} · ${Math.round(data.score * 100)}% · ${data.rationale}`;
    const pending = document.querySelector(`[data-dimension="${data.dimension}"]`);
    if (pending) pending.replaceWith(d);
    else el('judge-dimensions').append(d);
  }
  /**
   * When the run ends:
   * If the answer was not blocked by the guard: adds the question and the answer to the chat history, keeping the last twelve messages.
   * Shows the final answer, or the streamed draft if there is none.
   * If the server held the response: says it is held for review.
   * Then reloads the governance data so the new response appears in the review queue.
   */
  if (event === 'done') {
    if (data.answer && !data.blockedByGuard) {
      turns.push(
        { role: 'user', content: question },
        { role: 'assistant', content: String(data.answer) },
      );
      turns = turns.slice(-12);
    }
    el('stream-answer').textContent = data.answer || streamText;
    el('stream-status').textContent =
      data.releaseAllowed === false
        ? 'HELD FOR REVIEW · not released to customer'
        : 'Validated response';
    if (data.structuredOutput) el('validated-output').innerHTML = pretty(data.structuredOutput);
    if (data.judge) judgeCards(data.judge);
    void loadGovernance();
  }
}

/**
 * Returns an SVG line of a metric's recent values, each from zero to one.
 * The line spreads across the width. Taller values sit higher. The bad flag colors it as an alert.
 */
function sparkline(points: Data[], bad: boolean) {
  const coords = points
    .map(
      (p, i) =>
        `${((i / Math.max(1, points.length - 1)) * 220).toFixed(1)},${(62 - p.value * 55).toFixed(1)}`,
    )
    .join(' ');
  return `<svg viewBox="0 0 220 70" role="img" aria-label="Rolling metric trend" class="sparkline ${bad ? 'bad' : ''}"><path d="M0 60H220"/><polyline points="${coords}"/></svg>`;
}

/** Maps each metric key from the Quality Meter to its label on the page. */
const metricNames: Record<string, string> = {
  responseConfidence: 'Response Confidence',
  citationPassRate: 'Source Fact-Check Pass Rate',
  promptGuardBlockRate: 'Security Block Rate',
  retrievalMatchStrength: 'Search Match Strength',
  schemaValidationRate: 'Required Format Success Rate',
  llmJudgeScore: 'Independent Review Score',
};

/**
 * Loads the Quality Meter, the review queue and the handoff list, and draws all three.
 * Calls three server routes at the same time.
 * If any call fails: throws, and the caller decides what to do.
 */
async function loadGovernance() {
  const [q, r, h] = await Promise.all([
    api('/api/quality-meter'),
    api('/api/review-queue'),
    api('/api/handoff/status'),
  ]);
  el('quality-metrics').innerHTML = q.metrics
    .map(
      (m: Data) =>
        `<section class="metric-card ${m.alertActive ? 'alert' : ''}"><h3>${metricNames[m.metric]}</h3><div class="metric-number">${Math.round(m.value * 100)}%</div>${sparkline(m.series, m.alertActive)}<span class="badge">${m.alertActive ? '⚠ ' + m.severity + ' drift alert' : m.status}</span><p>${m.direction === 'above' ? 'Maximum' : 'Minimum'} ${Math.round(m.threshold * 100)}% · rolling window ${q.sampleWindow} samples</p></section>`,
    )
    .join('');
  el('review-items').innerHTML =
    r.items
      .map(
        (i: Data) =>
          `<article class="review-item"><h3>${esc(i.id)} · ${esc(i.question)}</h3><span class="badge ${i.status === 'pending' ? 'bad' : 'good'}">${esc(i.status)} · ${Math.round(i.confidenceScore * 100)}%</span><p>${esc(i.caughtReasons.join(', '))}</p><div class="compare-grid"><div><h4>Original Source</h4><pre>${pretty(i.originalSources)}</pre></div><div><h4>Model Output</h4><pre>${pretty(i.proposedOutput)}</pre></div></div>${i.status === 'pending' ? `<textarea id="edit-${esc(i.id)}" aria-label="Edited response">${esc(i.proposedOutput?.answer || '')}</textarea><div class="ops-actions"><button data-review="${esc(i.id)}" data-action="approve">Approve</button><button data-review="${esc(i.id)}" data-action="edit">Edit & Release</button><button data-review="${esc(i.id)}" data-action="reject">Reject</button></div>` : ''}</article>`,
      )
      .join('') +
    details('Released responses & rejection patterns', {
      releasedResponses: r.releasedResponses,
      rejectionPatterns: r.rejectionPatterns,
    });
  if (h.handoffs.length)
    el('handoff-output').innerHTML = h.handoffs
      .map(
        (v: Data) =>
          `<p class="ops-result">${esc(v.customerMessage)}</p>${details(v.triggerReason, v)}`,
      )
      .join('');
}

/** Loads the model router's failure history and draws the failure rate per model. */
async function loadRouting() {
  const r = await api('/api/router/status');
  el('fallback-rates').innerHTML =
    r.fallback.models
      .map(
        (m: Data) =>
          `<span class="signal">${esc(m.model)} · ${Math.round(m.failureRate * 100)}% failures (${m.failures}/${m.attempts})</span>`,
      )
      .join('') + details('Recent per-model failure history', r.fallback);
}

/**
 * Loads the re-indexing status and draws the documents, the write triggers and the latest events.
 * Only the newest events are shown, newest first.
 */
async function loadIndex() {
  const d = await api('/api/reindex/status');
  el('index-status').innerHTML =
    d.documents
      .map(
        (v: Data) => `<p><b>${esc(v.id)}</b> · ${esc(v.source)} · ${v.characters} characters</p>`,
      )
      .join('') +
    `<p>${d.chunkCount} indexed chunks</p>` +
    details('SQLite write triggers', d.triggers) +
    d.events
      .slice(-8)
      .reverse()
      .map(
        (v: Data) =>
          `<div class="trace-step ${v.status === 'skipped' ? '' : 'selected'}">${esc(v.operation)} → trigger fired → SHA-256 ${esc(v.status)} → ${v.embeddings} embeddings / ${v.reused} reused · ${v.beforeChunks} → ${v.afterChunks} chunks${details('Before / after fingerprints', v)}</div>`,
      )
      .join('');
}

/**
 * Makes a button run an async job.
 * While the job runs: the button is disabled, so a double click cannot start it twice.
 * If the job throws: the message appears under the button.
 * The button is enabled again either way.
 */
function action(id: string, fn: () => Promise<void>) {
  el(id).addEventListener('click', async () => {
    const b = el(id) as HTMLButtonElement;
    b.disabled = true;
    try {
      await fn();
    } catch (e) {
      const msg = document.createElement('p');
      msg.className = 'bad';
      msg.textContent = (e as Error).message;
      b.after(msg);
    } finally {
      b.disabled = false;
    }
  });
}

/** Sends a deliberately bad batch to the Quality Meter, to show the alerts firing. */
action('degrade', async () => {
  await api('/api/quality-meter/batch', { degraded: true });
  await loadGovernance();
});

/** Sends a healthy batch, to show the alerts clearing. */
action('recover', async () => {
  await api('/api/quality-meter/batch', { degraded: false });
  await loadGovernance();
});

/**
 * Handles the Approve, Edit and Release, and Reject buttons on held responses.
 * Sends the reviewer's choice and the text in the edit box, then reloads the data.
 * If our server rejects it: the message appears under the button.
 */
el('review-items').addEventListener('click', async (e) => {
  const b = (e.target as Element).closest<HTMLButtonElement>('[data-review]');
  if (!b) return;
  try {
    await api('/api/review-queue/action', {
      id: b.dataset.review,
      action: b.dataset.action,
      answer: (el('edit-' + b.dataset.review) as HTMLTextAreaElement).value,
    });
    await loadGovernance();
  } catch (e) {
    b.after(Object.assign(document.createElement('p'), { textContent: (e as Error).message }));
  }
});

/** Sends a short chat where the assistant repeats itself, to show stuck-bot detection. */
action('handoff-stuck', async () => {
  const d = await api('/api/handoff/check', {
    turns: [
      { role: 'user', content: 'Payment still fails' },
      { role: 'assistant', content: 'Update your card and retry the payment.' },
      { role: 'user', content: 'That did not resolve it' },
      { role: 'assistant', content: 'Update your card and retry the payment.' },
    ],
    confidenceScore: 0.5,
  });
  onInfrastructureEvent('handoff', d.handoff);
});

/** Sends a short chat where the user asks for a human twice, to show the handoff. */
action('handoff-repeat', async () => {
  const d = await api('/api/handoff/check', {
    turns: [
      { role: 'user', content: 'I need a human agent' },
      { role: 'assistant', content: 'Please provide details.' },
      { role: 'user', content: 'Please transfer me to a real person' },
    ],
  });
  onInfrastructureEvent('handoff', d.handoff);
});

/**
 * Sends the typed question, answer and source text to the judge.
 * Also sends whether Use separate live Claude judge is ticked.
 */
action('judge-run', async () => {
  const j = await api('/api/judge', {
    question: (el('judge-question') as HTMLTextAreaElement).value,
    answer: (el('judge-answer') as HTMLTextAreaElement).value,
    sources: [
      {
        sourceFile: 'operator-provided',
        text: (el('judge-evidence') as HTMLTextAreaElement).value,
      },
    ],
    live: (el('live-judge') as HTMLInputElement).checked,
  });
  judgeCards(j);
});

/** Asks our server to change a database document, then reloads the index status. */
action('mutate-doc', async () => {
  await api('/api/reindex/mutate', {});
  await loadIndex();
});

/**
 * Writes a document with the same text it already has.
 * The page fetches the file and sends it back unchanged. The text fingerprint should then match, so nothing is re-embedded.
 */
action('same-doc', async () => {
  const content = await (await fetch('/docs/api-and-webhooks.md')).text();
  await api('/api/reindex/mutate', { id: 'api-and-webhooks.md', content });
  await loadIndex();
});

/** Asks our server to delete a database document, then reloads the index status. */
action('delete-doc', async () => {
  await api('/api/reindex/mutate', { operation: 'delete' });
  await loadIndex();
});

/** Asks our server to put the original documents back, then reloads the index status. */
action('restore-docs', async () => {
  await api('/api/reindex/restore', {});
  await loadIndex();
});

/**
 * Wires the three workbench buttons.
 * normal: a short chat that fits.
 * bloat: long turns that grow fast, so trimming starts early.
 * overflow: a system prompt too large for the limit, so the call is rejected.
 * The limits sent are 8000 tokens, or 300 for overflow, and a growth limit of 160 tokens per turn.
 */
for (const [id, mode] of [
  ['context-normal', 'normal'],
  ['context-bloat', 'bloat'],
  ['context-overflow', 'overflow'],
])
  action(id, async () => {
    const d = await api('/api/context/build', {
      systemPrompt:
        mode === 'overflow'
          ? 'mandatory policy '.repeat(4000)
          : 'You are a grounded support assistant.',
      turns: Array.from({ length: 8 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content:
          mode === 'normal'
            ? 'Please check my invoice.'
            : ('Conversation detail ' + i + ' ').repeat(120),
      })),
      hardTokenLimit: mode === 'overflow' ? 300 : 8000,
      maxTokensPerTurnRate: 160,
    });
    renderContext(d, 'workbench-context');
  });

/**
 * Asks our server to run the question while pretending two named Claude models fail with HTTP 503.
 * Then draws the route and each attempt, to show the backup chain at work.
 * If the local fallback box is ticked: allows the free local last resort.
 */
action('fault-probe', async () => {
  const d = await api('/api/router/probe', {
    query: (el('question') as HTMLInputElement).value || 'What is my plan?',
    failModels: ['claude-haiku-4-5', 'claude-sonnet-4-5'],
    error: 'HTTP 503',
    localEnabled: (el('local-fallback') as HTMLInputElement).checked,
  });
  el('probe-result').innerHTML = details('Probe result and per-model failure rates', d);
  onInfrastructureEvent('routing', d.route);
  for (const a of d.attempts || []) onInfrastructureEvent('fallback', a);
});

/** Tells our server right away when the reader ticks or clears the local fallback box. */
el('local-fallback').addEventListener(
  'change',
  () =>
    void api('/api/router/probe', {
      localEnabled: (el('local-fallback') as HTMLInputElement).checked,
    }),
);

/** The golden eval questions listed by our server. */
let golden: Data[] = [];

/**
 * Returns the HTML for one eval question.
 * If no result is given: shows it as not run.
 * If a result is given: marks each required fact and source as found or missing.
 */
function renderEvalQuestion(q: Data, r?: Data) {
  return `<article class="eval-question" id="eval-${q.id}"><h3>${esc(q.id)} · ${esc(q.question)}</h3><span class="badge ${r?.status === 'passed' ? 'good' : r ? 'bad' : ''}">${r?.status || 'Not run'}</span><div class="compare-grid"><div><h4>Expected Answer</h4><p>${esc(q.expectedAnswer)}</p></div><div><h4>Actual Answer</h4><p>${esc(r?.actualAnswer || 'Awaiting replay')}</p></div></div><p>Required facts: ${q.requiredKeywords.map((k: unknown) => `<span class="badge ${(r?.missingKeywords || []).some((m: unknown) => JSON.stringify(m) === JSON.stringify(k)) ? 'bad' : r ? 'good' : ''}">${esc(Array.isArray(k) ? k.join(' / ') : k)}</span>`).join(' ')}</p><p>Required sources: ${q.requiredSources.map((s: string) => `<span class="badge ${r?.missingSources?.includes(s) ? 'bad' : r ? 'good' : ''}">${esc(s)}</span>`).join(' ')}</p>${r ? details('Drift reasons and independent rubric scores', { reasons: r.reasons, judge: r.judge }) : ''}</article>`;
}

/**
 * Replays every eval question on our server and updates each card as its result arrives.
 * The answer is a stream of server events, read in pieces and split on blank lines.
 * If the stream cannot start: throws Evaluation failed.
 * The status line shows progress, then passed and drifted totals.
 */
action('eval-run', async () => {
  el('eval-questions').innerHTML = golden.map((q) => renderEvalQuestion(q)).join('');
  let completed = 0;
  const r = await fetch('/api/eval/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      judge: (el('eval-judge') as HTMLInputElement).checked,
      liveJudge: (el('eval-live') as HTMLInputElement).checked,
      canary: (el('eval-canary') as HTMLInputElement).checked,
    }),
  });
  if (!r.ok || !r.body) throw new Error('Evaluation failed');
  const reader = r.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const event = frame.match(/^event: (.*)$/m)?.[1],
        raw = frame.match(/^data: (.*)$/m)?.[1];
      if (!raw) continue;
      const d = JSON.parse(raw);
      if (event === 'eval_result') {
        completed++;
        const q = golden.find((q) => q.id === d.id)!;
        el('eval-' + d.id).outerHTML = renderEvalQuestion(q, d);
        el('eval-status').textContent = `${completed}/20 completed`;
      }
      if (event === 'done')
        el('eval-status').textContent = `${d.passed}/20 passed · ${d.drifted} drifted`;
      if (event === 'pipeline_step')
        el('eval-status').textContent =
          `${completed}/20 · ${d.id} · ${d.event.replaceAll('_', ' ')}`;
    }
  }
});

/** Shows the required response format. */
void api('/api/schema').then((s) => (el('response-schema').innerHTML = pretty(s)));

/**
 * Draws the preset questions for the rewrite panel.
 * When the reader clicks one: loads its chat history and text, then submits the main question form.
 */
void api('/api/rewrite/queries').then((qs) => {
  el('rewrite-presets').innerHTML = qs
    .map((q: Data, i: number) => `<button data-rewrite="${i}">${esc(q.query)}</button>`)
    .join('');
  el('rewrite-presets').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('[data-rewrite]');
    if (!b) return;
    const q = qs[Number(b.dataset.rewrite)];
    turns = q.history || [];
    (el('question') as HTMLInputElement).value = q.query;
    (el('run-form') as HTMLFormElement).requestSubmit();
  });
});

/** Lists the eval questions as not run. */
void api('/api/eval/questions').then((d) => {
  golden = d.questions;
  el('eval-questions').innerHTML = golden.map((q) => renderEvalQuestion(q)).join('');
});

/** Loads the first data for the quality, index and routing views. */
void loadGovernance();

void loadIndex();

void loadRouting();

/** Adds tooltips to the jargon on the panels built above. */
installGlossary();

/**
 * Every ten seconds, while the quality tab is open, refreshes the governance data.
 * If the refresh fails: the error is ignored and the next one tries again.
 * Without it, new held responses would not appear until the reader switched tabs.
 */
window.setInterval(() => {
  if (!el('view-quality').hidden) void loadGovernance().catch(() => {});
}, 10000);
