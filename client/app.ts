/**
 * Why this file exists: it runs the five-step retrieval walkthrough with its 3D
 * canvas. It sends the user's question to our server and keeps the replies.
 * It then draws each step as a card: keyword search, vector search with the
 * RBAC role filter, reciprocal rank fusion, cross-encoder reranking, and the
 * LLM answer. It also runs the role buttons, the local Claude login button,
 * and the BM25 and cosine similarity labs.
 *
 * The current public/index.html loads spotlight.js. It does not load this file,
 * and it has none of the elements this file reads, such as #stage-card.
 * Without this file, the five-step walkthrough would have no code behind it.
 */
import { onInfrastructureEvent, conversationHistory } from './production-ui.js';
import {
  wireCitationChecker,
  resetCitationChecks,
  animateCitationReport,
  dockCitations,
  type CitationReport,
} from './citation-checker-ui.js';
import {
  wirePromptGuard,
  renderGuard,
  beginGuardSequence,
  queueGuardLayer,
  finishGuardSequence,
  guardBreakdownHtml,
  type GuardLayerEvent,
  type GuardReport,
} from './prompt-guard-ui.js';
import { Pipeline3D } from './pipeline3d.js';
import { Cosine3D } from './cosine3d.js';
import {
  wireSemanticCache,
  currentCacheThreshold,
  renderCacheTelemetry,
  refreshCache,
  type CacheTelemetry,
} from './semantic-cache-ui.js';

/**
 * Finds one element by CSS selector. The caller names its type.
 * If the page has no such element, this returns null and the next line fails.
 */
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

/** The title of each of the five steps, in order. Shown on the step cards and the status line. */
const STAGE_NAMES = [
  'Keyword Search — Best Matching 25 (BM25)',
  'Vector Search — Pinecone + Role Permission Filter',
  'Reciprocal Rank Fusion (RRF) — Smoothing (+ k = 30)',
  'Cross-Encoder (CE) Re-Ranking',
  'Grounded Answer — Large Language Model (LLM)',
] as const;

/**
 * One plain sentence for each step, in the same order as STAGE_NAMES. Shown under the step title.
 */
const STAGE_PLAIN = [
  'Finds chunks that share exact words with your question, giving rarer words higher weight.',
  'Checks your active role in Pinecone first, then measures which allowed chunk vectors point closest to your question vector.',
  'Turns both ranked lists into gentle 1 / (30 + rank) scores and adds them together so chunks strong in both searches rise to the top.',
  'Reads your full question alongside each shortlisted chunk word-for-word to score true relevance.',
  'Writes a clean answer using only the top 3 re-ranked chunks.',
] as const;

/** The name of the step after each step, in order. Step 5 has none. Used on the Next button. */
const NEXT_NAMES = ['Vector Search', 'Combine Ranks', 'Re-Rank', 'Answer', null];

/** Example questions shown as buttons. The second one is the first reworded. */
const PRESETS = [
  { label: 'Payment declined', query: 'Getting ERR_PAYMENT_402 on renewal' },
  { label: 'Payment declined (paraphrase)', query: 'My renewal card charge failed with code 402' },
  { label: '14-day refund policy', query: 'How do I request a refund within 14 days?' },
  {
    label: 'Single Sign-On (SSO) certificate',
    query: 'How do I rotate an expired SAML certificate after SSO broke?',
  },
];

/**
 * Each role button's id, its label and the roles it grants.
 * The page sends the preset id and the roles with every question.
 */
const ROLE_PRESETS: Record<string, { label: string; roles: string[] }> = {
  admin: { label: 'All Roles (Admin)', roles: ['admin', 'billing', 'engineering', 'all'] },
  billing: { label: 'Billing', roles: ['billing', 'all'] },
  engineering: { label: 'Engineering', roles: ['engineering', 'all'] },
  all: { label: 'Public', roles: ['all'] },
};

/** What our server reports about the local Claude command-line tool. */
interface ClaudeStatus {
  installed: boolean;
  binaryPath: string | null;
  loggedIn: boolean;
  account: string | null;
  active: boolean;
  loginInProgress: boolean;
  loginUrl: string | null;
  lastError: string | null;
}

/** What the health route reports. Every field can be missing. */
interface Health {
  mock?: boolean;
  mockEmbeddings?: boolean;
  llmProvider?: string;
  chunkCount?: number;
  rrfK?: number;
  finalTopK?: number;
  rerankerBackend?: string;
  pinecone?: { backend?: string; indexName?: string; hasApiKey?: boolean };
}

/**
 * The data of one question, collected from the event stream.
 * Each field is null until its event arrives.
 */
interface StreamBundle {
  retrieval: Record<string, unknown> | null;
  fusing: Record<string, unknown> | null;
  reranking: Record<string, unknown> | null;
  done: Record<string, unknown> | null;
  answeringStarted: boolean;
}

/**
 * A chunk the RBAC role filter removed for the selected role.
 * The two scores show what the chunk would have scored if it had been allowed.
 */
interface ExcludedChunk {
  id: string;
  sourceFile: string;
  headingPath: string;
  chunkRoles: string[];
  cosineSim: number;
  bm25Score: number;
}

/**
 * All page state in one object.
 * `unlocked` is the highest step the user may open. `explorerK` is the k on the slider.
 * `baseK` is the k our server used. `bundle` holds the latest question's data.
 */
const state = {
  health: null as Health | null,
  chunking: null as Record<string, unknown> | null,
  claude: null as ClaudeStatus | null,
  claudePoll: null as ReturnType<typeof setInterval> | null,
  stage: 0,
  unlocked: 0,
  explorerK: 30,
  baseK: 30,
  rolePreset: 'admin' as string,
  roles: ['admin', 'billing', 'engineering', 'all'] as string[],
  bundle: {
    retrieval: null,
    fusing: null,
    reranking: null,
    done: null,
    answeringStarted: false,
  } as StreamBundle,
  running: false,
};

/** The 3D canvas. Stays null if WebGL is not available. */
let pipeline: Pipeline3D | null = null;

/**
 * Sets up the whole page when it loads.
 * Builds the 3D canvas, wires every button and panel, then loads the health report
 * and the chunk list from our server.
 * If WebGL is not available, the page still works without the 3D canvas.
 */
async function init(): Promise<void> {
  try {
    pipeline = new Pipeline3D($('#pipeline-canvas-host'));
    if (pipeline) {
      pipeline.onStageChange = (s) => syncStageUi(s);
      pipeline.onStageClick = (s) => goStage(s);
    }
  } catch (e) {
    console.warn('3D WebGL unavailable in this context:', e);
  }
  renderPresets();
  wireForm();
  wireWalkControls();
  wireClaudeLogin();
  wireHotReload();
  wireKeyboard();
  wireMathLabs();
  wireRoleSwitcher();
  wireCitationChecker(() => goStage(5));
  await wireSemanticCache(() => state.rolePreset);
  await wirePromptGuard(
    /** Runs a prompt guard test attack as a normal question. */
    (query, simulateIndirectInjection) => {
      ($('#question') as HTMLInputElement).value = query;
      void runPipeline(query, { simulateIndirectInjection });
    },
    /**
     * Draws one prompt guard layer as it reports in.
     * On a replay-complete event: draws the 3D walkthrough again, unless a question is running
     * or the guard blocked the request.
     * Otherwise: shows the layer on the step card, the 3D canvas and the status line.
     */
    (event) => {
      if (event.phase === 'replay-complete') {
        if (state.running) return;
        if (!state.bundle.done?.blockedByGuard) {
          pipeline?.loadWalkthrough(
            walkPayloadFromBundle(state.bundle, ($('#question') as HTMLInputElement).value),
            state.bundle.done?.chatStep as never,
            state.explorerK,
          );
          goStage(state.stage);
        }
        return;
      }
      const names = [
        'Naive Substring',
        'Regex + Normalize',
        'Guard LLM Classifier',
        'Data-Side Isolation',
      ];
      const name = names[event.layerIndex - 1];
      dockCitations();
      $('#stage-card').innerHTML =
        `<section class="guard-live-answer"><h3>🛡 Four-Layer Guard · Before answer delivery</h3>${guardBreakdownHtml()}<p class="muted">Live detector outcomes · Visual pacing only; server timings remain real.</p></section>`;
      const blocked = Boolean(event.result?.blocked);
      if (event.phase === 'checking' || blocked || event.result?.status === 'contained')
        pipeline?.showGuardStage(
          event.layerIndex,
          name,
          blocked ? 'blocked' : event.result?.status === 'contained' ? 'contained' : 'checking',
        );
      $('#viewport-funnel').innerHTML =
        `<div class="vf-caption">🛡 Guard ${event.layerIndex} / 4 · <strong>${esc(name)}</strong> · ${blocked ? 'BLOCKED — Retrieval &amp; Claude never reached' : event.phase === 'checking' ? 'Checking…' : event.phase === 'halted' ? 'Halted' : event.phase === 'cached-bypass' ? 'LLM skipped via Semantic Cache' : 'Check complete'}</div>`;
      if (event.phase === 'checking')
        setStatus(`🛡 Guard ${event.layerIndex} / 4 — ${name} checking…`, '');
    },
  );

  state.health = await fetchJson<Health>('/health');
  updateHeader(state.health);
  state.chunking = await fetchJson('/api/chunks');
  updateRoleFilterPill(null);
  renderViewportFunnel(0);
  await refreshClaudeStatus();
  /** The admin role button starts as the selected one. */
  document.querySelectorAll('.role-btn').forEach((el) => {
    el.classList.toggle('active', (el as HTMLElement).dataset.preset === 'admin');
  });
}

