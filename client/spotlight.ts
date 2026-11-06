/**
 * Why this file exists: it runs the pipeline page the user sees.
 * It sends the question to our server and reads the stream of events back.
 * It hands each event to the stage player, and draws the card for the stage on screen.
 * It also runs the Run button, the example buttons, the playback controls and the keyboard keys.
 * Without it, the page would show the idle screen and nothing else.
 */
import { StagePlayer, STAGES, type StageId, type RunState } from './stage-player.js';
import { installGlossary } from './glossary-tooltips.js';
import { wireTools } from './spotlight-tools.js';

/**
 * The data of one stage, as our server sent it. Any field can be missing, so every read is guarded.
 */
type D = Record<string, any>;

/** Finds an element by id. */
const el = (id: string) => document.getElementById(id)!;

/** Escapes any value for use inside HTML. A missing value becomes an empty string. */
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Shows a value as indented JSON, escaped for HTML. */
const json = (v: unknown) => esc(JSON.stringify(v, null, 2));

/** Shows a 0 to 1 number as a whole percent. Anything that is not a number shows a dash. */
const percent = (v: unknown) => (typeof v === 'number' ? Math.round(v * 100) + '%' : '—');

/** The small arrow drawn between boxes in a flow. */
const arrow = '<span class="flow-arrow" aria-hidden="true">→</span>';

/** Builds a small status label. `kind` picks its colour class. */
const pill = (label: string, kind = '') => `<span class="status-pill ${kind}">${esc(label)}</span>`;

/**
 * Returns the link for a cited source.
 * Normally: the link our server sent, if it is http or https.
 * If the link is missing, broken or another kind such as javascript: the link goes to our own /docs route for that file.
 * Without the check, a bad link in a document could run code when clicked.
 */
