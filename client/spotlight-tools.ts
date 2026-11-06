/**
 * Why this file exists: the Tools menu on the pipeline page. It opens a dialog
 * to run the evaluation suite, review held answers, inject quality problems and
 * change indexed documents. Without it, the user could not reach those server features.
 */
/** Loose shape for JSON the server sends. Fields are read without checking. */
type D = Record<string, any>;

/** Finds an element by id. The page's HTML is expected to contain every id used here. */
const el = (id: string) => document.getElementById(id)!;

/**
 * Turns text into safe HTML.
 * Server text goes into innerHTML. Without this, a question or answer containing
 * markup would run as markup on the page.
 */
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Formats a value as indented JSON, safe to put inside a <pre> block. */
const pretty = (v: unknown) => esc(JSON.stringify(v, null, 2));

/**
 * Calls one of our server's routes and returns its JSON.
 * With no body: sends a GET request. With a body: sends it as a POST with JSON.
 * Throws an error naming the HTTP status if the server does not answer with success.
 */
async function api(path: string, body?: unknown) {
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
  if (!r.ok) throw new Error('Operation failed (' + r.status + ')');
  return r.json();
}

/**
 * Connects the Tools menu and its dialog to the page.
 * Listens for clicks on the menu button, the close button and every tool button.
 * A click anywhere outside the menu closes it.
 * Choosing a tool opens the dialog with "Loading…", then fills it.
 * If a tool fails to load: the dialog shows the error message instead.
 * Without this, the menu would never open and the tools could not be reached.
 */
export function wireTools() {
  const menu = el('tools-menu'),
    dialog = el('tools-dialog') as HTMLDialogElement;
  el('tools-toggle').onclick = (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    el('tools-toggle').setAttribute('aria-expanded', String(!menu.hidden));
  };
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element && e.target.closest('.tools-anchor'))) {
      menu.hidden = true;
      el('tools-toggle').setAttribute('aria-expanded', 'false');
    }
  });
  el('tools-close').onclick = () => dialog.close();
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(
    (button) =>
      (button.onclick = async () => {
        menu.hidden = true;
        el('tools-toggle').setAttribute('aria-expanded', 'false');
        el('tools-title').textContent = button.textContent;
        el('tools-body').textContent = 'Loading…';
        dialog.showModal();
        try {
          await renderTool(button.dataset.tool!);
        } catch (e) {
          el('tools-body').textContent = (e as Error).message;
        }
      }),
  );
}

/**
 * Fills the tools dialog for one tool: eval, review, quality or index.
 * Each tool asks our server for its data and draws it. Its buttons call the server
 * and then draw the tool again, so the dialog shows the new state.
 * - eval: lists the fixed test questions. "Run suite" posts to /api/eval/run with
 *   the LLM judge on and shows each result against its expected answer.
 * - review: lists answers held for a person to check. Approve, Edit & Release and
 *   Reject post to /api/review-queue/action. Edit sends the text in the box.
 * - quality: shows each quality metric as a small line chart, scaled 0 to 100
 *   percent. The two buttons post a degraded
 *   or healthy batch to /api/quality-meter/batch.
 * - index: lists the indexed documents. One button changes a document and the
 *   other restores the corpus. The page also shows the refresh events and SQL triggers.
 * If the tool name is unknown: the dialog stays on "Loading…".
 */
