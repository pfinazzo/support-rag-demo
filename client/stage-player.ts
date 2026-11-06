/**
 * Why this file exists: the pipeline page shows a question's journey one stage
 * at a time. This file lists the stages and decides when the page moves between
 * them. Without it, fast stages would flash past and the user could not follow.
 */
/**
 * The nine pipeline stages, in the order the page shows them.
 * `label` is the technical name. `plain` is the same stage in everyday words.
 * The page draws one stepper button per entry. The player walks through them in this order.
 */
export const STAGES = [
  { id: 'security', label: 'Prompt Guard', plain: 'Security check' },
  { id: 'cache', label: 'Semantic Cache', plain: 'Have we answered this before?' },
  { id: 'query-rewrite', label: 'Query Rewrite', plain: 'Make the question clear' },
  { id: 'search', label: 'Hybrid Search', plain: 'Find the right evidence' },
  { id: 'context', label: 'Context Assembly', plain: 'Build the model call' },
  { id: 'router', label: 'Model Router', plain: 'Choose the right model' },
  { id: 'generate', label: 'LLM Generation', plain: 'Write the answer' },
  { id: 'fact-check', label: 'Citation Verification', plain: 'Check the sources' },
  { id: 'result', label: 'Grounded Result', plain: 'The final answer' },
] as const;

/** Name of one pipeline stage, taken from STAGES. */
export type StageId = (typeof STAGES)[number]['id'];

/**
 * Where one stage stands.
 * - waiting: no event has arrived yet.
 * - running: some events arrived, but the stage is not done.
 * - complete: the stage has everything it needs.
 * - skipped: the stage did not run, for example after a semantic cache hit.
 * - stopped: the prompt guard blocked the request before this stage.
 */
export type StageStatus = 'waiting' | 'running' | 'complete' | 'skipped' | 'stopped';

/**
 * What the page knows about one stage.
 * `ready` is true once the stage has enough data to show as finished.
 * `data` holds the latest payload for each event name.
 * `events` holds every event in the order it arrived.
 */
export interface StageRecord {
  id: StageId;
  status: StageStatus;
  ready: boolean;
  data: Record<string, any>;
  events: Array<{ event: string; data: Record<string, any> }>;
}

/**
 * Everything the page needs to draw one question's run.
 * - active: the stage on screen now, or null before the run starts.
 * - playing: true while the player moves on by itself.
 * - finished: true once the server sent its final event or an error.
 * - blocked: true if the prompt guard stopped the request.
 * - cacheHit: true if the semantic cache answered the question.
 * - startedAt: when the run began, in milliseconds.
 * - visited: the stages shown so far, in order.
 * - error: the message if the server ended the run with an error, else null.
 */
export interface RunState {
  stages: Record<StageId, StageRecord>;
  active: StageId | null;
  playing: boolean;
  finished: boolean;
  blocked: boolean;
  cacheHit: boolean;
  startedAt: number;
  visited: StageId[];
  error: string | null;
}

/**
 * Plays a finished or running pipeline back one stage at a time.
 *
 * Our server sends stage events as fast as it can. Left alone, the page would
 * flash through them. This class holds each stage on screen long enough to read.
 * The rules the page and the tests depend on:
 *
 * - Hold time: a stage stays on screen for at least `beatMs` after it is shown.
 *   The default is 1250 ms.
 * - Moving on: after the hold time, the player moves to the next stage, but only
 *   if the stage on screen is ready. If it is not ready, the player keeps waiting.
 * - No jumping ahead: the player never skips over a stage that has not started.
 *   If the next stage has no events yet, it stays on the current stage.
 * - Skipped and stopped stages are passed over when moving on or stepping back.
 * - Answer typing: on the Generate stage, the answer text is revealed a few
 *   characters at a time. The player does not move on until all of it shows.
 * - Pause: `pause` stops moving on, for as long as the user wants.
 *   Stepping back or forward, and clicking a stage, also pause.
 * - Play: `play` starts moving on again and restarts the hold time for the stage
 *   on screen. If the run is finished and the Result stage is on screen, `play`
 *   replays the run from the Security stage instead.
 * - Replay: `replay` goes back to the Security stage and plays the stages again.
 * - Blocked: if the prompt guard blocks the request, the player stays on the
 *   Security stage and cannot play. Later stages show as stopped.
 * - Cache hit: Query Rewrite through Fact-Check show as skipped.
 *
 * The clock is a parameter so tests can move time by hand. Without that, the
 * tests would have to wait in real time.
 */