/** Draws the example question buttons. Clicking one fills the question box and runs it. */
function renderPresets(): void {
  const box = $('#presets');
  box.innerHTML = '';
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill';
    b.textContent = p.label;
    b.addEventListener('click', () => {
      ($('#question') as HTMLInputElement).value = p.query;
      void runPipeline(p.query);
    });
    box.appendChild(b);
  }
}

/**
 * Makes the role buttons work.
 * Clicking one sets the role, refreshes the semantic cache panel for that role,
 * and updates the role filter pill. If a question is in the box, it runs again.
 * Without the rerun, the cards would still show results for the old role.
 */
function wireRoleSwitcher(): void {
  document.querySelectorAll('.role-btn').forEach((el) => {
    el.addEventListener('click', () => {
      const btn = el as HTMLElement;
      const preset = String(btn.dataset.preset || 'admin');
      let roles: string[] = ROLE_PRESETS[preset]?.roles || [
        'admin',
        'billing',
        'engineering',
        'all',
      ];
      try {
        roles = JSON.parse(String(btn.dataset.roles || '[]')) as string[];
      } catch {
        /** If data-roles is not valid JSON, the roles from the preset table stay. */
      }
      state.rolePreset = preset;
      state.roles = roles;
      void refreshCache();
      document.querySelectorAll('.role-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      updateRoleFilterPill(
        (state.bundle.done?.retrieval as { permissionReport?: Record<string, unknown> } | undefined)
          ?.permissionReport || null,
      );
      const q = ($('#question') as HTMLInputElement).value.trim();
      if (q) void runPipeline(q);
    });
  });
}

/**
 * Writes the role pill: the role name and how many chunks that role can read.
 * Hovering shows the Pinecone filter used. Before any question, counts come from the health report.
 * A count shows ? if our server has not reported it.
 */
function updateRoleFilterPill(report: Record<string, unknown> | null): void {
  const el = $('#role-filter-pill');
  const roles = state.roles;
  const accessible = report ? Number(report.accessibleChunkCount ?? '?') : '?';
  const total = report
    ? Number(report.totalChunkCount ?? state.health?.chunkCount ?? '?')
    : (state.health?.chunkCount ?? '?');
  el.textContent = `${ROLE_PRESETS[state.rolePreset]?.label || 'Role'} · ${accessible} / ${total} chunks accessible`;
  el.title = `Pinecone Filter: ${JSON.stringify({ roles: { $in: roles } })}`;
}

/** Makes the question form run the question when submitted. */
function wireForm(): void {
  $('#run-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = ($('#question') as HTMLInputElement).value.trim();
    if (q) void runPipeline(q);
  });
}

/**
 * Makes Previous, Next, Replay and the step nodes work.
 * A step node opens its step only if the user has already reached it.
 */
function wireWalkControls(): void {
  $('#btn-prev').addEventListener('click', () => goStage(state.stage - 1));
  $('#btn-next').addEventListener('click', () => goStage(state.stage + 1));
  $('#btn-replay').addEventListener('click', () => {
    if (state.unlocked >= 1) goStage(1);
  });
  document.querySelectorAll('.stage-node').forEach((el) => {
    el.addEventListener('click', () => {
      const s = Number((el as HTMLElement).dataset.stage);
      if (s <= state.unlocked) goStage(s);
    });
  });
}

/**
 * Adds keyboard shortcuts: Space, N or the right arrow for the next step, the left arrow for the previous.
 * Ignored while the user types in a field, or before a question has run.
 */
function wireKeyboard(): void {
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!state.unlocked) return;
    if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      goStage(Math.min(5, state.stage + 1));
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      goStage(Math.max(1, state.stage - 1));
    }
  });
}

/** Takes the cursor out of the question box, so Space moves to the next step and does not type. */
function blurQuestion(): void {
  ($('#question') as HTMLInputElement).blur();
}

/**
 * Runs one question through our server and draws the result.
 * Resets the walkthrough, then collects the reply from the event stream.
 * If the stream cannot be used: asks the chat route for the whole reply at once.
 * If the prompt guard blocked the request: shows the block and stops. The semantic cache is untouched.
 * Normally: loads the 3D walkthrough, unlocks all five steps and opens step 1.
 * If the semantic cache answered: opens step 5 only.
 * If anything fails: shows the error in the status pill.
 * Does nothing if a question is already running. Two at once would mix their results.
 */
async function runPipeline(
  query: string,
  guardOptions: Record<string, unknown> = {},
): Promise<void> {
  if (state.running) return;
  state.running = true;
  blurQuestion();
  resetWalk();
  beginGuardSequence();
  resetCitationChecks();
  setStatus('🛡 Prompt Guard — inspecting query before cache & retrieval…', '');
  ($('#btn-run') as HTMLButtonElement).disabled = true;

  const bundle: StreamBundle = {
    retrieval: null,
    fusing: null,
    reranking: null,
    done: null,
    answeringStarted: false,
  };
  state.bundle = bundle;

  try {
    const usedStream = await runViaStream(query, bundle, guardOptions);
    if (!usedStream) {
      const data = await fetchJson<Record<string, unknown>>('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: query,
          history: conversationHistory(),
          roles: state.roles,
          rolePreset: state.rolePreset,
          cacheThreshold: currentCacheThreshold(),
          ...guardOptions,
        }),
      });
      hydrateFromDone(bundle, data);
    }

    const guard = bundle.done?.guard as GuardReport | undefined;
    await finishGuardSequence(guard);
    if (bundle.done?.blockedByGuard) {
      const caught = guard?.layers.find((l) => l.blocked);
      $('#stage-card').innerHTML =
        `<div class="guard-blocked-answer"><h3>🛡 Prompt injection blocked</h3><p>${esc(String(bundle.done.answer))}</p><p>Semantic cache untouched. No retrieval or Claude generation ran.</p>${guardBreakdownHtml(guard)}<button class="ctrl" id="guard-view-block">Inspect shield waterfall →</button></div>`;
      $('#guard-view-block').onclick = () => ($('#guard-modal') as HTMLDialogElement).showModal();
      $('#viewport-funnel').innerHTML =
        '<div class="vf-caption">🛡 Prompt Guard blocked this request — <strong>Pipeline not run</strong></div>';
      $('#cache-verdict').className = 'cache-verdict';
      $('#cache-verdict').textContent =
        '🛡 Blocked before semantic cache · Entries and hit/miss counters unchanged';
      pipeline?.showGuardBlocked(caught?.name || 'Prompt Guard');
      resetCitationChecks('🛡 Blocked before generation — no answer or citations to verify');
      setStatus('🛡 BLOCKED · ' + (caught?.name || 'Prompt Guard'), 'hold');
      return;
    }
    const cache = bundle.done?.cache as CacheTelemetry | undefined;
    if (cache) renderCacheTelemetry(cache);
    const payload = walkPayloadFromBundle(bundle, query);
    const chat = (bundle.done?.chatStep || null) as never;
    state.baseK = Number(
      (bundle.fusing as { rrfK?: number } | null)?.rrfK || state.health?.rrfK || 30,
    );
    state.explorerK = state.baseK;
    const report =
      ((bundle.done?.retrieval as { permissionReport?: Record<string, unknown> } | undefined)
        ?.permissionReport as Record<string, unknown> | undefined) ||
      ((bundle.retrieval as { permissionReport?: Record<string, unknown> } | null)
        ?.permissionReport as Record<string, unknown> | undefined) ||
      null;
    updateRoleFilterPill(report);
    pipeline?.loadWalkthrough(payload, chat, state.explorerK);
    if (guard?.dataSeparation.enabled && guard.dataSeparation.indirectInjectionDetected)
      pipeline?.showDataContained();
    state.unlocked = 5;
    document.querySelectorAll('.stage-node').forEach((el) => {
      (el as HTMLButtonElement).disabled = Boolean(
        cache?.hit && Number((el as HTMLElement).dataset.stage) < 5,
      );
      el.classList.add('unlocked');
    });
    ($('#btn-replay') as HTMLButtonElement).disabled = false;
    goStage(cache?.hit ? 5 : 1);
    if (!cache?.hit) maybeAutoAdvance();
    const citationCheck = bundle.done?.citationCheck as CitationReport | undefined;
    if (citationCheck)
      void animateCitationReport({ ...citationCheck, answer: String(bundle.done?.answer || '') });
  } catch (err) {
    await finishGuardSequence();
    setStatus(`Error: ${(err as Error).message}`, 'hold');
  } finally {
    state.running = false;
    ($('#btn-run') as HTMLButtonElement).disabled = false;
  }
}