async function renderTool(kind: string) {
  const body = el('tools-body');
  if (kind === 'eval') {
    const q = await api('/api/eval/questions');
    body.innerHTML =
      '<button id="modal-run-eval" class="run-button">Run suite</button><span id="modal-eval-status"> 20 fixed questions</span><div id="modal-eval-list">' +
      q.questions
        .map(
          (q: D) =>
            `<details><summary>${esc(q.id)} · ${esc(q.question)}</summary><p>${esc(q.expectedAnswer)}</p><small>${esc(q.requiredSources.join(', '))}</small></details>`,
        )
        .join('') +
      '</div>';
    el('modal-run-eval').onclick = async () => {
      (el('modal-run-eval') as HTMLButtonElement).disabled = true;
      el('modal-eval-status').textContent = ' Running full pipeline…';
      try {
        const r = await api('/api/eval/run', { judge: true });
        el('modal-eval-status').textContent = ` ${r.passed}/20 passed · ${r.drifted} drifted`;
        el('modal-eval-list').innerHTML = r.results
          .map(
            (r: D) =>
              `<details><summary>${esc(r.id)} · ${esc(r.status)}</summary><div class="modal-comparison"><div><b>Expected</b><p>${esc(r.expectedAnswer)}</p></div><div><b>Actual</b><p>${esc(r.actualAnswer)}</p></div></div><pre>${pretty({ missingFacts: r.missingKeywords, missingSources: r.missingSources, judge: r.judge })}</pre></details>`,
          )
          .join('');
      } finally {
        (el('modal-run-eval') as HTMLButtonElement).disabled = false;
      }
    };
  } else if (kind === 'review') {
    const r = await api('/api/review-queue');
    body.innerHTML = r.items
      .map(
        (i: D) =>
          `<article class="modal-review"><h3>${esc(i.question)}</h3><p>${esc(i.id)} · ${Math.round(i.confidenceScore * 100)}% · ${esc(i.status)}</p><p>${esc(i.caughtReasons.join(', '))}</p><div class="modal-comparison"><pre>${pretty(i.originalSources)}</pre><pre>${pretty(i.proposedOutput)}</pre></div>${i.status === 'pending' ? `<textarea id="edit-${i.id}" aria-label="Edited answer">${esc(i.proposedOutput?.answer || '')}</textarea><div class="modal-actions">${['approve', 'edit', 'reject'].map((a) => `<button data-review="${i.id}" data-action="${a}">${a === 'edit' ? 'Edit & Release' : a[0].toUpperCase() + a.slice(1)}</button>`).join('')}</div>` : ''}</article>`,
      )
      .join('');
    body.querySelectorAll<HTMLButtonElement>('[data-review]').forEach(
      (b) =>
        (b.onclick = async () => {
          await api('/api/review-queue/action', {
            id: b.dataset.review,
            action: b.dataset.action,
            answer: (el('edit-' + b.dataset.review) as HTMLTextAreaElement).value,
          });
          await renderTool('review');
        }),
    );
  } else if (kind === 'quality') {
    const q = await api('/api/quality-meter');
    body.innerHTML =
      '<div class="modal-actions"><button id="modal-degrade">Inject degraded batch</button><button id="modal-recover">Record healthy batch</button></div>' +
      q.metrics
        .map(
          (m: D) =>
            `<div class="modal-metric"><b>${esc(m.metric.replace(/([A-Z])/g, ' $1'))}</b><span>${Math.round(m.value * 100)}% · ${m.alertActive ? 'Drift alert' : esc(m.status)}</span><svg viewBox="0 0 300 45"><polyline points="${m.series.map((p: D, i: number) => `${(i / Math.max(1, m.series.length - 1)) * 300},${42 - p.value * 38}`).join(' ')}"/></svg></div>`,
        )
        .join('');
    for (const [id, degraded] of [
      ['modal-degrade', true],
      ['modal-recover', false],
    ] as const)
      el(id).onclick = async () => {
        await api('/api/quality-meter/batch', { degraded });
        await renderTool('quality');
      };
  } else if (kind === 'index') {
    const r = await api('/api/reindex/status');
    body.innerHTML =
      '<div class="modal-actions"><button id="modal-mutate">Change database document</button><button id="modal-restore">Restore corpus</button></div>' +
      r.documents.map((d: D) => `<p>${esc(d.id)} · ${esc(d.source)}</p>`).join('') +
      `<p>${r.chunkCount} indexed sections</p><details><summary>Refresh events & SQL triggers</summary><pre>${pretty({ events: r.events, triggers: r.triggers })}</pre></details>`;
    el('modal-mutate').onclick = async () => {
      await api('/api/reindex/mutate', {});
      await renderTool('index');
    };
    el('modal-restore').onclick = async () => {
      await api('/api/reindex/restore', {});
      await renderTool('index');
    };
  }
}