export class StagePlayer {
  /** The run being played. It is replaced as a whole when a new run starts. */
  state: RunState;

  /** When the stage on screen was shown, in milliseconds. The hold time counts from here. */
  private enteredAt = 0;

  /** How many characters of the answer the Generate stage shows so far. */
  private revealedChars = 0;

  /** When the answer text last grew, in milliseconds. Used to size the next step. */
  private revealAt = 0;

  /** Sets the hold time per stage and the clock. The run starts empty until `start` is called. */
  constructor(
    public beatMs = 1250,
    private now = () => Date.now(),
  ) {
    this.state = this.empty();
  }

  /** Builds a fresh run state with every stage waiting. */
  private empty(): RunState {
    return {
      stages: Object.fromEntries(
        STAGES.map((s) => [
          s.id,
          { id: s.id, status: 'waiting', ready: false, data: {}, events: [] },
        ]),
      ) as unknown as RunState['stages'],
      active: null,
      playing: true,
      finished: false,
      blocked: false,
      cacheHit: false,
      startedAt: 0,
      visited: [],
      error: null,
    };
  }

  /**
   * Begins a new run on the Security stage and returns the state.
   * Without this reset, the page would still show the previous question's stages.
   */
  start() {
    this.revealedChars = 0;
    this.revealAt = this.now();
    this.state = this.empty();
    this.state.startedAt = this.now();
    this.activate('security');
    this.state.stages.security.status = 'running';
    return this.state;
  }

  /** Puts a stage on screen. Restarts its hold time and the answer typing, and marks it visited. */
  private activate(id: StageId) {
    this.state.active = id;
    this.enteredAt = this.now();
    this.revealAt = this.now();
    if (!this.state.visited.includes(id)) this.state.visited.push(id);
  }

  /**
   * Stores one event on a stage.
   * If `ready` is true, the stage becomes complete. If not, it shows as running.
   * A stage already marked skipped or stopped keeps that status.
   */
  private record(id: StageId, event: string, data: Record<string, any>, ready = true) {
    const s = this.state.stages[id];
    s.events.push({ event, data });
    s.data[event] = data;
    s.ready ||= ready;
    if (s.status === 'waiting' || s.status === 'running') s.status = ready ? 'complete' : 'running';
  }