/**
 * Sends the question to the streaming chat route and feeds each event to handleStreamEvent.
 * Returns false if the stream could not start, or ended with no fusion or final result.
 * The caller then asks the chat route for the whole reply.
 * Lines that are not valid JSON are skipped.
 */
async function runViaStream(
  query: string,
  bundle: StreamBundle,
  guardOptions: Record<string, unknown> = {},
): Promise<boolean> {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      message: query,
      history: conversationHistory(),
      roles: state.roles,
      rolePreset: state.rolePreset,
      cacheThreshold: currentCacheThreshold(),
      ...guardOptions,
    }),
  });
  if (!res.ok || !res.body) return false;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';
    for (const line of parts) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const raw = line.slice(5).trim();
        if (!raw) continue;
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          continue;
        }
        handleStreamEvent(eventName, data, bundle, query);
        eventName = 'message';
      }
    }
  }
  return Boolean(bundle.done || bundle.fusing);
}

/**
 * Applies one event from the stream to the bundle and the page.
 * Guard events go to the guard panel. Cache events go to the semantic cache panel.
 * Search events fill the bundle. A status event updates the status line.
 * Throws on an error event, so runPipeline can show it.
 * If the final event carries retrieval data that earlier events did not, the bundle takes it from there.
 */
function handleStreamEvent(
  event: string,
  data: Record<string, unknown>,
  bundle: StreamBundle,
  query: string,
): void {
  onInfrastructureEvent(event, data);
  if (event === 'guard_layer') {
    queueGuardLayer(data as unknown as GuardLayerEvent);
  } else if (event === 'guard') {
    /** The full guard report is drawn later, after every live guard layer has been shown. */
  } else if (event === 'error') {
    throw new Error(String(data.error || 'Streaming request failed'));
  } else if (event === 'cache') {
    renderCacheTelemetry(data as unknown as CacheTelemetry);
  } else if (event === 'status') {
    const stage = String(data.stage || '');
    if (stage === 'retrieving') setStatus(`● Keyword + Vector retrieval with role filter…`, '');
    else if (stage === 'answering') bundle.answeringStarted = true;
  } else if (event === 'fusing') {
    bundle.fusing = data;
    bundle.retrieval = {
      query,
      bm25List: data.bm25List,
      vectorList: data.vectorList,
      rrfShortlist: data.rrfShortlist,
      rrfK: data.rrfK,
      maxBm25Score: data.maxBm25Score,
      maxVectorSimilarity: data.maxVectorSimilarity,
      permissionReport: data.permissionReport,
      callerRoles: data.callerRoles,
    };
  } else if (event === 'reranking') {
    bundle.reranking = data;
  } else if (event === 'done') {
    bundle.done = data;
    if (!bundle.retrieval && data.retrieval) {
      bundle.retrieval = data.retrieval as Record<string, unknown>;
    }
    if (!bundle.fusing && data.retrieval) {
      const r = data.retrieval as Record<string, unknown>;
      bundle.fusing = {
        bm25List: r.bm25List,
        vectorList: r.vectorList,
        rrfShortlist: r.rrfShortlist,
        rrfK: r.rrfK,
        permissionReport: r.permissionReport,
      };
    }
    if (!bundle.reranking && data.retrieval) {
      const r = data.retrieval as Record<string, unknown>;
      bundle.reranking = {
        reranked: r.reranked,
        results: r.results,
        rerankerBackend: r.rerankerBackend,
      };
    }
  }
}

/** Fills the bundle from one complete reply. Used when the stream was not available. */
function hydrateFromDone(bundle: StreamBundle, data: Record<string, unknown>): void {
  bundle.done = data;
  const r = (data.retrieval || {}) as Record<string, unknown>;
  bundle.retrieval = r;
  bundle.fusing = {
    bm25List: r.bm25List,
    vectorList: r.vectorList,
    rrfShortlist: r.rrfShortlist,
    rrfK: r.rrfK,
    maxBm25Score: r.maxBm25Score,
    maxVectorSimilarity: r.maxVectorSimilarity,
    permissionReport: r.permissionReport,
  };
  bundle.reranking = {
    reranked: r.reranked,
    results: r.results,
    rerankerBackend: r.rerankerBackend,
    maxRerankScore: r.maxRerankScore,
    minRerankScore: r.minRerankScore,
  };
}

/**
 * Builds the data the 3D walkthrough needs from the bundle.
 * Missing lists become empty lists. A missing k becomes 30.
 * `relevant` is the retrieval's own flag. If it is missing, `relevant` is false for a fallback reply.
 */
function walkPayloadFromBundle(bundle: StreamBundle, query: string) {
  const r = (bundle.done?.retrieval || bundle.retrieval || {}) as Record<string, unknown>;
  return {
    query,
    cacheHit: Boolean((bundle.done?.cache as CacheTelemetry | undefined)?.hit),
    rrfK: Number(r.rrfK || 30),
    bm25List: (r.bm25List || []) as never,
    vectorList: (r.vectorList || []) as never,
    rrfShortlist: (r.rrfShortlist || []) as never,
    reranked: (r.reranked || (bundle.reranking as { reranked?: unknown })?.reranked || []) as never,
    results: (r.results || []) as never,
    relevant: Boolean(r.relevant ?? !(bundle.done as { fallback?: boolean } | null)?.fallback),
    permissionReport: (r.permissionReport || null) as never,
  };
}

/**
 * Puts the walkthrough back to its empty state before a new question.
 * Hides the answer card, the hint and the hover popover, and disables the step buttons.
 * Without it, the cards of the last question would stay on screen while the new one loads.
 */
function resetWalk(): void {
  dockCitations();
  state.stage = 0;
  state.unlocked = 0;
  state.bundle = {
    retrieval: null,
    fusing: null,
    reranking: null,
    done: null,
    answeringStarted: false,
  };
  $('#answer-card').hidden = true;
  $('#stage-card').innerHTML =
    '<div class="stage-card-empty">Buffering pipeline… Step 1 will hold until you advance.</div>';
  $('#canvas-hud').hidden = true;
  $('#next-hint').hidden = true;
  hidePopover();
  document.querySelectorAll('.stage-node').forEach((el) => {
    const b = el as HTMLButtonElement;
    b.disabled = true;
    b.classList.remove('active', 'unlocked');
  });
  ($('#btn-prev') as HTMLButtonElement).disabled = true;
  ($('#btn-next') as HTMLButtonElement).disabled = true;
  ($('#btn-replay') as HTMLButtonElement).disabled = true;
}

/**
 * Opens one step: moves the 3D canvas, redraws the step card and updates the buttons.
 * Does nothing for a step the user has not reached, or outside 1 to 5.
 * If the semantic cache answered: only step 5 opens, because steps 1 to 4 never ran.
 * On steps 1 to 4, adds a banner if layer 4 of the prompt guard contained a planted instruction.
 */
function goStage(stage: number): void {
  if ((state.bundle.done?.cache as CacheTelemetry | undefined)?.hit && stage !== 5) return;
  if (stage < 1 || stage > 5 || stage > state.unlocked) return;
  state.stage = stage;
  pipeline?.setStage(stage);
  syncStageUi(stage);
  renderStageCard(stage);
  const guard = state.bundle.done?.guard as GuardReport | undefined;
  if (
    stage !== 5 &&
    guard?.dataSeparation.enabled &&
    guard.dataSeparation.indirectInjectionDetected
  )
    $('#stage-card').insertAdjacentHTML(
      'afterbegin',
      '<div class="cache-answer-banner risk">🛡 LAYER 4 · CONTAINED INJECTION — Planted instructions stayed in the data envelope. Claude uses the real support policy.</div>',
    );
  renderViewportFunnel(stage);
  updateHoldChrome(stage);
}