const sourceUrl = (s: D) => {
  const fallback = '/docs/' + encodeURIComponent(String(s.sourceFile));
  try {
    const url = new URL(s.url || fallback, location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : fallback;
  } catch {
    return fallback;
  }
};

/**
 * The one stage player. It holds the state of the current run and decides when to move between stages.
 */
export const player = new StagePlayer();

/** Returns the state of the current run, as held by the stage player. */
export const runState = () => player.state;

/** The abort handle passed to the running request. Nothing in this file calls abort on it. */
let controller: AbortController | null = null;

/**
 * The last questions and answers, sent with the next question so follow-ups make sense.
 * Only the latest 12 messages are kept.
 */
let history: Array<{ role: string; content: string }> = [];

/** The question of the current run. The cache and rewrite cards show it. */
let currentQuestion = '';

/** True while a request is open. A second question cannot start until it ends. */
let running = false;

/** The stage drawn last time. Used to keep opened sections open on a redraw of the same stage. */
let lastStage: StageId | null = null;

/** The card HTML drawn last time. The card is only replaced when this changes. */
let lastMarkup = '';

/**
 * A stage id from the address, such as ?pauseAt=search. The player pauses once when it reaches that stage.
 * Set to null after it fires.
 */
let pauseAt = new URLSearchParams(location.search).get('pauseAt');

/** The heading and the one-line subheading for each stage card. */
const titles: Record<StageId, [string, string]> = {
  security: ['Security check', 'Four gates. One protected request.'],
  cache: ['Have we answered this before?', 'Check for a saved answer before doing more work.'],
  'query-rewrite': ['Make the question clear.', 'Use a rewrite only when the question needs it.'],
  search: [
    'Find the right evidence.',
    'Search by exact words and by meaning, then re-check the best matches.',
  ],
  context: [
    'Assemble the model call.',
    'Only the instructions, tools, evidence and history this request needs.',
  ],
  router: ['Choose the right model.', 'Use a smaller model when it is enough. Keep backups ready.'],
  generate: ['Write the answer.', 'Live output · provisional until the source checks finish.'],
  'fact-check': ['Check the sources.', 'Working links, supported claims and matching quotations.'],
  result: ['A grounded answer.', 'The final response and the evidence behind it.'],
};

/** Builds one labelled box of a flow row. The label and value are already HTML. */
function flowCell(label: string, value: string, kind = '') {
  return `<div class="flow-cell ${kind}"><span>${label}</span><strong>${value}</strong></div>`;
}

/**
 * Draws the Security stage: four gates, one per prompt guard layer.
 * Each gate shows waiting, checking, passed, blocked, disabled or skipped.
 * Live guard events decide the status. If none arrived, the final guard report decides.
 * If a gate blocked the request: a notice says so and that no cache lookup, search or generation ran.
 */
function security(d: D) {
  const events = player.state.stages.security.events.filter((e) => e.event === 'guard_layer'),
    report = d.done?.guard || d.guard || d.blocked;
  const names = [
    'Known Phrase',
    'Disguised Characters',
    'Security Model',
    'Untrusted Text Boundary',
  ];
  return `<div class="security-gates">${names
    .map((name, i) => {
      const event = events.filter((e) => e.data.layerIndex === i + 1).at(-1)?.data;
      const r = event?.result || report?.layers?.[i];
      const status = r?.blocked
        ? 'blocked'
        : r?.status === 'off'
          ? 'off'
          : r?.status === 'cached-bypass' || r?.status === 'skipped'
            ? 'skipped'
            : r && (r.status === 'pass' || r.status === 'fenced' || r.status === 'contained')
              ? 'pass'
              : event?.phase === 'checking'
                ? 'checking'
                : 'waiting';
      return `<div class="security-gate ${status}"><span class="gate-number">${r?.blocked ? '×' : status === 'pass' ? '✓' : i + 1}</span><h3>${name}</h3><p>${esc(r?.blocked ? 'Request blocked' : status === 'pass' ? 'Passed' : status === 'checking' ? 'Checking…' : status === 'off' ? 'Disabled' : status === 'skipped' ? (player.state.cacheHit ? 'Skipped · cache hit' : 'Not run') : 'Waiting')}</p>${r?.blocked ? `<small>${esc(r.reason)}</small>` : ''}</div>${i < 3 ? arrow : ''}`;
    })
    .join(
      '',
    )}</div>${player.state.blocked ? `<div class="notice bad"><b>Request stopped here.</b><p>${esc(d.done?.answer || report?.layers?.find((l: D) => l.blocked)?.reason || 'A security check blocked this request.')}</p><small>No cache lookup, search or generation was run.</small></div>` : ''}`;
}

/**
 * Draws the semantic cache stage: the question, the nearest saved question,
 * the similarity against the threshold, and the decision, hit or miss.
 */
function cache(d: D) {
  const c = d.cache || {};
  return `<div class="flow-row cache-flow">${flowCell('Question', esc(currentQuestion))}${arrow}${flowCell('Nearest saved match', esc(c.matchedQuery || 'No saved match yet'))}${arrow}${flowCell('Match / strictness', `${percent(c.similarity)} <small>/ ${percent(c.threshold)}</small>`)}${arrow}${flowCell('Decision', c.hit ? 'HIT' : 'MISS', c.hit ? 'good' : 'neutral')}</div><p class="stage-caption">${c.hit ? 'Reuse the saved answer. Search and generation are skipped.' : 'No close-enough answer. Continue with this question.'}</p>`;
}

/**
 * Draws the query rewrite stage: the original question, whether it needed a rewrite and why,
 * and the question used for search.
 * If no rewrite was needed, it says no extra model call was made.
 */
function rewrite(d: D) {
  const r = d.query_rewrite || {};
  return `<div class="rewrite-flow"><div class="query-box"><span>Original question</span><p>${esc(r.originalQuery || currentQuestion)}</p></div>${arrow}<div class="rewrite-decision">${pill(r.needsRewrite ? 'Rewrite needed' : 'Kept as-is', r.needsRewrite ? 'accent' : 'good')}<p>${esc(r.needsRewrite ? (r.reasons || []).map((x: string) => ({ short_query: 'Short question', unresolved_reference: 'Refers to earlier context', elliptical_followup: 'Follow-up question', domain_abbreviation: 'Abbreviated wording' })[x] || x).join(' · ') : 'Self-contained question')}</p></div>${arrow}<div class="query-box rewritten"><span>${r.needsRewrite ? 'Search query' : 'Search query · unchanged'}</span><p>${esc(r.rewrittenQuery || currentQuestion)}</p></div></div>${r.needsRewrite ? `<p class="stage-caption">${esc(r.backend === 'deterministic-contextualizer' ? 'Context-based rules' : r.backend === 'skipped' ? 'No model call' : 'Haiku rewrite')} · ${r.tokensUsed ?? 0} rewrite tokens${typeof r.retrievalLift === 'number' ? ' · relevance change ' + r.retrievalLift.toFixed(2) : ''}</p>` : '<p class="stage-caption">No extra model call. Zero rewrite tokens.</p>'}`;
}

/**
 * Draws the search stage: BM25 and vector search, merged by reciprocal rank fusion.
 * Shows how many matches each found, then the top three sections, each opening to its text.
 * If search ran more than once, adds the number of passes and why the last one ended.
 */
function search(d: D) {
  const r = d.reranking || d.fusing || {},
    results = (r.results || []) as D[],
    passes = player.state.stages.search.events.filter((e) => e.event === 'search_pass');
  return `<div class="retrieval-top"><div>Exact Word Search <small>BM25 · ${r.bm25List?.length ?? '—'} matches</small></div><span>+</span><div>Meaning Search <small>Vector embeddings · ${r.vectorList?.length ?? '—'} matches</small></div></div><div class="down-arrow">↓</div><div class="ranking-node">Combined Ranking <small>${r.rrfShortlist?.length ?? '—'} candidates</small></div><div class="down-arrow">↓</div><div class="snippet-list">${
    results
      .slice(0, 3)
      .map(
        (c, i) =>
          `<details class="snippet"><summary><span class="snippet-rank">${i + 1}</span><span>${esc(c.headingPath || c.sourceFile)}</span><span class="expand-mark">+</span></summary><p class="context-header">${esc(c.contextHeader || '')}</p><p>${esc(c.rawContent || c.prefixedText)}</p></details>`,
      )
      .join('') ||
    '<p class="stage-caption">No permitted document section matched closely enough.</p>'
  }</div>${passes.length ? `<p class="stage-caption">${passes.length} search ${passes.length === 1 ? 'pass' : 'passes'} · ${esc(passes.at(-1)!.data.terminationReason?.replaceAll('_', ' ') || 'searching')}</p>` : ''}`;
}

/**
 * Draws the context stage: the five parts of the LLM call and how many tokens each added.
 * Parts appear as our server reports them. A bar shows the running total against the hard limit.
 * The line below compares the growth per turn with its limit.
 * If our server did not send those two limits, the page uses 200000 tokens and 160 tokens per turn.
 * If the history was compacted, shows the turns before and after.
 */
function context(d: D) {
  const c = d.context || {},
    steps = player.state.stages.context.events
      .filter((e) => e.event === 'context_step')
      .map((e) => e.data);
  const blocks = ['System Instructions', 'Tools', 'Retrieved Sections', 'Chat History', 'Question'];
  return `<div class="context-window"><div class="context-blocks">${blocks
    .map((b, i) => {
      const step = steps.filter((s) => s.index === i + 1).at(-1);
      return `<div class="context-block ${step ? 'added' : ''}" style="--block:${i}"><span>${step ? '✓' : '○'}</span><b>${b}</b><small>${step ? step.tokens + ' tokens' : 'Waiting'}</small></div>`;
    })
    .join(
      '',
    )}</div><div class="token-total"><strong>${Number(c.runningTokens || steps.at(-1)?.runningTokens || 0).toLocaleString()}</strong><span>tokens assembled</span></div><div class="token-bar"><span style="width:${Math.min(100, ((c.runningTokens || 0) / (c.hardTokenLimit || 200000)) * 100)}%"></span></div><div class="context-budget"><span>Turn Size Growth Rate: ${Math.round(c.recentTokensPerTurn || 0)} / ${c.maxTokensPerTurnRate ?? 160} tokens per turn</span><span>${c.fitsInWindow === false ? 'Does not fit · call stopped' : 'Fits model window'}</span></div></div>${c.compacted ? `<div class="compaction-flow"><div><span>Before</span><b>${c.before?.turns?.length ?? 0} turns</b><p>${esc(c.before?.turns?.[0]?.content?.slice(0, 130))}</p></div>${arrow}<div><span>After · ${c.triggerReason === 'growth_rate' ? 'Fast turn growth' : 'Window limit'}</span><b>${c.after?.turns?.length ?? 0} turns</b><p>${esc(c.summary?.slice(0, 200))}</p></div></div>` : ''}`;
}

/**
 * Draws the model router stage: the clues that made the question hard, and which model was chosen.
 * Shows the backup chain only if an attempt failed.
 * The last line reports the prompt cache for the fixed instructions: hit, miss, or waiting.
 * The model is named Opus if its id contains opus. Otherwise the card says Sonnet.
 */
function router(d: D) {
  const r = d.routing || {},
    cache = d.prompt_cache || {},
    attempts = player.state.stages.router.events
      .filter((e) => e.event === 'fallback')
      .map((e) => e.data);
  const labels: Record<string, string> = {
    prompt_length: 'Long question',
    linguistic_tells: 'Deeper reasoning',
    multiple_questions: 'Several questions',
    tool_involvement: 'Support tools needed',
    historical_quality: 'Past answer quality',
  };
  return `<div class="difficulty-clues">${
    (r.signals || [])
      .filter((s: D) => s.active)
      .map((s: D) => pill(labels[s.id] || s.id, 'accent'))
      .join('') || pill('Straightforward question', 'good')
  }</div><div class="router-flow"><div class="router-node">Question</div>${arrow}<div class="router-node selected">Model selection</div>${arrow}<div class="model-branches"><div class="model-branch ${r.tier === 'small' ? 'selected' : 'dim'}">Haiku <small>Fast & efficient</small>${r.tier === 'small' ? '<b>Selected ✓</b>' : ''}</div><div class="model-branch ${r.tier === 'escalated' ? 'selected' : 'dim'}">${String(r.model).includes('opus') ? 'Opus' : 'Sonnet'} <small>More reasoning</small>${r.tier === 'escalated' ? '<b>Selected ✓</b>' : ''}</div></div></div>${attempts.some((a) => !a.success) ? `<div class="backup-chain">${attempts.map((a, i) => `${i ? arrow : ''}<span class="backup-link ${a.success ? 'good' : 'bad'}">${esc(String(a.model).replace('claude-', ''))}<small>${a.success ? 'Caught request' : esc(a.errorType || 'Unavailable')}</small></span>`).join('')}</div>` : ''}<p class="stage-caption"><span data-tooltip="Reuses the fixed instructions and tool definitions when supported. Only provider usage confirms actual token savings; local estimates are labeled separately." tabindex="0">Shared Instructions Cache</span> · ${cache.hit === true ? '<b class="good">HIT</b> · ' + cache.tokensSaved + ' tokens saved' : cache.hit === false ? '<b>MISS</b> · prefix written' : 'Waiting for model usage'}${cache.source ? ' <small>(' + esc(cache.source.includes('estimate') ? 'local estimate' : 'provider reported') + ')</small>' : ''}</p>`;
}

/**
 * Draws the generate stage: the answer as the stage player has typed it so far.
 * Also shows the last tool the LLM used, any stream error, and how many tool calls ran.
 * A stream error says whether our server is trying a backup model or holding the answer for review.
 */
function generate(d: D) {
  const visibleAnswer = player.displayedAnswer();
  const steps = player.state.stages.generate.events.filter((e) => e.event === 'agent_step'),
    last = steps.filter((e) => e.data.tool).at(-1)?.data;
  const toolNames: Record<string, string> = {
    search_support_docs: 'Doc Search',
    lookup_support_ticket: 'Ticket Lookup',
    escalate_to_human_agent: 'Escalation',
  };
  const error = player.state.stages.generate.events
    .filter((e) => e.event === 'stream_error')
    .at(-1)?.data;
  return `${last?.tool ? `<div class="active-tool"><span>✓</span>${esc(toolNames[last.tool] || last.tool)} <small>Completed · Iteration ${last.iteration} of ${last.maxIterations}</small></div>` : ''}<div class="live-answer ${visibleAnswer ? '' : 'empty'}">${esc(visibleAnswer || 'The selected model is preparing its response…')}${!player.state.finished ? '<span class="typing-cursor"></span>' : ''}</div>${error ? `<p class="stage-caption bad">${esc(error.error || 'Stream interrupted')} · ${error.recoverable ? 'trying a backup' : 'held for review'}</p>` : ''}<p class="stage-caption">${player.state.error ? 'Stream stopped.' : player.state.finished ? 'Generation complete.' : 'Answer arrives as it is written.'}${steps.filter((s) => s.data.phase === 'tool').length ? ' · ' + steps.filter((s) => s.data.phase === 'tool').length + ' tool calls' : ''}</p>`;
}

/**
 * Draws the fact-check stage: for each cited source, three checks in a row.
 * They are the link check, the NLI model meaning match, and the exact quote match.
 * While the stream runs, each check follows its live event. After the final report, it follows the report.
 * Without a source, the card says there is nothing to verify.
 */
function factCheck(d: D) {
  const report = d.report || {},
    events = player.state.stages['fact-check'].events.filter((e) => e.event === 'citation_check');
  const sourceNames = new Map<string, string>();
  for (const event of events)
    sourceNames.set(String(event.data.citationIndex), event.data.sourceFile);
  for (const [i, row] of (report.rows || []).entries())
    sourceNames.set(String(i + 1), row.sourceFile);
  return `<div class="source-checks">${
    [...sourceNames]
      .map(([id, name]) => {
        const row = report.rows?.[Number(id) - 1];
        return `<div class="source-check"><h3>${esc(name)}</h3><div class="fact-gates">${[
          'Link Check',
          'Meaning Match (DeBERTa NLI)',
          'Exact Quote Match',
        ]
          .map((name, i) => {
            const event = events
              .filter((e) => String(e.data.citationIndex) === id && e.data.step === i + 1)
              .at(-1)?.data;
            const result =
              event?.result || [row?.urlCheck, row?.entailmentCheck, row?.quoteCheck][i];
            const done = event?.phase === 'done' || Boolean(row);
            const pass = i === 0 ? result?.valid : result?.passed;
            const contradiction =
              i === 1 && result?.claims?.some((c: D) => c.label === 'CONTRADICTION');
            return `<div class="fact-gate ${done ? (pass ? 'pass' : 'failed') : event ? 'checking' : ''}"><span>${done ? (pass ? '✓' : '×') : event ? '◌' : '○'}</span><b>${name}</b><small>${done ? (pass ? (i === 1 ? 'Backs up claim' : 'Passed') : contradiction ? 'Contradicts source' : 'Needs review') : event ? 'Checking…' : 'Waiting'}</small></div>${i < 2 ? arrow : ''}`;
          })
          .join('')}</div></div>`;
      })
      .join('') || '<p class="stage-caption">No cited source is available to verify.</p>'
  }</div>`;
}

/**
 * Draws the result stage: the final answer, its cited sources and the confidence score.
 * Shows a held-for-review notice if the answer was not released to the customer.
 * Shows the human handoff message if one was prepared.
 * A source reads Verified only if the citation check passed. Otherwise it reads Needs review.
 */
function result(d: D) {
  const r = d.done || {},
    held = r.releaseAllowed === false,
    check = r.citationCheck,
    confidence = r.confidence?.confidenceScore;
  return `${held ? `<div class="notice warning"><b>Held for review</b><p>This response has not been released to the customer.</p></div>` : ''}${r.handoff ? `<div class="notice"><b>Human handoff prepared</b><p>${esc(r.handoff.customerMessage)}</p></div>` : ''}<div class="final-answer">${esc(r.answer || 'No answer was returned.')}</div><div class="answer-evidence"><div class="sources"><span>Cited sources</span>${
    (r.sources || [])
      .slice(0, 5)
      .map(
        (s: D) =>
          `<a href="${esc(sourceUrl(s))}" target="_blank" rel="noreferrer">${esc(s.sourceFile)} ${check?.status === 'verified' ? '<b>✓ Verified</b>' : '<small>Needs review</small>'}</a>`,
      )
      .join('') || '<p>No cited source</p>'
  }</div><div class="final-confidence"><span>Confidence Score</span><strong>${percent(confidence)}</strong></div></div><p class="inspection-hint">Click any step above or ← Prev to inspect each stage.</p>`;
}

/** Which function draws the card for each stage. */
const renderers: Record<StageId, (d: D) => string> = {
  security,
  cache,
  'query-rewrite': rewrite,
  search,
  context,
  router,
  generate,
  'fact-check': factCheck,
  result,
};

/**
 * Draws the whole page for the state of the stage player.
 * Shows the playback bar, the stepper with one button per stage, and the card for the stage on screen.
 * If the address had pauseAt and that stage is reached: pauses the player once.
 * If nothing is running yet: draws nothing.
 * The card is only replaced when its HTML changed. If the stage is the same, sections the user opened stay open.
 * Without that, a redraw while the user reads a snippet would close it.
 */
export function renderSpotlight() {
  const state = player.state;
  if (pauseAt && state.active === pauseAt) {
    player.pause();
    pauseAt = null;
  }
  if (!state.active) return;
  el('idle-state').hidden = true;
  el('playback-bar').hidden = false;
  el('spotlightContainer').hidden = false;
  el('pipeline-stepper').innerHTML = STAGES.map((s, i) => {
    const r = state.stages[s.id],
      current = state.active === s.id,
      visited = state.visited.includes(s.id),
      stopped = r.status === 'stopped',
      skip = r.status === 'skipped';
    return `<button class="step-pill ${current ? 'current' : ''} ${visited ? 'visited' : ''} ${skip ? 'skipped' : ''} ${stopped ? 'stopped' : ''}" data-step="${s.id}" ${(!r.ready && !r.events.length) || skip || stopped ? 'disabled' : ''} aria-current="${current ? 'step' : 'false'}" title="${skip ? (state.cacheHit ? 'Skipped (Cache Hit)' : 'Not required') : stopped ? 'Stopped' : s.label}"><span>${visited && !current ? '✓' : i + 1}</span><b>${s.label}</b>${skip ? (state.cacheHit ? '<small>Cache hit</small>' : '<small>Skipped</small>') : stopped ? '<small>Stopped</small>' : ''}</button>`;
  }).join('');
  const active = state.active,
    data = state.stages[active].data;
  const body = renderers[active](data);
  const markup = `<section class="spotlight-card ${state.playing ? 'autoplay' : ''}" data-step-view="${active}" aria-label="${esc(STAGES.find((s) => s.id === active)!.label)}"><div class="stage-progress"><span id="stage-progress-fill"></span></div><div class="spotlight-heading"><p class="eyebrow">STEP ${STAGES.findIndex((s) => s.id === active) + 1} OF 9${state.blocked ? ' · STOPPED' : active === 'result' && state.finished ? ' · COMPLETE' : state.playing ? ' · LIVE PLAYBACK' : ' · PAUSED'}</p><h2>${titles[active][0]}</h2><p>${titles[active][1]}</p></div><div class="step-content">${body}</div>${state.error ? `<div class="notice bad">${esc(state.error)}</div>` : ''}</section>`;
  if (markup !== lastMarkup) {
    const openDetails = new Set(
      [...el('spotlightContainer').querySelectorAll('details')].flatMap((d, i) =>
        (d as HTMLDetailsElement).open ? [i] : [],
      ),
    );
    el('spotlightContainer').innerHTML = markup;
    if (lastStage === active) {
      [...el('spotlightContainer').querySelectorAll('details')].forEach((d, i) => {
        if (openDetails.has(i)) (d as HTMLDetailsElement).open = true;
      });
    }
    lastMarkup = markup;
    lastStage = active;
  }
  el('play-pause').textContent = state.playing ? '⏸ Pause' : '▶ Play';
  el('play-pause').setAttribute('aria-label', state.playing ? 'Pause playback' : 'Play playback');
  (el('prev-step') as HTMLButtonElement).disabled = active === 'security';
  (el('next-step') as HTMLButtonElement).disabled = active === 'result' || state.blocked;
  document.documentElement.dataset.activeStep = active;
}

/**
 * Sends one question to our server and feeds the event stream to the stage player.
 * Starts a new run, disables the Run button, and redraws after every event.
 * Reads the stream by hand, because the question has to be sent as a POST.
 * If the guard did not block the request: adds the question and answer to the history.
 * If the stream ends early, or the request fails: shows an error on the page.
 * Does nothing if a question is already running.
 */
export async function runQuestion(question: string) {
  if (running) return;
  running = true;
  currentQuestion = question;
  controller = new AbortController();
  player.start();
  lastMarkup = '';
  renderSpotlight();
  (el('btn-run') as HTMLButtonElement).disabled = true;
  try {
    const r = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        message: question,
        rolePreset: (el('role') as HTMLSelectElement).value,
        history,
      }),
      signal: controller.signal,
    });
    if (!r.ok || !r.body) throw new Error('Request could not start (' + r.status + ')');
    const reader = r.body.getReader(),
      decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = frame.match(/^event:\s*(.*)$/m)?.[1],
          raw = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('\n');
        if (!event || !raw) continue;
        const data = JSON.parse(raw);
        player.ingest(event, data);
        if (event === 'done' && !data.blockedByGuard) {
          history.push(
            { role: 'user', content: question },
            { role: 'assistant', content: data.answer || '' },
          );
          history = history.slice(-12);
        }
        renderSpotlight();
      }
    }
    if (!player.state.finished)
      player.ingest('error', { error: 'The stream ended before the response was complete.' });
  } catch (error) {
    player.ingest('error', { error: (error as Error).message });
  } finally {
    running = false;
    (el('btn-run') as HTMLButtonElement).disabled = false;
    renderSpotlight();
  }
}