  /**
   * Takes one server event, stores it on the right stage, and returns the state.
   * This is the only place that knows which event belongs to which stage.
   * Unknown event names are ignored.
   * - guard_layer: the Security stage is ready once the last guard layer reports.
   *   A block also makes it ready.
   * - guard: the Security stage is ready once no guard layer is still pending.
   * - cache: on a hit, Query Rewrite through Fact-Check are marked skipped.
   * - token_delta: the answer text grows. The page types it out through `tick`.
   * - stream_reset: the server restarted the answer, so the text starts over.
   * - citation_check: the Generate stage is complete, because fact-checking only
   *   starts once the answer is written.
   * - error: the run ends and the error message is kept.
   */
  ingest(event: string, data: Record<string, any>) {
    const s = this.state.stages;
    switch (event) {
      case 'guard_layer':
        this.record('security', event, data, false);
        if ((data.layerIndex === 4 && data.phase !== 'checking') || data.result?.blocked) {
          if (
            !s.security.ready &&
            this.state.active === 'security' &&
            this.now() - this.enteredAt > this.beatMs
          )
            this.enteredAt = this.now();
          s.security.ready = true;
        }
        break;
      case 'guard':
        this.record(
          'security',
          event,
          data,
          !Array.isArray(data.layers) ||
            !data.layers.some((layer: Record<string, any>) => layer.status === 'pending'),
        );
        if (data.blocked) this.block(data);
        break;
      case 'cache':
        this.record('cache', event, data);
        if (data.hit) {
          this.state.cacheHit = true;
          for (const stage of STAGES.slice(2, 8)) {
            s[stage.id].status = 'skipped';
            s[stage.id].ready = true;
          }
        }
        break;
      case 'query_rewrite':
        this.record('query-rewrite', event, data);
        break;
      case 'search_pass':
      case 'fusing':
      case 'reranking':
        this.record('search', event, data, event === 'reranking');
        break;
      case 'context_step':
        this.record('context', event, data, false);
        break;
      case 'context':
        this.record('context', event, data);
        break;
      case 'routing':
      case 'fallback':
      case 'prompt_cache':
        this.record('router', event, data);
        break;
      case 'agent_step':
        this.record('generate', event, data, false);
        break;
      case 'token_delta':
        this.record('generate', event, data, false);
        s.generate.data.answer = (s.generate.data.answer || '') + String(data.text || '');
        break;
      case 'stream_reset':
        s.generate.data.answer = '';
        this.revealedChars = 0;
        this.record('generate', event, data, false);
        break;
      case 'stream_error':
        this.record('generate', event, data, false);
        break;
      case 'structured_output':
      case 'stream_metrics':
        this.record('generate', event, data, event === 'structured_output');
        break;
      case 'citation_check':
        this.record('fact-check', event, data, false);
        s.generate.ready = true;
        s.generate.status = 'complete';
        break;
      case 'done':
        this.finish(data);
        break;
      case 'error':
        this.state.error = String(data.error || 'Request interrupted');
        this.state.finished = true;
        this.state.playing = false;
        break;
    }
    return this.state;
  }

  /**
   * Marks the request as blocked by the prompt guard.
   * Every stage after Security is stopped, the view returns to Security, and playback stops.
   * Without this, the page would keep stepping into stages that never ran.
   */
  private block(data: Record<string, any>) {
    this.state.blocked = true;
    this.state.stages.security.ready = true;
    this.state.stages.security.data.blocked = data;
    for (const stage of STAGES.slice(1)) {
      this.state.stages[stage.id].status = 'stopped';
      this.state.stages[stage.id].ready = true;
    }
    this.activate('security');
    this.state.playing = false;
  }

  /**
   * Closes the run when the server sends its final result.
   * Copies the final result into each stage, then marks stages with no events as skipped.
   * If the prompt guard blocked the request, it takes the blocked path instead.
   */
  private finish(data: Record<string, any>) {
    this.state.finished = true;
    if (data.blockedByGuard) {
      this.record('security', 'done', data);
      this.block(data.guard || data);
      return;
    }
    if (data.queryRewrite) this.record('query-rewrite', 'query_rewrite', data.queryRewrite);
    if (data.retrieval) this.record('search', 'reranking', data.retrieval);
    if (data.infrastructure?.context)
      this.record('context', 'context', data.infrastructure.context);
    if (data.infrastructure?.routing) this.record('router', 'routing', data.infrastructure.routing);
    if (data.infrastructure?.promptCache)
      this.record('router', 'prompt_cache', data.infrastructure.promptCache);
    if (data.answer) {
      this.state.stages.generate.data.answer = data.answer;
      this.state.stages.generate.ready = true;
    }
    if (data.citationCheck) this.record('fact-check', 'report', data.citationCheck);
    this.record('result', 'done', data);
    if (this.state.cacheHit) {
      for (const stage of STAGES.slice(2, 8)) this.state.stages[stage.id].status = 'skipped';
    } else
      for (const stage of STAGES) {
        const r = this.state.stages[stage.id];
        if (!r.events.length && stage.id !== 'result') {
          r.status = 'skipped';
          r.ready = true;
        } else {
          r.ready = true;
          if (r.status !== 'stopped') r.status = 'complete';
        }
      }
  }