/**
 * Draws the funnel strip under the 3D canvas.
 * Before a question: the number of indexed sections.
 * After a question: the count at each of the five steps. Each is a button that opens that step.
 * If the semantic cache answered: a note that retrieval and the LLM were skipped.
 * If the page has no funnel element, nothing is drawn.
 * The number 39 is shown if our server has not reported a chunk count.
 */
function renderViewportFunnel(stage: number): void {
  const el = document.getElementById('viewport-funnel');
  if (!el) return;
  const r = (state.bundle.done?.retrieval || state.bundle.retrieval || null) as Record<
    string,
    unknown
  > | null;
  if ((state.bundle.done?.cache as CacheTelemetry | undefined)?.hit) {
    el.innerHTML =
      '<div class="vf-caption">⚡ <strong>Semantic Cache Shortcut</strong> — Retrieval &amp; LLM Bypassed</div>';
    return;
  }
  if (!r) {
    const total = state.health?.chunkCount ?? 39;
    el.innerHTML = `<div class="vf-caption">End-to-End Retrieval Funnel · <strong>${total}</strong> indexed support sections ready</div>`;
    return;
  }
  const perm = (r.permissionReport || {}) as {
    totalChunkCount?: number;
    accessibleChunkCount?: number;
    excludedChunks?: unknown[];
  };
  const total = perm.totalChunkCount ?? state.health?.chunkCount ?? 39;
  const allowed = perm.accessibleChunkCount ?? total;
  const bmCount = ((r.bm25List || []) as unknown[]).length;
  const rrfCount = ((r.rrfShortlist || []) as unknown[]).length;
  const keptCount = ((r.results || []) as unknown[]).length;
  const steps = [
    { s: 1, num: `${bmCount} hits`, label: 'Keyword (BM25)', cls: 'amber' },
    { s: 2, num: `${allowed}/${total}`, label: 'Role + Vector', cls: 'cyan' },
    { s: 3, num: `Top ${rrfCount}`, label: 'Fused (RRF)', cls: 'indigo' },
    { s: 4, num: `Top ${keptCount}`, label: 'Re-Ranked', cls: 'emerald' },
    { s: 5, num: keptCount ? '1 Answer' : 'Guarded', label: 'Claude Output', cls: 'emerald' },
  ];
  el.innerHTML = steps
    .map(
      (st, idx) =>
        `<button type="button" class="vf-step ${st.cls} ${stage === st.s ? 'active' : stage > st.s ? 'past' : ''}" data-vf-stage="${st.s}">
          <span class="vf-num">${esc(st.num)}</span>
          <span class="vf-lbl">${st.s}. ${esc(st.label)}</span>
        </button>` + (idx < steps.length - 1 ? `<span class="vf-arrow">→</span>` : ''),
    )
    .join('');
  el.querySelectorAll<HTMLElement>('[data-vf-stage]').forEach((btn) => {
    btn.addEventListener('click', () => goStage(Number(btn.dataset.vfStage)));
  });
}

/**
 * Turns a plain answer into safe HTML.
 * Escapes the text first, so markup in an answer cannot run.
 * Then **bold**, `code` and line breaks are converted.
 */
function formatInlineMd(raw: string): string {
  return esc(raw)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code class="ans-code">$1</code>')
    .replace(/\n/g, '<br />');
}

/**
 * Marks the current step node and sets Previous and Next.
 * Previous is off on step 1 and when the semantic cache answered. Next is off on step 5.
 */
function syncStageUi(stage: number): void {
  document.querySelectorAll('.stage-node').forEach((el) => {
    el.classList.toggle('active', Number((el as HTMLElement).dataset.stage) === stage);
  });
  ($('#btn-prev') as HTMLButtonElement).disabled =
    stage <= 1 || Boolean((state.bundle.done?.cache as CacheTelemetry | undefined)?.hit);
  ($('#btn-next') as HTMLButtonElement).disabled = stage >= 5;
}

/**
 * Updates the hint, the canvas banner, the Next button and the status line for a step.
 * On steps 1 to 4: says the walkthrough is paused and how to continue.
 * On step 5: hides the hint, and says either cache hit or complete.
 */
function updateHoldChrome(stage: number): void {
  const next = NEXT_NAMES[stage - 1];
  const hint = $('#next-hint');
  const hud = $('#canvas-hud');
  const nextBtn = $('#btn-next') as HTMLButtonElement;

  if (stage < 5) {
    nextBtn.textContent = `Next Step: ${next} →`;
    nextBtn.disabled = false;
    hint.hidden = false;
    hint.textContent = `Paused on Step ${stage}/5 — Click Next or press Space / →`;
    hud.hidden = false;
    hud.textContent = `Paused on Step ${stage}/5 (${STAGE_NAMES[stage - 1]}) — Click Next or press Space / →`;
    setStatus(`● HOLD · Step ${stage}/5 — ${STAGE_NAMES[stage - 1]}`, 'hold');
  } else {
    nextBtn.textContent = 'Next Step →';
    nextBtn.disabled = true;
    hint.hidden = true;
    hud.hidden = true;
    setStatus(
      (state.bundle.done?.cache as CacheTelemetry | undefined)?.hit
        ? '⚡ CACHE HIT · Answer served instantly · Stages 1–4 bypassed'
        : '✓ COMPLETE',
      'done',
    );
  }
}

/**
 * Moves from step 1 to step 5 on its own, one step every 1.1 seconds.
 * Only if the auto-advance box is ticked. Unticking it during the walk stops it.
 */
function maybeAutoAdvance(): void {
  const auto = ($('#auto-advance') as HTMLInputElement).checked;
  if (!auto) return;
  let s = 1;
  /** Moves one step forward, then schedules the next move. Stops at step 5. */
  const tick = () => {
    if (!($('#auto-advance') as HTMLInputElement).checked) return;
    if (s >= 5) return;
    s += 1;
    goStage(s);
    if (s < 5) setTimeout(tick, 1100);
  };
  setTimeout(tick, 1100);
}

/** Backup labels for ranked rows. Used if a step has no custom label for that row. */
const ORDINAL = ['Highest', 'Second', 'Third', 'Fourth', 'Fifth'];

/** Hides the hover popover and clears its contents. */
function hidePopover(): void {
  const pop = $('#hover-popover');
  pop.hidden = true;
  pop.innerHTML = '';
}

/**
 * Shows the hover popover just below an element.
 * If it would run off the right edge, it moves left. If it would run off the bottom, it moves above the element.
 */
function showPopover(anchor: HTMLElement, html: string): void {
  const pop = $('#hover-popover');
  pop.innerHTML = html;
  pop.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const pad = 12;
  let left = rect.left;
  let top = rect.bottom + 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  const pr = pop.getBoundingClientRect();
  if (pr.right > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - pr.width - pad);
  if (pr.bottom > window.innerHeight - pad) top = Math.max(pad, rect.top - pr.height - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

/** Shows the popover when the user hovers or focuses a row, and hides it on leave or blur. */
function wireRankHover(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-popover]').forEach((row) => {
    const show = () => showPopover(row, row.dataset.popover || '');
    row.addEventListener('mouseenter', show);
    row.addEventListener('focus', show);
    row.addEventListener('mouseleave', hidePopover);
    row.addEventListener('blur', hidePopover);
  });
}

/**
 * Builds the popover HTML: title, score line, allowed roles and a short excerpt.
 * Text is escaped. The excerpt is cut to 280 characters.
 */
function popoverHtml(opts: {
  title: string;
  scoreLine: string;
  excerpt?: string;
  roles?: string[];
}): string {
  return `<h4>${esc(opts.title)}</h4>
    <div class="mono">${esc(opts.scoreLine)}</div>
    ${opts.roles?.length ? `<div class="roles">Allowed roles: ${esc(opts.roles.join(', '))}</div>` : ''}
    ${opts.excerpt ? `<div class="excerpt">${esc(opts.excerpt.slice(0, 280))}</div>` : ''}`;
}

/**
 * Draws the card for one step.
 * Steps 1 to 4 each have their own function. The k slider is wired only on step 3.
 * Step 5 shows the answer, its sources and the citation check.
 * If the semantic cache answered, step 5 also shows a banner with the match and the threshold.
 * If the answer is a no-answer reply, step 5 also lists chunks the role filter hid.
 */
