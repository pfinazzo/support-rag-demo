/**
 * Why this file exists: it runs the semantic cache panel on the pipeline page.
 * It draws the saved question and answer pairs, the hit and miss counters and the
 * similarity threshold slider. Without it, the user could not see or tune what
 * the semantic cache holds.
 *
 * Only app.ts imports this file. The current public/index.html does not load
 * app.ts, so this panel is not on that page today.
 */

/** What our server reports about the semantic cache for one role. */
export interface CacheState {
  threshold: number;
  maxEntries: number;
  size: number;
  stats: { hits: number; misses: number; hitRate: number };
  entries: Array<{
    id: string;
    query: string;
    answer: string;
    rolePreset: string;
    hitCount: number;
    hnswLevel: number;
    similarity: number | null;
    createdAt: string;
    sources: Array<{ sourceFile?: string; headingPath: string }>;
    embeddingSummary: { first: number[]; barcode: number[]; dims: number; norm: number };
  }>;
}

/**
 * The semantic cache state plus the result of one chat request.
 * Our server sends it with the answer, so the page can say whether that
 * request was a hit or a miss. `bypassed` means the request skipped the semantic cache.
 */
export interface CacheTelemetry extends CacheState {
  bypassed?: boolean;
  hit: boolean;
  similarity: number | null;
  matchedQuery: string | null;
  threshold: number;
  latencyMs: number;
  degradedRisk: boolean;
  retrievalSkipped: boolean;
  llmSkipped: boolean;
  storedEntryId: string | null;
}

/** Finds an element by id. */
const $ = (id: string) => document.getElementById(id)!;

/** Escapes text before it goes into innerHTML. A cached question could hold markup. */
const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Returns the role the page has selected. Replaced once by wireSemanticCache.
 * The default is only used if a request runs before wiring.
 */
let rolePreset = () => 'admin';

/** Counts slider moves, so a slow reply from an older move is ignored. */
let sliderVersion = 0;

/** The last state drawn, as JSON. The panel is only redrawn when this changes. */
let renderedState = '';

/**
 * Calls a semantic cache route and returns the new cache state.
 * With a body it sends a POST. Without one it sends a GET.
 * Throws if our server answers with an error status.
 */