  /**
   * Moves the player forward if it is time. Returns true if the page should redraw.
   * Call it often. Each call checks the rules in this order:
   * 1. If nothing is on screen, or playback is paused or blocked: do nothing.
   * 2. If the Generate stage is on screen and has unrevealed text: reveal more text.
   * 3. If the stage is not ready, or its hold time has not passed: do nothing.
   * 4. If a next stage can run: show it.
   * 5. If the run is finished and there is no next stage: stop playing.
   */
  tick() {
    const a = this.state.active;
    if (!a || !this.state.playing || this.state.blocked) return false;
    const stage = this.state.stages[a];
    if (a === 'generate') {
      const answer = String(stage.data.answer || '');
      if (this.revealedChars < answer.length) {
        const amount = Math.max(1, Math.floor((this.now() - this.revealAt) / 25)) * 5;
        this.revealedChars = Math.min(answer.length, this.revealedChars + amount);
        this.revealAt = this.now();
        return true;
      }
    }
    if (!stage.ready || this.now() - this.enteredAt < this.beatMs) return false;
    const next = this.nextRunnable(1);
    if (next) {
      this.activate(next);
      return true;
    }
    if (this.state.finished) {
      this.state.playing = false;
      return true;
    }
    return false;
  }

  /**
   * Finds the stage to move to, going forward (1) or back (-1).
   * Skipped and stopped stages are passed over.
   * Returns null if the next stage has not started yet. It does not look past it.
   * Without that, the page could jump over a stage that is still loading.
   */
  private nextRunnable(direction: number) {
    const index = STAGES.findIndex((s) => s.id === this.state.active);
    for (let i = index + direction; i >= 0 && i < STAGES.length; i += direction) {
      const s = this.state.stages[STAGES[i].id];
      if (s.status === 'skipped' || s.status === 'stopped') continue;
      if (s.ready || s.events.length) return s.id;
      return null;
    }
    return null;
  }

  /** Stops moving on by itself. The stage on screen stays until the user acts. */
  pause() {
    this.state.playing = false;
  }

  /**
   * Starts moving on again.
   * If the run is blocked: does nothing.
   * If the Result stage is on screen and the run is finished: replays from the start.
   * Otherwise: restarts the hold time, so the stage on screen is not skipped at once.
   */
  play() {
    if (this.state.blocked) return;
    if (this.state.active === 'result' && this.state.finished) {
      this.replay();
      return;
    }
    this.state.playing = true;
    this.enteredAt = this.now();
  }

  /** Pauses if playing, plays if paused. The play button and the space bar call this. */
  toggle() {
    this.state.playing ? this.pause() : this.play();
  }

  /**
   * Jumps to a stage the user clicked and pauses. Returns false if it cannot.
   * A stage that was skipped or stopped, or has no data yet, cannot be selected.
   * On the Generate stage, the whole answer shows at once, with no typing.
   */
  select(id: StageId) {
    const s = this.state.stages[id];
    if (s.status === 'stopped' || s.status === 'skipped' || (!s.ready && !s.events.length))
      return false;
    this.pause();
    this.activate(id);
    if (id === 'generate')
      this.revealedChars = String(this.state.stages.generate.data.answer || '').length;
    return true;
  }

  /**
   * Steps one runnable stage forward (1) or back (-1) and pauses.
   * Returns false if there is no stage to move to.
   * On the Generate stage, the whole answer shows at once, with no typing.
   */
  move(direction: number) {
    this.pause();
    const id = this.nextRunnable(direction);
    if (id) {
      this.activate(id);
      if (id === 'generate')
        this.revealedChars = String(this.state.stages.generate.data.answer || '').length;
    }
    return Boolean(id);
  }

  /**
   * Goes back to the Security stage and plays the stages again.
   * Playback restarts unless the request was blocked. Does nothing before a run starts.
   */
  replay() {
    if (!this.state.active) return;
    this.revealedChars = 0;
    this.state.visited = [];
    this.activate('security');
    this.state.playing = !this.state.blocked;
  }

  /** The part of the answer to show now. The page calls this to draw the typing effect. */
  displayedAnswer() {
    return String(this.state.stages.generate.data.answer || '').slice(0, this.revealedChars);
  }

  /**
   * How much of the hold time has passed, from 0 to 1.
   * The page draws it as a progress bar. It is 0 while paused.
   */
  progress() {
    if (!this.state.playing) return 0;
    return Math.max(0, Math.min(1, (this.now() - this.enteredAt) / this.beatMs));
  }
}