function renderStageCard(stage: number): void {
  dockCitations();
  const card = $('#stage-card');
  const r = (state.bundle.done?.retrieval || state.bundle.retrieval || {}) as Record<
    string,
    unknown
  >;
  const chat = (state.bundle.done?.chatStep || {}) as Record<string, unknown>;
  hidePopover();

  if (stage === 1) {
    card.innerHTML = renderBm25Step(r);
    wireRankHover(card);
    return;
  }
  if (stage === 2) {
    card.innerHTML = renderVectorStep(r);
    wireRankHover(card);
    return;
  }
  if (stage === 3) {
    card.innerHTML = renderRrfStep(r);
    wireRankHover(card);
    wireKExplorer();
    return;
  }
  if (stage === 4) {
    card.innerHTML = renderCeStep(r);
    wireRankHover(card);
    return;
  }

  /** Step 5 shows only the answer and the sources it came from. */
  const done = state.bundle.done || {};
  const answer = String(done.answer || chat.answer || '').trim();
  const fallback = Boolean(done.fallback || chat.usedFallback);
  const ctx = (done.sources || chat.contextPassedToLlm || []) as Array<{
    sourceFile?: string;
    headingPath: string;
    prefixedText?: string;
    roles?: string[];
  }>;
  $('#answer-card').hidden = true;

  const excluded = ((r.permissionReport as { excludedChunks?: ExcludedChunk[] } | undefined)
    ?.excludedChunks || []) as ExcludedChunk[];

  const paragraphs = answer
    .split(/\n{2,}/)
    .map((block) => `<p class="final-answer-para">${formatInlineMd(block)}</p>`)
    .join('');

  const sourcesHtml = ctx.length
    ? `<div class="answer-sources">
        <div class="answer-sources-label">Sources</div>
        <div class="answer-source-pills">
          ${ctx
            .map((c) => {
              const excerptClean = String(c.prefixedText || '').replace(/^Topic:.*\n\n/, '');
              const pop = popoverHtml({
                title: `${c.sourceFile ? c.sourceFile + ' · ' : ''}${c.headingPath}`,
                scoreLine: 'Retrieved source passage',
                excerpt: excerptClean,
                roles: c.roles,
              });
              return `<div class="source-pill" tabindex="0" data-popover="${escAttr(pop)}">
                <span class="source-doc">${esc(String(c.sourceFile || 'docs'))}</span>
                <span class="source-sep">›</span>
                <span class="source-sec">${esc(short(String(c.headingPath)))}</span>
              </div>`;
            })
            .join('')}
        </div>
      </div>`
    : '';

  const blockedSourcesHtml =
    fallback && excluded.length
      ? `<div class="answer-sources">
          <div class="answer-sources-label">Blocked by Role Filter</div>
          <div class="answer-source-pills">
            ${excluded
              .slice(0, 3)
              .map(
                (ex) => `<div class="source-pill blocked">
                  <span>🔒 ${esc(short(ex.headingPath))}</span>
                  <span class="badge-chip lock">Requires: ${esc(ex.chunkRoles.join(', '))}</span>
                </div>`,
              )
              .join('')}
          </div>
        </div>`
      : '';

  const cache = done.cache as CacheTelemetry | undefined;
  const cacheBanner = cache?.hit
    ? `<div class="cache-answer-banner ${cache.degradedRisk ? 'risk' : ''}">⚡ Served from Semantic Cache · ANN Cosine ${cache.similarity?.toFixed(3)} ≥ Threshold ${cache.threshold.toFixed(2)}
    <p>${cache.degradedRisk ? '⚠ Quality Degradation Notice: a different question’s answer may have been served!' : 'Grounded answer reused — document retrieval and Claude were not invoked.'}</p>
    <small>Matched cached query: “${esc(cache.matchedQuery || '')}”</small></div>`
    : '';
  const guard = done.guard as GuardReport | undefined;
  const dataNotice = guard?.dataSeparation.indirectInjectionDetected
    ? `<div class="cache-answer-banner risk">🛡 Indirect injection detected in data · ${guard.dataSeparation.enabled ? 'Fenced and ignored' : 'WARNING: Data separation is OFF'}<p>Inspect the Security Inspector to see the planted instruction inside the data envelope.</p></div>`
    : '';
  card.innerHTML = `${dataNotice}${cacheBanner}<div class="clean-answer-box ${fallback ? 'is-fallback' : ''}">
      <div class="answer-kicker">${fallback ? 'Access / Coverage Notice' : 'Answer'}</div>
      <div class="final-answer-body">${paragraphs}</div>
      ${sourcesHtml}
      <div id="citation-step5-slot"></div>
      ${blockedSourcesHtml}
    </div>`;
  dockCitations($('#citation-step5-slot'));
  wireRankHover(card);
}

/**
 * Builds the step 1 card: the top five BM25 matches as bars.
 * Bars are sized against the best score, with a 4 percent minimum so every bar shows.
 */
function renderBm25Step(r: Record<string, unknown>): string {
  const bm25 = (r.bm25List || []) as Array<{
    bm25Rank: number;
    headingPath: string;
    bm25Score: number;
    roles?: string[];
    prefixedText?: string;
    sourceFile?: string;
  }>;
  const maxB = Math.max(...bm25.map((x) => x.bm25Score), 0.0001);
  const labels = [
    'Highest keyword match',
    'Second keyword match',
    'Third keyword match',
    'Fourth keyword match',
    'Fifth keyword match',
  ];
  const rows = bm25.slice(0, 5).map((x, i) => {
    const pct = Math.max(4, (100 * x.bm25Score) / maxB);
    const pop = popoverHtml({
      title: x.headingPath,
      scoreLine: `Best Matching 25 (BM25) score ${x.bm25Score.toFixed(2)} · rarer exact words score higher`,
      excerpt: x.prefixedText || `From ${x.sourceFile || 'docs'}`,
      roles: x.roles,
    });
    return `<div class="rank-row" tabindex="0" data-popover="${escAttr(pop)}">
      <div class="rank-main">
        <div class="rank-label">#${i + 1} ${labels[i] || ORDINAL[i] || 'Match'}</div>
        <div class="rank-bar amber"><span style="width:${pct}%"></span></div>
        <div class="rank-sub">${esc(short(x.headingPath))}</div>
      </div>
      <div class="rank-score">${x.bm25Score.toFixed(2)}</div>
    </div>`;
  });
  return `<h3>1 · ${STAGE_NAMES[0]}</h3>
    <p class="stage-plain">${STAGE_PLAIN[0]}</p>
    <div class="rank-list">${rows.join('') || '<div class="stage-card-empty">No keyword matches for this role.</div>'}</div>
    <details class="math-toggle">
      <summary>Scoring formula ▾</summary>
      <div class="math-toggle-body">
        Best Matching 25 (BM25) blends Term Frequency (TF) (how often a word appears), Inverse Document Frequency (IDF) (how rare it is), and a length fairness term so long chunks don't win just by being long.
        <div class="formula-spot">score ≈ Σ Inverse Document Frequency (IDF)(term) × saturated Term Frequency (TF)</div>
        <button type="button" class="doc-pill" id="btn-bm25-math-inline">Open keyword scoring reference</button>
      </div>
    </details>`;
}

/**
 * Builds the step 2 card: the top five vector matches as bars, then the chunks the role filter hid.
 * The popover shows the angle from the question vector, worked out from the cosine similarity.
 */
