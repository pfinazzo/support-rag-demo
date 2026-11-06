/**
 * Why this file exists: the Source Fact-Check panel on the pipeline page.
 * After the LLM answers, our server checks each cited source three ways: the
 * URL, the meaning against the NLI model, and the exact quote. This file shows
 * those results step by step. Without it, the user could not see which citation
 * failed or why.
 */
/**
 * One claim from the answer, judged by the NLI model against the source text.
 * `premise` is the source passage. `label` is the model's verdict.
 * `entailment`, `contradiction` and `neutral` are its scores from 0 to 1.
 * `lexicalSimilarity` is a word-based cosine score against the source. The page shows it to make clear that matching words are not support.
 */
interface Claim {
  claim: string;
  premise: string;
  label: string;
  entailment: number;
  contradiction: number;
  neutral: number;
  supported: boolean;
  lexicalSimilarity: number;
  backend: string;
}

/** The three checks for one cited source: URL, meaning match, and exact quote. */
interface CitationRow {
  id: string;
  sourceFile: string;
  urlCheck: { url: string; valid: boolean; status: number | null; error: string | null };
  entailmentCheck: { passed: boolean; claims: Claim[]; modelId: string; skipped?: string };
  quoteCheck: {
    passed: boolean;
    quotes: Array<{ quote: string; normalizedQuote: string; found: boolean }>;
    skipped?: string;
  };
}

/**
 * The server's result for one answer.
 * `status` is "verified" or something else. Anything but "verified" shows REVIEW REQUIRED.
 * `omittedClaims` counts claims left unchecked when the limit was reached.
 * `simulation` names a demo example, when the report came from one.
 */
export interface CitationReport {
  status: string;
  rows: CitationRow[];
  latencyMs: number;
  answer?: string;
  omittedClaims?: number;
  ignoredConfigUrls?: string[];
  simulation?: string;
}

/** Finds an element by id. The page's HTML is expected to contain every id used here. */
const $ = (id: string) => document.getElementById(id)!;