async function request(url: string, body?: object): Promise<CacheState> {
  const res = await fetch(
    url,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  if (!res.ok) throw new Error(`Cache request failed (${res.status})`);
  return (await res.json()) as CacheState;
}

/** Reads the similarity threshold from the slider. */
export function currentCacheThreshold(): number {
  return Number(($('cache-threshold') as HTMLInputElement).value);
}

/**
 * Shows the slider value and names its zone.
 * At 0.92 or above: Strict. From 0.80 up: Sweet Spot. Below 0.80: a loose match
 * can return an answer meant for a different question, so the label turns to a warning.
 */
function zone(value: number): void {
  $('cache-threshold-value').textContent = value.toFixed(2);
  $('cache-zone').textContent =
    value >= 0.92 ? 'Strict' : value >= 0.8 ? 'Sweet Spot' : 'Loose — Degradation Risk';
  $('cache-zone').classList.toggle('risk', value < 0.8);
}

/**
 * Draws the counters, the slot bar and the list of cached pairs, newest first.
 * Does nothing if the state is the same as the last one drawn.
 * Redrawing replaces the list, which would close any answer the user had opened.
 * The slot bar shows at most 32 slots, so a large cache stays readable.
 */
export function renderCache(data: CacheState): void {
  const serialized = JSON.stringify(data);
  if (serialized === renderedState) return;
  renderedState = serialized;
  $('cache-counters').textContent =
    `Hits: ${data.stats.hits} · Misses: ${data.stats.misses} · ${data.size} Cached Pairs`;
  $('cache-store-count').textContent = `${data.size} / ${data.maxEntries}`;
  const segmentCount = Math.min(data.maxEntries, 32);
  $('cache-slots').innerHTML = Array.from(
    { length: segmentCount },
    (_, i) => `<i class="${i < data.size ? 'filled' : ''}" title="${i + 1}"></i>`,
  ).join('');
  $('cache-slots').setAttribute(
    'aria-label',
    `${data.size} of ${data.maxEntries} cached pairs; first 32 slots shown`,
  );
  $('cache-entries').innerHTML = data.entries.length
    ? data.entries
        .slice()
        .reverse()
        .map(
          (e) => `<article class="cache-pair ${e.hitCount ? 'reused' : ''}">
    <div class="cache-key"><span class="cache-kicker">KEY #${esc(e.id)} · ${esc(e.rolePreset)} · HNSW L${e.hnswLevel}</span>
      <strong>${esc(e.query)}</strong>
      <div class="vector-barcode" aria-label="Embedding dimensions">${e.embeddingSummary.barcode.map((v) => `<i style="height:${Math.max(3, Math.min(22, Math.abs(v) * 27))}px"></i>`).join('')}</div>
      <span class="muted mono">${e.embeddingSummary.dims}D · norm ${e.embeddingSummary.norm.toFixed(2)} · ${e.similarity === null ? 'no query' : `sim ${e.similarity.toFixed(3)}`}</span>
      <span class="muted vector-floats">[${e.embeddingSummary.first.map((v) => v.toFixed(2)).join(', ')}, …]</span>
    </div><div class="cache-arrow">→</div>
    <div class="cache-value"><span class="cache-kicker">VALUE · <b>Hits: ${e.hitCount}</b></span>
      <details><summary>${esc(e.answer.slice(0, 155))}${e.answer.length > 155 ? '…' : ''}</summary><div class="cached-full-answer">${esc(e.answer)}</div>
        <small>${e.sources.map((s) => esc(`${s.sourceFile} › ${s.headingPath}`)).join('<br>')}</small></details>
    </div></article>`,
        )
        .join('')
    : '<p class="muted">Empty — ask Payment declined to store your first grounded Key → Value pair.</p>';
}

/**
 * Draws the semantic cache panel, then writes a one-line verdict for the latest request.
 * The verdict says hit, miss or bypassed, with the similarity and the threshold.
 * It also restarts the pulse animation on the semantic cache store.
 * Without the forced reflow, the animation would not restart on a second hit.
 */
export function renderCacheTelemetry(data: CacheTelemetry): void {
  renderCache(data);
  const verdict = $('cache-verdict');
  if (data.bypassed) {
    verdict.className = 'cache-verdict';
    verdict.textContent =
      '🧪 CACHE BYPASSED · Poisoned chunk experiment runs live through retrieval + fenced LLM · No cache read/write or counters';
    return;
  }
  verdict.className = `cache-verdict ${data.hit ? (data.degradedRisk ? 'risk' : 'hit') : 'miss'}`;
  const sim = data.similarity === null ? 'none' : data.similarity.toFixed(3);
  verdict.textContent = data.hit
    ? `${data.degradedRisk ? '⚠ LOW-THRESHOLD HIT' : '⚡ CACHE HIT'} · sim ${sim} ≥ ${data.threshold.toFixed(2)} · Retrieval & LLM skipped · ${data.latencyMs.toFixed(1)} ms${data.degradedRisk ? ' — Potential Answer Degradation!' : ''}`
    : `○ CACHE MISS · nearest ${sim}${data.similarity === null ? '' : ` < ${data.threshold.toFixed(2)}`} · Ran 5-Stage RAG${data.storedEntryId ? ` · Stored Key #${data.storedEntryId}` : ' · Awaiting grounded answer (fallbacks are not cached)'}`;
  $('cache-store').classList.remove('cache-pulse');
  void $('cache-store').offsetWidth;
  $('cache-store').classList.add('cache-pulse');
}

/** Fetches the semantic cache state for the selected role and draws it. */
export async function refreshCache(): Promise<void> {
  renderCache(await request(`/api/cache?rolePreset=${encodeURIComponent(rolePreset())}`));
}

/**
 * Sets up the semantic cache panel once, when the page loads.
 * Loads the semantic cache state, sets the slider to our server's threshold, and listens
 * to the slider and the clear button. Then it refreshes the panel every 2.5 seconds.
 * Moving the slider tells our server the new threshold. Without that, the slider
 * would change the label only and the semantic cache would keep the old threshold.
 */
export async function wireSemanticCache(getRole: () => string): Promise<void> {
  rolePreset = getRole;
  const data = await request(`/api/cache?rolePreset=${encodeURIComponent(rolePreset())}`);
  ($('cache-threshold') as HTMLInputElement).value = String(data.threshold);
  zone(data.threshold);
  renderCache(data);
  $('cache-threshold').addEventListener('input', () => {
    const value = currentCacheThreshold();
    zone(value);
    /** If the user moves the slider again before this save finishes, this refresh is skipped. */
    const version = ++sliderVersion;
    void request('/api/cache/threshold', { threshold: value })
      .then(() => {
        if (version === sliderVersion) return refreshCache();
      })
      .catch((e) => {
        $('cache-verdict').textContent = String(e);
      });
  });
  $('cache-clear').addEventListener('click', () => {
    void request('/api/cache/clear', {}).then(() => {
      $('cache-verdict').className = 'cache-verdict';
      $('cache-verdict').textContent =
        'Cache cleared · 0 entries · Ask a question to fill the first slot.';
      return refreshCache();
    });
  });
  /** Refreshes the panel every 2.5 seconds. Errors are ignored and the next refresh tries again. */
  setInterval(() => {
    void refreshCache().catch(() => {});
  }, 2500);
}