function renderVectorStep(r: Record<string, unknown>): string {
  const vec = (r.vectorList || []) as Array<{
    vectorRank: number;
    headingPath: string;
    vectorSimilarity: number;
    roles?: string[];
    sourceFile?: string;
  }>;
  const maxV = Math.max(...vec.map((x) => x.vectorSimilarity), 0.0001);
  const labels = [
    'Closest vector match',
    'Second closest vector',
    'Third closest vector',
    'Fourth closest vector',
    'Fifth closest vector',
  ];
  const rows = vec.slice(0, 5).map((x, i) => {
    const pct = Math.max(4, (100 * x.vectorSimilarity) / maxV);
    const angle = Math.acos(Math.min(1, Math.max(-1, x.vectorSimilarity))) * (180 / Math.PI);
    const pop = popoverHtml({
      title: x.headingPath,
      scoreLine: `Cosine similarity ${x.vectorSimilarity.toFixed(3)} · angle ≈ ${angle.toFixed(0)}° from Query Vector`,
      excerpt: `From ${x.sourceFile || 'docs'}`,
      roles: x.roles,
    });
    return `<div class="rank-row" tabindex="0" data-popover="${escAttr(pop)}">
      <div class="rank-main">
        <div class="rank-label">#${i + 1} ${labels[i]}</div>
        <div class="rank-bar cyan"><span style="width:${pct}%"></span></div>
        <div class="rank-sub">${esc(short(x.headingPath))}</div>
      </div>
      <div class="rank-score">${x.vectorSimilarity.toFixed(2)}</div>
    </div>`;
  });

  const report = (r.permissionReport || {}) as {
    excludedChunks?: ExcludedChunk[];
    accessibleChunkCount?: number;
    totalChunkCount?: number;
  };
  const excluded = report.excludedChunks || [];
  const lockRows = excluded.slice(0, 4).map((ex) => {
    const pop = popoverHtml({
      title: ex.headingPath,
      scoreLine: `Would have scored cosine ${ex.cosineSim.toFixed(3)} / Best Matching 25 (BM25) ${ex.bm25Score.toFixed(2)} — blocked by Role-Based Access Control (RBAC)`,
      roles: ex.chunkRoles,
      excerpt: `Requires: ${ex.chunkRoles.join(', ')}`,
    });
    return `<div class="rank-row blocked" tabindex="0" data-popover="${escAttr(pop)}">
      <div class="rank-main">
        <div class="rank-label">🔒 Blocked by role filter</div>
        <div class="rank-sub">${esc(short(ex.headingPath))}</div>
      </div>
      <span class="badge-chip lock">Requires: ${esc(ex.chunkRoles.join(', '))}</span>
    </div>`;
  });

  return `<h3>2 · ${STAGE_NAMES[1]}</h3>
    <p class="stage-plain">${STAGE_PLAIN[1]}</p>
    <div class="rank-list">${rows.join('') || '<div class="stage-card-empty">No vector matches for this role.</div>'}${lockRows.join('')}</div>
    ${permissionNote(excluded)}
    <details class="math-toggle">
      <summary>Scoring formula ▾</summary>
      <div class="math-toggle-body">
        Pinecone applies <code>{ "roles": { "$in": callerRoles } }</code> first, then ranks remaining chunks by Cosine Similarity = Dot Product ÷ (Query Vector Magnitude × Chunk Vector Magnitude).
        <div class="formula-spot">Closer angle → higher similarity (1.00 = identical, 0.00 = unrelated)</div>
      </div>
    </details>`;
}

/**
 * Builds the step 3 card: the top five by reciprocal rank fusion.
 * The page works out each score again with the k from the slider, and sorts again.
 * So the order here can differ from our server's order while the user moves the slider.
 */
function renderRrfStep(r: Record<string, unknown>): string {
  const k = state.explorerK;
  const shortlist = (r.rrfShortlist || []) as Array<{
    headingPath: string;
    rrfRank: number;
    bm25Rank: number | null;
    vectorRank: number | null;
    rrfScore: number;
    roles?: string[];
    prefixedText?: string;
  }>;
  const recomputed = shortlist
    .map((item) => {
      const bm = item.bm25Rank ? 1 / (item.bm25Rank + k) : 0;
      const vc = item.vectorRank ? 1 / (item.vectorRank + k) : 0;
      return { ...item, bm, vc, sum: bm + vc };
    })
    .sort((a, b) => b.sum - a.sum);
  const max = Math.max(...recomputed.map((x) => x.sum), 0.0001);
  const tags = [
    'Top combined match · matched both searches',
    'Combined rank runner-up',
    'Combined rank #3',
    'Combined rank #4',
    'Combined rank #5',
  ];
  const rows = recomputed.slice(0, 5).map((x, i) => {
    const bmPct = (x.bm / max) * 100;
    const vcPct = (x.vc / max) * 100;
    const both = x.bm25Rank && x.vectorRank;
    const pop = popoverHtml({
      title: x.headingPath,
      scoreLine: `1/(${k} + ${x.bm25Rank ?? '—'}) + 1/(${k} + ${x.vectorRank ?? '—'}) = ${x.sum.toFixed(4)}`,
      excerpt: x.prefixedText,
      roles: x.roles,
    });
    return `<div class="rank-row" tabindex="0" data-popover="${escAttr(pop)}">
      <div class="rank-main">
        <div class="rank-label">#${i + 1} ${both ? (tags[Math.min(i, 0)] && i === 0 ? tags[0] : tags[i] || 'Combined match') : tags[i] || 'Combined match'}</div>
        <div class="rank-bar stacked"><div class="bm" style="width:${bmPct}%"></div><div class="vec" style="width:${vcPct}%"></div></div>
        <div class="rank-sub">${esc(short(x.headingPath))} · amber=keyword · cyan=vector</div>
      </div>
      <div class="rank-score">${x.sum.toFixed(4)}</div>
    </div>`;
  });

  /**
   * Fixed example scores for the two side-by-side cards: no smoothing against k of 30.
   * They do not follow the slider.
   */
  const harsh1 = 1 / 1;
  const harsh2 = 1 / 2;
  const soft1 = 1 / (30 + 1);
  const soft2 = 1 / (30 + 2);

  return `<h3>3 · ${STAGE_NAMES[2]}</h3>
    <p class="stage-plain">${STAGE_PLAIN[2]}</p>
    <div class="smooth-compare">
      <div class="smooth-card harsh">
        <h4>Rank smoothing disabled</h4>
        <div class="pair"><span>Rank #1</span><strong>${harsh1.toFixed(2)}</strong></div>
        <div class="pair"><span>Rank #2</span><strong>${harsh2.toFixed(2)}</strong></div>
        <div class="rank-sub">50% cliff — #1 dominates unfairly</div>
      </div>
      <div class="smooth-card gentle">
        <h4>Rank smoothing enabled (+30)</h4>
        <div class="pair"><span>Rank #1</span><strong>${soft1.toFixed(3)}</strong></div>
        <div class="pair"><span>Rank #2</span><strong>${soft2.toFixed(3)}</strong></div>
        <div class="rank-sub">~3% step — ranks stay useful together</div>
      </div>
    </div>
    ${kExplorerHtml(k)}
    <div class="rank-list" style="margin-top:10px">${rows.join('')}</div>
    <details class="math-toggle">
      <summary>Scoring formula ▾</summary>
      <div class="math-toggle-body">
        Reciprocal Rank Fusion (RRF) score = keyword contribution + vector contribution.
        <div class="formula-spot">1 / (${k} + keywordRank) + 1 / (${k} + vectorRank)</div>
      </div>
    </details>`;
}

/**
 * Builds the step 4 card: the cross-encoder reranker's scores for up to eight chunks.
 * Shows how far each chunk moved from its fusion rank, and which ones go to the LLM.
 * Bars run from the lowest score, or from 0 if every score is above 0, up to the highest.
 */
function renderCeStep(r: Record<string, unknown>): string {
  const reranked = (r.reranked || []) as Array<{
    headingPath: string;
    rrfRank: number;
    rerankRank: number;
    rankDelta: number;
    rerankScore: number;
    keptForLlm: boolean;
    roles?: string[];
    prefixedText?: string;
  }>;
  const max = Math.max(...reranked.map((x) => x.rerankScore), 0.0001);
  const min = Math.min(...reranked.map((x) => x.rerankScore), 0);
  const span = Math.max(max - min, 0.0001);
  const labels = [
    'Top re-ranked chunk (sent to answer)',
    'Second re-ranked chunk',
    'Third re-ranked chunk',
    'Fourth re-ranked chunk',
    'Fifth re-ranked chunk',
  ];
  const rows = reranked.slice(0, 8).map((x, i) => {
    const pct = Math.max(4, ((x.rerankScore - min) / span) * 100);
    const d = x.rankDelta;
    const shift = d > 0 ? `Moved up +${d}` : d < 0 ? `Moved down ${d}` : `Held #${x.rerankRank}`;
    const pop = popoverHtml({
      title: x.headingPath,
      scoreLine: `Cross-Encoder (CE) score ${x.rerankScore.toFixed(3)} · ${shift} (was Reciprocal Rank Fusion (RRF) #${x.rrfRank})`,
      excerpt: x.prefixedText,
      roles: x.roles,
    });
    return `<div class="rank-row" tabindex="0" data-popover="${escAttr(pop)}">
      <div class="rank-main">
        <div class="rank-label">#${x.rerankRank} ${labels[i] || 'Re-ranked chunk'}</div>
        <div class="rank-bar ce"><span style="width:${pct}%"></span></div>
        <div class="rank-sub">${esc(short(x.headingPath))} · <span class="${d > 0 ? 'badge-chip up' : d < 0 ? 'badge-chip down' : 'badge-chip'}">${esc(shift)}</span></div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
        <div class="rank-score">${x.rerankScore.toFixed(2)}</div>
        <span class="badge-chip ${x.keptForLlm ? 'kept' : 'dropped'}">${x.keptForLlm ? 'Selected for Answer' : 'Dropped'}</span>
      </div>
    </div>`;
  });
  return `<h3>4 · ${STAGE_NAMES[3]}</h3>
    <p class="stage-plain">${STAGE_PLAIN[3]}</p>
    <div class="rank-list">${rows.join('')}</div>
    <details class="math-toggle">
      <summary>Scoring formula ▾</summary>
      <div class="math-toggle-body">
        The Cross-Encoder (CE) reads the full question and each chunk together (not as separate vectors) and outputs a relevance logit. Top ${state.health?.finalTopK ?? 3} are kept for the Large Language Model (LLM).
      </div>
    </details>`;
}