/** Turns text into safe HTML, so server and model text cannot run as markup on the page. */
const esc = (t: unknown) =>
  String(t ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * The last report shown, so the replay button can show it again.
 * `epoch` counts runs. A new run adds one, and older animations stop when they see it.
 * `busy` is true while a report plays or a demo request is open.
 * `controller` can cancel the open demo request.
 */
let latest: CitationReport | null = null,
  epoch = 0,
  busy = false,
  controller: AbortController | null = null;

/** Called when the user clicks View Step 5 Answer. The page uses it to switch to that step. */
let onAnswer: (() => void) | undefined;

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Enables or disables the replay and demo buttons.
 * Both are off while a report plays. Replay is also off when there is nothing to replay.
 */
function controls() {
  ($('citation-replay') as HTMLButtonElement).disabled = busy || !latest;
  document
    .querySelectorAll<HTMLButtonElement>('[data-citation-demo]')
    .forEach((b) => (b.disabled = busy));
}

/**
 * Moves the citation panel into `container`.
 * With no container: puts it before the stage card in the focus panel.
 * Without this, the panel would stay in whichever view it was last shown in.
 */
export function dockCitations(container?: HTMLElement): void {
  const panel = $('citation-panel');
  if (container) container.appendChild(panel);
  else document.querySelector('.focus-panel')!.insertBefore(panel, $('stage-card'));
}

/**
 * Clears the panel back to three Ready steps with a message.
 * Cancels any playing report and any open demo request.
 * Without this, results from the previous question would stay on screen.
 */
export function resetCitationChecks(
  message = 'Waiting for a generated answer · or run a simulator below',
): void {
  epoch++;
  controller?.abort();
  busy = false;
  latest = null;
  dockCitations();
  $('citation-verdict').textContent = message;
  $('citation-answer-preview').textContent = '';
  $('citation-rows').innerHTML =
    '<div class="citation-track">' +
    ['1 · URL Validation', '2 · Meaning Match Check (DeBERTa NLI)', '3 · Exact Quote']
      .map(
        (t) =>
          `<article class="citation-step ready"><b>${t}</b><strong>○ Ready</strong><small>Post-generation check</small></article>`,
      )
      .join('') +
    '</div>';
  controls();
}

/**
 * Draws one row per cited source, each with three Ready steps, and the answer preview.
 * If there are no citations: says the answer is unverified, not trusted.
 * The preview shows the first 170 characters of the answer and a button to read it all.
 */
function build(report: CitationReport): void {
  $('citation-rows').innerHTML = report.rows.length
    ? report.rows
        .map(
          (r, i) =>
            `<article class="citation-row" data-citation-row="${i}"><div class="citation-source"><b>#${i + 1} · ${esc(r.sourceFile)}</b><a href="${esc(r.urlCheck.url)}" target="_blank" rel="noreferrer">${esc(r.urlCheck.url)}</a></div><div class="citation-track">${['URL Validation', 'Meaning Match Check (DeBERTa NLI)', 'Exact Quote Search'].map((name, j) => `<section class="citation-step ready" data-citation-step="${j + 1}"><b>${j + 1} · ${name}</b><strong>○ Ready</strong><small>Waiting for previous check</small></section>`).join('')}</div></article>`,
        )
        .join('')
    : '<p class="muted">No source citations available — answer is unverified, not automatically trusted.</p>';
  const preview = $('citation-answer-preview');
  preview.innerHTML = report.answer
    ? `<span>${esc(report.answer.slice(0, 170))}${report.answer.length > 170 ? '…' : ''}</span> <button id="citation-view-answer" type="button">View Step 5 Answer →</button>`
    : '';
  const view = $('citation-view-answer');
  if (view) view.onclick = () => onAnswer?.();
}

/**
 * Sets one step's look, title and detail text.
 * Also sends a `citation-visual-step` event on the window.
 * Other parts of the page listen for that event to follow along.
 */
function state(row: number, step: number, status: string, title: string, detail: string): void {
  const card = document.querySelector(
    `[data-citation-row="${row}"] [data-citation-step="${step}"]`,
  )! as HTMLElement;
  card.className = 'citation-step ' + status;
  card.dataset.state = status;
  card.querySelector('strong')!.textContent = title;
  card.querySelector('small')!.textContent = detail;
  card.title = detail;
  window.dispatchEvent(
    new CustomEvent('citation-visual-step', {
      detail: { row, step, status, at: performance.now() },
    }),
  );
}

/**
 * Shows a finished report step by step.
 * Our server already ran the checks. This only paces the display.
 * For each source, it shows "checking" for 240 ms, then the result, then waits 90 ms.
 * Step 2 shows the worst claim. A contradiction comes first, then any unsupported claim, then the first claim.
 * Step 2 fails only on a contradiction. Not enough evidence is a warning.
 * If a newer run or a reset began meanwhile: it stops drawing.
 * When done, the verdict line says VERIFIED or REVIEW REQUIRED.
 */
export async function animateCitationReport(report: CitationReport): Promise<void> {
  const version = ++epoch;
  controller?.abort();
  latest = report;
  busy = true;
  build(report);
  controls();
  $('citation-verdict').textContent =
    '🔎 Checking each citation · paced display of actual fetched-page results';
  for (const [i, row] of report.rows.entries())
    for (let step = 1; step <= 3; step++) {
      if (version !== epoch) return;
      state(
        i,
        step,
        'checking',
        ['', '⏳ Fetching…', '⏳ Running DeBERTa NLI…', '⏳ Searching Page Text…'][step],
        step === 1
          ? row.urlCheck.url
          : step === 2
            ? 'Xenova/nli-deberta-v3-xsmall · premise + claim'
            : 'lowercase → trim → collapse whitespace',
      );
      await pause(240);
      if (version !== epoch) return;
      if (step === 1) {
        const r = row.urlCheck;
        state(
          i,
          step,
          r.valid ? 'pass' : 'failed',
          r.valid ? `✓ ${r.status} OK` : `⛔ ${r.status || 'Fetch Error'}`,
          r.error || r.url,
        );
      }
      if (step === 2) {
        const r = row.entailmentCheck;
        const bad =
            r.claims.find((c) => c.label === 'CONTRADICTION') || r.claims.find((c) => !c.supported),
          chosen = bad || r.claims[0];
        const score = chosen
          ? (chosen.label === 'ENTAILMENT'
              ? chosen.entailment
              : chosen.label === 'CONTRADICTION'
                ? chosen.contradiction
                : chosen.neutral) * 100
          : 0;
        state(
          i,
          step,
          r.passed ? 'pass' : bad?.label === 'CONTRADICTION' ? 'failed' : 'warning',
          r.passed
            ? `✓ Backs Up Claim (${score.toFixed(1)}%)`
            : chosen
              ? `${chosen.label === 'CONTRADICTION' ? '⛔' : '⚠'} ${chosen.label === 'CONTRADICTION' ? 'Contradicts Source' : chosen.label === 'ENTAILMENT' ? 'Backs Up Claim' : 'Not Enough Evidence'} (${score.toFixed(1)}%)`
              : '⚠ Source unavailable',
          chosen
            ? `Claim: ${chosen.claim} · ${chosen.label === 'CONTRADICTION' ? 'Word cosine ' + chosen.lexicalSimilarity.toFixed(3) + ' is NOT support · ' : ''}Source: ${chosen.premise}`
            : r.skipped || 'No claim available',
        );
      }
      if (step === 3) {
        const r = row.quoteCheck,
          missing = r.quotes.find((q) => !q.found);
        state(
          i,
          step,
          r.passed ? 'pass' : r.skipped ? 'warning' : 'failed',
          r.passed
            ? r.quotes.length
              ? '✓ VERBATIM MATCH'
              : '✓ No Quoted Span'
            : r.skipped
              ? '⚠ Source unavailable'
              : '⛔ QUOTE NOT FOUND',
          missing
            ? 'Missing normalized quote: ' + missing.normalizedQuote
            : r.quotes.length
              ? `${r.quotes.length}/${r.quotes.length} quotes found after lowercase + trim + whitespace normalization`
              : r.skipped || 'No fabricated direct quotation',
        );
      }
      await pause(90);
    }
  if (version !== epoch) return;
  busy = false;
  controls();
  $('citation-verdict').textContent =
    `${report.simulation ? '🧪 ' + report.simulation + ' · ' : ''}${report.status === 'verified' ? '✓ VERIFIED' : '⚠ REVIEW REQUIRED'} · ${report.rows.length} cited pages · actual server checks ${report.latencyMs.toFixed(0)} ms${report.omittedClaims ? ' · claim limit reached — not fully verified' : ''}`;
}

/**
 * Builds the panel and wires its buttons. `viewAnswer` runs from the answer preview button.
 * The replay button shows the last report again.
 * Each demo button posts its example name to /api/citations/check.
 * Our server then fetches real pages and runs the NLI model, so it can take a while.
 * The "all" example returns four reports. They are joined into one report.
 * If a newer run began first: the late reply is dropped.
 * If the request fails: the verdict line says verification is unavailable.
 */
export function wireCitationChecker(viewAnswer: () => void): void {
  onAnswer = viewAnswer;
  const panel = $('citation-panel');
  panel.innerHTML =
    '<div class="citation-head"><strong>🔎 Source Fact-Check (Citation Verification) · 1 → 2 → 3</strong><button id="citation-replay" type="button" disabled>Replay Citation Checks ↻</button></div><div id="citation-answer-preview" class="citation-answer-preview"></div><div class="citation-demo-bar">' +
    [
      ['pass', '✓ All 3 Checks Pass'],
      ['broken-url', '⛔ Fail 1: 404 URL'],
      ['negation', '⛔ Fail 2: Negation Flip'],
      ['quote', '⛔ Fail 3: Fabricated Quote'],
      ['all', 'Run All 3 Failure Examples'],
    ]
      .map(
        ([kind, label]) => `<button type="button" data-citation-demo="${kind}">${label}</button>`,
      )
      .join('') +
    '</div><div id="citation-verdict" class="citation-verdict"></div><div id="citation-rows"></div>';
  resetCitationChecks();
  $('citation-replay').onclick = () => {
    if (latest && !busy) void animateCitationReport(latest);
  };
  document.querySelectorAll<HTMLButtonElement>('[data-citation-demo]').forEach(
    (button) =>
      (button.onclick = () => {
        if (busy) return;
        const version = ++epoch;
        controller?.abort();
        controller = new AbortController();
        busy = true;
        controls();
        $('citation-verdict').textContent =
          'Fetching real source pages and running local DeBERTa NLI…';
        void fetch('/api/citations/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ simulation: button.dataset.citationDemo }),
          signal: controller.signal,
        })
          .then(async (response) => {
            if (!response.ok) throw new Error('Citation check HTTP ' + response.status);
            return response.json();
          })
          .then(
            (
              result: {
                samples?: Array<{ sample: string; answer: string; report: CitationReport }>;
              } & CitationReport,
            ) => {
              if (version !== epoch) return;
              /** Completed JSON is no longer an in-flight request to cancel. */
              controller = null;
              if (result.samples) {
                const reports = result.samples;
                void animateCitationReport({
                  status: 'flagged',
                  simulation: 'all four examples',
                  latencyMs: reports.reduce((a, s) => a + s.report.latencyMs, 0),
                  rows: reports.flatMap((s) =>
                    s.report.rows.map((r) => ({
                      ...r,
                      sourceFile: s.sample + ' · ' + r.sourceFile,
                    })),
                  ),
                });
              } else void animateCitationReport(result);
            },
          )
          .catch((error) => {
            if (version !== epoch) return;
            busy = false;
            controls();
            $('citation-verdict').textContent =
              'Citation verification unavailable: ' + String(error);
          });
      }),
  );
}