/** Runs the question in the box when the form is submitted. An empty box does nothing. */
el('run-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const question = (el('question') as HTMLInputElement).value.trim();
  if (question) void runQuestion(question);
});

/** Makes each example button fill the question box and run that question. */
document.querySelectorAll<HTMLButtonElement>('[data-example]').forEach(
  (b) =>
    (b.onclick = () => {
      (el('question') as HTMLInputElement).value = b.dataset.example!;
      void runQuestion(b.dataset.example!);
    }),
);

/** Play or pause the stage player. */
el('play-pause').onclick = () => {
  player.toggle();
  renderSpotlight();
};

/** Go to the previous stage. */
el('prev-step').onclick = () => {
  player.move(-1);
  renderSpotlight();
};

/** Go to the next stage. */
el('next-step').onclick = () => {
  player.move(1);
  renderSpotlight();
};

/** Play the recorded request again from the first stage. */
el('replay').onclick = () => {
  player.replay();
  renderSpotlight();
};

/** Opens the stage whose stepper button the user clicked. */
el('pipeline-stepper').addEventListener('click', (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>('[data-step]');
  if (button) {
    player.select(button.dataset.step as StageId);
    renderSpotlight();
  }
});

/** Pauses playback when the user clicks the card, so the user can read it. */
el('spotlightContainer').addEventListener('click', () => {
  if (player.state.playing) {
    player.pause();
    renderSpotlight();
  }
});