/** Builds the line that says how many matching chunks the RBAC role filter hid. */
function permissionNote(excluded: ExcludedChunk[]): string {
  if (!excluded.length) {
    return `<div class="perm-note">✓ 0 matching chunks blocked by role filter</div>`;
  }
  return `<div class="perm-note warn">🔒 Excluded by Pinecone Permission Filter — ${excluded.length} matching chunk${excluded.length === 1 ? '' : 's'} hidden for this role</div>`;
}

/** Builds the k slider, from 0 to 60, and its reset button. */
function kExplorerHtml(k: number): string {
  return `<div class="k-explorer">
    <label><span>Interactive k explorer</span><span class="k-amber">k = ${k}</span></label>
    <input type="range" id="k-slider" min="0" max="60" value="${k}" />
    <div style="margin-top:6px;display:flex;gap:8px;align-items:center">
      <button type="button" class="ctrl" id="k-reset">Reset k=${state.baseK}</button>
      <span style="font-size:11px;color:var(--muted)">Compare pure 1/rank (k=0) vs smoothed 1/(rank+k)</span>
    </div>
  </div>`;
}

/**
 * Makes the k slider and reset button redraw the step card and update the 3D canvas.
 * Also makes the BM25 reference link open the BM25 lab.
 */
function wireKExplorer(): void {
  const slider = document.getElementById('k-slider') as HTMLInputElement | null;
  const reset = document.getElementById('k-reset');
  if (slider) {
    slider.oninput = () => {
      state.explorerK = Number(slider.value);
      pipeline?.setExplorerK(state.explorerK);
      renderStageCard(state.stage);
    };
  }
  if (reset) {
    reset.addEventListener('click', () => {
      state.explorerK = state.baseK;
      pipeline?.setExplorerK(state.explorerK);
      renderStageCard(state.stage);
    });
  }
  document.getElementById('btn-bm25-math-inline')?.addEventListener('click', openBm25Modal);
}

/** Writes the status pill. The mode picks its colour: hold, done, or the default. */
function setStatus(text: string, mode: '' | 'hold' | 'done'): void {
  const el = $('#status-pill');
  el.textContent = text;
  el.className = 'status-pill' + (mode ? ` ${mode}` : '');
}

/** Shortens a heading path to its last two headings. */
function short(path: string): string {
  return path.split(' > ').slice(-2).join(' › ');
}

/** Escapes text for use inside HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Escapes text for use inside a double-quoted HTML attribute.
 * Used for the popover HTML stored in data-popover.
 */
function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Names the answer backend for the header badge. Anything unknown reads as the offline demo model.
 */
function llmLabel(p?: string | null): string {
  if (p === 'local-claude') return 'Local Claude Command-Line Interface (CLI)';
  if (p === 'anthropic-api') return 'Anthropic Application Programming Interface (API)';
  return 'Offline Demo Large Language Model (LLM)';
}

/** Writes the header badge: whether embeddings are mock or live, and which LLM answers. */
function updateHeader(health: Health): void {
  const badge = $('#badge-mode');
  const emb = health.mockEmbeddings ?? health.mock;
  badge.textContent = `${emb ? 'Emb mock' : 'Live emb'} · ${llmLabel(health.llmProvider)}`;
  badge.className = 'badge ' + (emb ? 'mock' : 'live');
}

/**
 * Fetches JSON from our server.
 * Throws if the status is an error. The message is the server's error text, or the status text.
 */
async function fetchJson<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/** Makes the local Claude button start or end the login. */
function wireClaudeLogin(): void {
  $('#btn-claude-login').addEventListener('click', () => void onClaudeClick());
}

/** Asks our server for the local Claude status and redraws the button. */
async function refreshClaudeStatus(): Promise<void> {
  try {
    state.claude = await fetchJson<ClaudeStatus>('/api/claude/status');
    renderClaudeBtn(state.claude);
  } catch {
    /** If our server cannot be reached, the button keeps its last look. */
  }
}

/**
 * Sets the local Claude button and the banner under it from the status.
 * If the tool is not installed: the button is off and the banner says how to install it.
 * If a login is in progress: shows the login link and starts polling.
 * If Claude is connected: says so, and stops polling.
 * Otherwise: offers to log in or to activate.
 */
function renderClaudeBtn(s: ClaudeStatus): void {
  const btn = $('#btn-claude-login') as HTMLButtonElement;
  const banner = $('#mode-banner');
  btn.classList.remove('waiting', 'connected', 'missing');
  btn.disabled = false;
  if (!s.installed) {
    btn.textContent = 'Local Claude CLI Not Found';
    btn.classList.add('missing');
    btn.disabled = true;
    banner.hidden = true;
    banner.className = 'banner';
    banner.innerHTML =
      'Install with <code>npm i -g @anthropic-ai/claude-code</code> or set <code>CLAUDE_CLI_PATH</code>.';
    return;
  }
  if (s.loginInProgress) {
    btn.textContent = '⏳ Waiting for Claude Login…';
    btn.classList.add('waiting');
    banner.hidden = false;
    banner.className = 'banner';
    banner.innerHTML =
      'Complete browser OAuth…' +
      (s.loginUrl
        ? ` <a href="${esc(s.loginUrl)}" target="_blank" rel="noopener">Open login link</a>`
        : '');
    startClaudePoll();
    return;
  }
  if (s.active && s.loggedIn) {
    btn.textContent = '● Local Claude Connected';
    btn.classList.add('connected');
    banner.hidden = false;
    banner.className = 'banner live';
    banner.textContent = `Step 5 uses Local Claude Command-Line Interface (CLI)${s.account ? ' · ' + s.account : ''}. Click to disconnect.`;
    stopClaudePoll();
    return;
  }
  btn.textContent = s.loggedIn ? '⚡ Activate Local Claude' : '⚡ Login with Local Claude';
  banner.hidden = true;
}

/**
 * Checks the Claude status and the health report every 1.5 seconds.
 * Does nothing if polling has already started. Without it, the button would stay on waiting after login finished.
 */
function startClaudePoll(): void {
  if (state.claudePoll) return;
  state.claudePoll = setInterval(
    () =>
      void refreshClaudeStatus().then(async () => {
        state.health = await fetchJson<Health>('/health');
        updateHeader(state.health);
      }),
    1500,
  );
}

/** Stops the Claude status polling. */
function stopClaudePoll(): void {
  if (state.claudePoll) {
    clearInterval(state.claudePoll);
    state.claudePoll = null;
  }
}

/**
 * Handles a click on the local Claude button.
 * If Claude is active: disconnects it. Otherwise: starts the login.
 * Then reloads the health report and the button.
 */
async function onClaudeClick(): Promise<void> {
  const s = state.claude || (await fetchJson<ClaudeStatus>('/api/claude/status'));
  if (!s.installed) return;
  if (s.active) {
    await fetchJson('/api/claude/disconnect', { method: 'POST' });
    stopClaudePoll();
  } else {
    const result = await fetchJson<{ status: ClaudeStatus }>('/api/claude/login', {
      method: 'POST',
    });
    state.claude = result.status;
    if (result.status.loginInProgress) startClaudePoll();
  }
  state.health = await fetchJson<Health>('/health');
  updateHeader(state.health);
  await refreshClaudeStatus();
}

/**
 * Listens to our server's hot reload stream while developing.
 * On a reload event: reloads the page.
 * On a css event: reloads only the matching stylesheet, by adding a new time to its address.
 */
function wireHotReload(): void {
  try {
    const es = new EventSource('/api/hot-reload');
    es.addEventListener('reload', () => location.reload());
    es.addEventListener('css', (ev) => {
      const file = String((ev as MessageEvent).data || 'styles.css');
      document.querySelectorAll('link[rel=stylesheet]').forEach((link) => {
        const el = link as HTMLLinkElement;
        if (!el.href.includes(file.replace(/"/g, ''))) return;
        const u = new URL(el.href);
        u.searchParams.set('t', String(Date.now()));
        el.href = u.toString();
      });
    });
  } catch {
    /** If the browser cannot open the event stream, the page works without live reload. */
  }
}

/** The cosine similarity lab. Created the first time the user opens it. */
let cosineLab: Cosine3D | null = null;

/** Makes the two lab buttons open the BM25 lab and the cosine similarity lab. */
function wireMathLabs(): void {
  document.getElementById('btn-bm25-math')?.addEventListener('click', openBm25Modal);
  document.getElementById('btn-cosine-lab')?.addEventListener('click', openCosineLab);
}

/**
 * Opens the BM25 lab: three sliders that show how BM25 scores one word.
 * The sliders are term frequency, how many documents contain the word, and chunk length.
 * It uses a fixed demo of 45 documents with an average length of 50.
 * The constants k1 of 1.5 and b of 0.75 match the BM25 defaults in src/bm25.ts.
 */
function openBm25Modal(): void {
  const body = $('#bm25-modal-body');
  body.innerHTML = `
    <div class="pill-row"><span class="badge live">Best Matching 25 (BM25)</span>
      <span class="badge">Okapi · k₁=1.5 · b=0.75</span></div>
    <p style="font-size:13px;color:var(--muted);line-height:1.45">Best Matching 25 (BM25) scores a chunk by how well its exact words match your question — boosting rare words and gently saturating repeats.</p>
    <div class="bm25-bars">
      <div class="bm25-bar-card">
        <h4>1. Term Frequency (TF) saturation</h4>
        <p>Repeating a word 20× does not score 20× — the bar flattens toward a ceiling.</p>
        <label>Term Frequency (TF) <span id="bm-tf-v" class="k-amber">2</span>
          <input id="bm-tf" type="range" min="0" max="10" value="2" /></label>
        <div class="rank-bar amber"><span id="bm-tf-bar" style="width:40%"></span></div>
        <div class="big-num" id="bm-tf-score">1.51</div>
      </div>
      <div class="bm25-bar-card">
        <h4>2. Inverse Document Frequency (IDF) word rarity</h4>
        <p>Common words like “the” barely count; rare codes like err_payment_402 dominate.</p>
        <label>Documents containing word (df) <span id="bm-df-v" class="k-amber">1</span>
          <input id="bm-df" type="range" min="1" max="45" value="1" /></label>
        <div class="rank-bar cyan"><span id="bm-idf-bar" style="width:90%"></span></div>
        <div class="big-num" id="bm-idf-score">3.42</div>
      </div>
      <div class="bm25-bar-card">
        <h4>3. Document length fairness</h4>
        <p>Long rambling chunks are gently penalized so short precise sections can still win.</p>
        <label>Chunk length |d| <span id="bm-dl-v" class="k-amber">42</span> (avg 50)
          <input id="bm-dl" type="range" min="10" max="200" value="42" /></label>
        <div class="rank-bar ce"><span id="bm-len-bar" style="width:70%"></span></div>
        <div class="big-num" id="bm-len-score">0.88</div>
      </div>
    </div>
    <div class="formula-spot" id="bm-live"></div>`;
  /** Reads the three sliders, works out the BM25 score, and redraws the bars and numbers. */
  const update = () => {
    const tf = Number(($('#bm-tf') as HTMLInputElement).value);
    const df = Number(($('#bm-df') as HTMLInputElement).value);
    const dl = Number(($('#bm-dl') as HTMLInputElement).value);
    $('#bm-tf-v').textContent = String(tf);
    $('#bm-df-v').textContent = String(df);
    $('#bm-dl-v').textContent = String(dl);
    const N = 45,
      avgdl = 50,
      k1 = 1.5,
      b = 0.75;
    const L = 1 - b + b * (dl / avgdl);
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const denom = tf + k1 * L;
    const tfn = tf === 0 ? 0 : (tf * (k1 + 1)) / denom;
    const score = idf * tfn;
    ($('#bm-tf-bar') as HTMLElement).style.width = `${Math.min(100, (tfn / 2.5) * 100)}%`;
    ($('#bm-idf-bar') as HTMLElement).style.width = `${Math.min(100, (idf / 4) * 100)}%`;
    ($('#bm-len-bar') as HTMLElement).style.width = `${Math.min(100, (1 / L) * 55)}%`;
    $('#bm-tf-score').textContent = tfn.toFixed(2);
    $('#bm-idf-score').textContent = idf.toFixed(2);
    $('#bm-len-score').textContent = L.toFixed(2);
    $('#bm-live').innerHTML =
      `Live term score = Inverse Document Frequency (IDF) × Term Frequency (TF) norm = <strong>${score.toFixed(3)}</strong>`;
  };
  ['bm-tf', 'bm-df', 'bm-dl'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', update);
  });
  update();
  ($('#bm25-modal') as HTMLDialogElement).showModal();
}

/**
 * Opens the cosine similarity lab, a 3D view of two vectors and the angle between them.
 * Creates the 3D view on first open, then fills it with chunks from the latest question.
 */
function openCosineLab(): void {
  const dlg = $('#cosine-modal') as HTMLDialogElement;
  dlg.showModal();
  const host = $('#cosine-canvas-host');
  const flatChunks =
    (
      state.chunking as {
        flatChunks?: Array<{
          id: string;
          headingPath: string;
          embeddingDims?: number;
          prefixedText?: string;
          sourceFile?: string;
        }>;
      } | null
    )?.flatChunks || [];

  if (!cosineLab) {
    cosineLab = new Cosine3D(host);
    /**
     * Updates the numbers and the verdict whenever the angle changes.
     * Cosine 0.85 or above reads as similar. From 0.25 up reads as borderline. Below 0.25 reads as unrelated.
     */
    cosineLab.onChange = (st) => {
      ($('#cosine-value') as HTMLElement).textContent = st.cosine.toFixed(2);
      ($('#cosine-theta') as HTMLElement).textContent = `${Math.round(st.thetaDeg)}°`;
      ($('#cosine-theta-label') as HTMLElement).textContent = `${Math.round(st.thetaDeg)}°`;
      ($('#cosine-theta-slider') as HTMLInputElement).value = String(Math.round(st.thetaDeg));
      const dotEl = document.getElementById('cosine-dot');
      if (dotEl) dotEl.textContent = st.cosine.toFixed(3);
      const mags = document.getElementById('cosine-mags');
      if (mags) mags.textContent = 'Query Vector length: 1.00 · Chunk Vector length: 1.00';
      const verdictNum = document.getElementById('cosine-verdict-num');
      if (verdictNum) verdictNum.textContent = st.cosine.toFixed(2);
      const verdict = $('#cosine-verdict');
      if (st.cosine >= 0.85) {
        verdict.textContent = '✓ Semantically Similar';
        verdict.style.color = 'var(--ok)';
      } else if (st.cosine >= 0.25) {
        verdict.textContent = '~ Weak / borderline vs 0.25 gate';
        verdict.style.color = 'var(--warn)';
      } else {
        verdict.textContent = 'Unrelated / gated out';
        verdict.style.color = 'var(--danger)';
      }
    };
    const presets = $('#cosine-presets');
    presets.innerHTML = '';
    /** Adds one preset button to the lab. */
    const mk = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pill';
      b.textContent = label;
      b.addEventListener('click', fn);
      presets.appendChild(b);
    };
    mk('Matching payment chunk (21°)', () => cosineLab!.applyPreset('match'));
    mk('Unrelated Single Sign-On (SSO) chunk (88°)', () => cosineLab!.applyPreset('unrelated'));
    ($('#cosine-theta-slider') as HTMLInputElement).addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      cosineLab!.setTheta(v, 'custom', 'Chunk Vector: selected support section');
    });
    $('#cosine-animate').addEventListener('click', () => cosineLab!.animateSweep(90, 0, 2400));
  }

  /**
   * Picks the dots for the 3D chunk cloud.
   * Normally: the vector search results of the latest question, with their real similarity.
   * If no question has run: the first indexed chunks, with made-up similarities that fall
   * from 0.90 in steps of 0.03.
   */
  const r = (state.bundle.done?.retrieval || state.bundle.retrieval || {}) as Record<
    string,
    unknown
  >;
  const scored = (r.vectorList || []) as Array<{ headingPath: string; vectorSimilarity: number }>;
  const cloud =
    scored.length > 0
      ? scored.slice(0, 24).map((s) => ({
          label: short(s.headingPath),
          similarity: s.vectorSimilarity,
        }))
      : flatChunks.slice(0, 24).map((c, i) => ({
          label: short(c.headingPath),
          similarity: Math.max(0.05, 0.9 - i * 0.03),
        }));
  cosineLab.setChunkCloud(cloud);
  cosineLab.applyPreset('match');
  cosineLab.resize();
}

/** Starts the page. If it fails, the status pill shows why. */
void init().catch((err: Error) => {
  setStatus(`Boot failed: ${err.message}`, 'hold');
});