/**
 * Keyboard keys: Space plays or pauses, the arrow keys go back and forward.
 * Ignored while the user types in a field or dialog, or before a run has started.
 */
document.addEventListener('keydown', (e) => {
  if (
    (e.target instanceof Element && e.target.closest('input,select,textarea,dialog')) ||
    !player.state.active
  )
    return;
  if (e.code === 'Space') {
    e.preventDefault();
    player.toggle();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    player.move(-1);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    player.move(1);
  } else return;
  renderSpotlight();
});

/**
 * Every 50 milliseconds: lets the stage player move on, redraws if it did, and fills the progress bar.
 * Without it, stages would never advance and the typing of the answer would stop.
 */
window.setInterval(() => {
  if (player.tick()) renderSpotlight();
  const progress = el('stage-progress-fill');
  if (progress) progress.style.transform = `scaleX(${player.progress()})`;
}, 50);

/** Sets up the Tools menu and its dialog. */
wireTools();

/** Adds hover tooltips for the glossary terms on the page. */
installGlossary();

/** If the address has ?run=a question, the page runs that question on load. */
const startupQuestion = new URLSearchParams(location.search).get('run');

if (startupQuestion) {
  (el('question') as HTMLInputElement).value = startupQuestion;
  void runQuestion(startupQuestion);
}
