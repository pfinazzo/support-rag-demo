/**
 * Why this file exists: it draws the 3D funnel on the pipeline page. The funnel
 * shows the five stages of one question, from left to right: keyword search,
 * vector search with the RBAC role filter, reciprocal rank fusion, the
 * cross-encoder reranker, and the final answer. Without it, the page would show
 * only text and the user could not see how the ranks change from stage to stage.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

/**
 * The x position of each stage's column, left to right. The spacing keeps all five columns in the camera's view.
 */
const COL_X = [-8.8, -4.4, 0.0, 4.5, 8.8] as const;

/**
 * What our server returns for one question. Each list holds one stage's results. A missing list means that stage did not run.
 */
export interface WalkPayload {
  cacheHit?: boolean;
  query?: string;
  rrfK?: number;
  bm25List?: Array<{ headingPath: string; bm25Rank: number; bm25Score: number }>;
  vectorList?: Array<{ headingPath: string; vectorRank: number; vectorSimilarity: number }>;
  rrfShortlist?: Array<{
    headingPath: string;
    rrfRank: number;
    rrfScore: number;
    bm25Rank: number | null;
    vectorRank: number | null;
  }>;
  reranked?: Array<{
    headingPath: string;
    rrfRank: number;
    rerankRank: number;
    rankDelta: number;
    keptForLlm: boolean;
    rerankScore: number;
  }>;
  results?: Array<{ headingPath: string; sourceFile?: string }>;
  relevant?: boolean;
  permissionReport?: {
    accessibleChunkCount?: number;
    totalChunkCount?: number;
    excludedChunks?: Array<{ headingPath: string; chunkRoles: string[] }>;
  };
}

/**
 * What our server returns for the answer step. It says which LLM answered and which chunks it was given.
 */
export interface ChatStepPayload {
  usedFallback?: boolean;
  llmProvider?: string | null;
  model?: string | null;
  answer?: string;
  contextPassedToLlm?: Array<{ headingPath: string; sourceFile?: string }>;
}

/**
 * Escapes text so it is safe to put inside HTML. Without it, a heading with angle brackets would break the label.
 */
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Shortens a heading path to its last part, cut to fit a label. Returns a dash if there is no path.
 */
function leaf(path?: string): string {
  if (!path) return '—';
  const parts = path.split(' > ');
  const last = parts[parts.length - 1] || path;
  return last.length > 24 ? last.slice(0, 22) + '…' : last;
}

/** One glowing dot that travels along a flow tube. */
interface PulseDot {
  mesh: THREE.Mesh;
  curve: THREE.CatmullRomCurve3;
  speed: number;
  offset: number;
  stage: number;
}

/**
 * The 3D funnel. It owns the three.js scene, the camera and the label layer inside one page element.
 * The page calls loadWalkthrough with a server result, then setStage to move the focus.
 */
export class Pipeline3D {
  host: HTMLElement;

  stage = 1;

  onStageChange?: (stage: number) => void;

  onStageClick?: (stage: number) => void;

  private scene: THREE.Scene;

  private camera: THREE.PerspectiveCamera;

  private renderer: THREE.WebGLRenderer;

  private labelRenderer: CSS2DRenderer;

  private controls: OrbitControls;

  private contentGroup: THREE.Group;

  private stageGroups: Record<number, THREE.Group> = {};

  private baseTags: Record<number, HTMLElement> = {};

  private callouts: Array<{ stage: number; obj: CSS2DObject }> = [];

  private pulses: PulseDot[] = [];

  private _clock = new THREE.Clock();

  private _cameraGoal: THREE.Vector3 | null = null;

  private _targetGoal: THREE.Vector3 | null = null;

  lastPayload: WalkPayload | null = null;

  lastChat: ChatStepPayload | null = null;

  explorerK = 30;

  /**
   * Builds the scene, lights, camera, controls and label layer inside the host element.
   * Listens to window resize. Starts the animation loop, which never stops.
   */
  constructor(host: HTMLElement) {
    this.host = host;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070d19);

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
    this.camera.position.set(0, 6.4, 26.8);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'css2d-layer';
    host.appendChild(this.labelRenderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 1.75, 0);

    this.scene.add(new THREE.AmbientLight(0xb4ccf0, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.05);
    key.position.set(6, 16, 14);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x38bdf8, 0.4);
    rim.position.set(-10, 8, 8);
    this.scene.add(rim);

    const grid = new THREE.GridHelper(28, 28, 0x1e293b, 0x0f172a);
    grid.position.y = -0.02;
    this.scene.add(grid);

    this.contentGroup = new THREE.Group();
    this.scene.add(this.contentGroup);

    this._buildIdleSkeleton();

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this._tick();
  }

  /**
   * Removes every stage object from the scene and frees its geometry.
   * Also removes the HTML labels from the page. Without this, old labels would pile up after each question.
   */
  private _clearContent(): void {
    this.pulses = [];
    this.baseTags = {};
    this.callouts = [];
    this.stageGroups = {};
    while (this.contentGroup.children.length) {
      const c = this.contentGroup.children.pop()!;
      this.contentGroup.remove(c);
      c.traverse((obj) => {
        const o = obj as THREE.Mesh & { element?: HTMLElement };
        if (o.geometry) o.geometry.dispose();
        if (o.element && o.element.parentElement) {
          o.element.parentElement.removeChild(o.element);
        }
      });
    }
  }

  /**
   * Draws five placeholder columns with short bars, before any question has run.
   * Each stage tag reads Ready.
   */
  private _buildIdleSkeleton(): void {
    this._clearContent();
    const stages = [
      { s: 1, tag: '1 · Keyword', color: 0xf59e0b },
      { s: 2, tag: '2 · Vector', color: 0x06b6d4 },
      { s: 3, tag: '3 · Combine', color: 0x6366f1 },
      { s: 4, tag: '4 · Re-Rank', color: 0xa855f7 },
      { s: 5, tag: '5 · Answer', color: 0x10b981 },
    ];
    stages.forEach((st, idx) => {
      const x = COL_X[idx];
      const g = new THREE.Group();
      this.stageGroups[st.s] = g;
      this.contentGroup.add(g);
      this._addPedestal(g, x, st.color);
      this._addBaseTag(g, st.s, x, st.tag, 'Ready', st.color);

      const n = st.s === 5 ? 1 : 3;
      for (let i = 0; i < n; i++) {
        const h = st.s === 5 ? 1.4 : 2.1 - i * 0.45;
        const bx = n === 1 ? x : x + (i - 1) * 0.56;
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(n === 1 ? 0.9 : 0.42, h, 0.42),
          new THREE.MeshStandardMaterial({
            color: st.color,
            emissive: st.color,
            emissiveIntensity: 0.16,
            transparent: true,
            opacity: 0.45,
            roughness: 0.35,
          }),
        );
        mesh.position.set(bx, h / 2 + 0.06, 0);
        g.add(mesh);
      }

      if (idx < stages.length - 1) {
        this._addFlowTube(
          g,
          new THREE.Vector3(x + 1.05, 1.3, 0),
          new THREE.Vector3(COL_X[idx + 1] - 1.05, 1.3, 0),
          st.color,
          st.s,
          false,
          0.25,
        );
      }
    });
  }

  /** Adds the glowing ring and dark disc under one column. */
  private _addPedestal(g: THREE.Group, x: number, color: number): void {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.02, 1.16, 36),
      new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.55,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.02, 0);
    g.add(ring);

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(1.02, 36),
      new THREE.MeshBasicMaterial({ color: 0x0f172a, transparent: true, opacity: 0.9 }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(x, 0.01, 0);
    g.add(disc);
  }

  /**
   * Adds the clickable label under one column, with a title and a short stat.
   * When the user clicks it, the page is told which stage was chosen.
   */
  private _addBaseTag(
    g: THREE.Group,
    stage: number,
    x: number,
    title: string,
    stat: string,
    colorHex: number,
  ): void {
    const anchor = new THREE.Object3D();
    anchor.position.set(x, -0.58, 0.85);
    g.add(anchor);

    const hex = '#' + colorHex.toString(16).padStart(6, '0');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pipe-base-tag';
    btn.style.setProperty('--stage-accent', hex);
    btn.innerHTML = `<span class="pbt-title">${esc(title)}</span><span class="pbt-stat">${esc(stat)}</span>`;
    btn.addEventListener('click', () => this.onStageClick?.(stage));

    anchor.add(new CSS2DObject(btn));
    this.baseTags[stage] = btn;
  }

  /** Adds a floating note above a column. It shows only while its stage is the chosen stage. */
  private _addCallout(
    g: THREE.Group,
    stage: number,
    pos: THREE.Vector3,
    html: string,
    tone: string,
  ): void {
    const anchor = new THREE.Object3D();
    anchor.position.copy(pos);
    g.add(anchor);
    const el = document.createElement('div');
    el.className = `pipe-callout ${tone}`;
    el.innerHTML = html;
    const obj = new CSS2DObject(el);
    obj.visible = stage === this.stage;
    anchor.add(obj);
    this.callouts.push({ stage, obj });
  }

  /**
   * Draws a curved tube between two points, and optionally two moving dots along it.
   * arcY is how high the middle of the curve rises. The dots show where data flows.
   */
  private _addFlowTube(
    g: THREE.Group,
    from: THREE.Vector3,
    to: THREE.Vector3,
    color: number,
    stage: number,
    withPulses = true,
    arcY = 0.35,
  ): void {
    const mid = from.clone().lerp(to, 0.5);
    mid.y += arcY;
    const curve = new THREE.CatmullRomCurve3([from, mid, to]);
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 24, 0.042, 8, false),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45 }),
    );
    g.add(tube);

    if (withPulses) {
      for (let i = 0; i < 2; i++) {
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(0.105, 12, 12),
          new THREE.MeshBasicMaterial({ color }),
        );
        g.add(dot);
        this.pulses.push({
          mesh: dot,
          curve,
          speed: 0.4,
          offset: i * 0.5,
          stage,
        });
      }
    }
  }

  /**
   * Shows the result of one question.
   * Removes any guard banner, stores the server result, rebuilds every column and applies the stage lighting.
   */
  loadWalkthrough(payload: WalkPayload, chat: ChatStepPayload | null, k = 30): void {
    this.host.querySelector('.guard-viewport-banner')?.remove();
    delete this.host.dataset.guardGate;
    this.lastPayload = payload;
    this.lastChat = chat;
    this.explorerK = k;
    this._rebuildAll();
    this._applyStageVisuals();
  }

  /**
   * Shows a shield above the funnel while a prompt guard layer checks the question.
   * If the status is blocked: every stage reads Not reached, because the question never got that far.
   * The layer index is shown as a number out of four. Blocked uses 0.
   */
  showGuardStage(index: number, layer: string, status: 'checking' | 'blocked' | 'contained'): void {
    this.host.querySelector('.guard-viewport-banner')?.remove();
    this.lastPayload = null;
    this.lastChat = null;
    this._buildIdleSkeleton();
    this.stage = 1;
    for (let s = 1; s <= 5; s++)
      this.baseTags[s].querySelector('.pbt-stat')!.textContent = 'Not reached';
    const color = status === 'blocked' ? 0xfb456a : status === 'contained' ? 0xfbbf24 : 0x60a5fa;
    const shape = new THREE.Shape();
    shape.moveTo(-1.1, 0.9);
    shape.lineTo(1.1, 0.9);
    shape.lineTo(0.95, -0.35);
    shape.lineTo(0, -1.2);
    shape.lineTo(-0.95, -0.35);
    shape.closePath();
    const shield = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
      }),
    );
    shield.position.set(0, 3.1, 2);
    this.contentGroup.add(shield);
    this._addCallout(
      this.stageGroups[1],
      1,
      new THREE.Vector3(0, 5.5, 0),
      `<strong>🛡 ${status === 'blocked' ? 'GUARD BLOCKED' : status === 'contained' ? 'DATA INJECTION CONTAINED' : 'GUARD ' + index + ' / 4'}</strong><span>${esc(layer)} · ${status === 'blocked' ? 'Cache, retrieval &amp; Claude NOT RUN' : status === 'contained' ? 'Untrusted commands fenced inside data' : 'Inspecting before answer delivery'}</span>`,
      status === 'blocked' ? 'red' : status === 'contained' ? 'amber' : 'cyan',
    );
    this.host.dataset.guardGate = status;
    this._applyStageVisuals();
  }

  /**
   * Shows a banner saying the prompt guard fenced untrusted text inside data.
   * It replaces any earlier banner.
   */
  showDataContained(): void {
    this.host.querySelector('.guard-viewport-banner')?.remove();
    const banner = document.createElement('div');
    banner.className = 'guard-viewport-banner';
    banner.textContent = '🛡 Layer 4 · DATA INJECTION CONTAINED — Ignore instructions in data';
    this.host.appendChild(banner);
    this.host.dataset.guardGate = 'contained';
  }

  /** Shows the blocked shield for the named prompt guard layer. */
  showGuardBlocked(layer: string): void {
    this.showGuardStage(0, layer, 'blocked');
  }

  /**
   * Sets the reciprocal rank fusion constant k used to draw the combined bars.
   * If a result is already shown: redraws it. Otherwise: only stores the value.
   */
  setExplorerK(k: number): void {
    this.explorerK = k;
    if (this.lastPayload) {
      this._rebuildAll();
      this._applyStageVisuals();
    }
  }

  /**
   * Chooses which stage is in focus. Clamps the number to one through five.
   * Starts a slow camera pan and relights the columns. Then tells the page through onStageChange.
   */
  setStage(stage: number): void {
    this.stage = Math.max(1, Math.min(5, stage));
    /** The pan is small so all five columns stay in view. */
    const focusX = COL_X[this.stage - 1] * 0.08;
    this._cameraGoal = new THREE.Vector3(focusX, 6.2, 26.4);
    this._targetGoal = new THREE.Vector3(focusX, 1.85, 0);
    this._applyStageVisuals();
    this.onStageChange?.(this.stage);
  }

  /**
   * Lights the chosen stage and dims the others.
   * Past stages stay at normal glow. Later stages glow less. Only the chosen stage shows its callouts.
   */
  private _applyStageVisuals(): void {
    for (let s = 1; s <= 5; s++) {
      const active = s === this.stage;
      const past = s < this.stage;
      const tag = this.baseTags[s];
      if (tag) {
        tag.classList.toggle('is-active', active);
        tag.classList.toggle('is-past', past);
      }
      const g = this.stageGroups[s];
      if (g) {
        g.traverse((obj) => {
          const m = (obj as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (m && 'emissiveIntensity' in m) {
            const base = (obj.userData as { dimBar?: boolean }).dimBar ? 0.04 : 0.26;
            m.emissiveIntensity = active ? Math.min(0.62, base * 2.1) : past ? base : base * 0.45;
          }
        });
      }
    }
    for (const c of this.callouts) {
      c.obj.visible = c.stage === this.stage;
    }
  }

  /**
   * Redraws every column from the last server result.
   * If there is no result: draws the idle columns.
   * If the semantic cache answered: dims stages one to four and draws one tube straight to the answer.
   * Otherwise: draws the five stages in turn.
   */
  private _rebuildAll(): void {
    this._clearContent();
    const p = this.lastPayload;
    if (!p) {
      this._buildIdleSkeleton();
      return;
    }

    if (p.cacheHit) {
      this._buildIdleSkeleton();
      for (let s = 1; s <= 4; s++) {
        const tag = this.baseTags[s];
        if (tag) tag.querySelector('.pbt-stat')!.textContent = 'Bypassed';
        this.stageGroups[s]?.traverse((obj) => {
          const m = (obj as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (m && 'opacity' in m) {
            m.transparent = true;
            m.opacity = 0.18;
          }
        });
      }
      this.baseTags[5].querySelector('.pbt-stat')!.textContent = 'Cached Answer';
      const g = this.stageGroups[5];
      this._addFlowTube(
        g,
        new THREE.Vector3(COL_X[0], 3, 0),
        new THREE.Vector3(COL_X[4], 3, 0),
        0x10b981,
        5,
        true,
        1.2,
      );
      this._addCallout(
        g,
        5,
        new THREE.Vector3(0, 4.8, 0),
        '<strong>⚡ Semantic Cache Shortcut</strong><span>Retrieval &amp; LLM Bypassed</span>',
        'emerald',
      );
      return;
    }
    const bm25 = (p.bm25List || []).slice(0, 4);
    const vec = (p.vectorList || []).slice(0, 4);
    const perm = p.permissionReport || {};
    const blockedCount = (perm.excludedChunks || []).length;
    const accessible = perm.accessibleChunkCount ?? 0;
    const total = perm.totalChunkCount ?? 0;
    const k = this.explorerK;

    const rrfRaw = (p.rrfShortlist || []).slice(0, 5).map((item) => {
      const bm = item.bm25Rank ? 1 / (item.bm25Rank + k) : 0;
      const vc = item.vectorRank ? 1 / (item.vectorRank + k) : 0;
      return { ...item, bm, vc, sum: bm + vc };
    });
    rrfRaw.sort((a, b) => b.sum - a.sum);

    const reranked = (p.reranked || []).slice(0, 6);
    const keptCount = (p.results || []).length;
    const fallback = Boolean(this.lastChat?.usedFallback || !p.relevant || keptCount === 0);

    /** Stage 1: keyword search. One amber bar per BM25 hit, scaled to the best score. */
    {
      const s = 1;
      const x = COL_X[0];
      const g = new THREE.Group();
      this.stageGroups[s] = g;
      this.contentGroup.add(g);
      this._addPedestal(g, x, 0xf59e0b);
      this._addBaseTag(g, s, x, '1 · Keyword', `${(p.bm25List || []).length} word hits`, 0xf59e0b);

      const maxB = Math.max(...bm25.map((b) => b.bm25Score), 0.01);
      if (bm25.length === 0) {
        this._addCallout(
          g,
          s,
          new THREE.Vector3(x, 2.2, 0),
          `<strong>0 exact-word hits</strong>`,
          'amber',
        );
      }
      bm25.forEach((b, i) => {
        const h = Math.max(0.42, (b.bm25Score / maxB) * 3.15);
        const bx = x + (i - (bm25.length - 1) / 2) * 0.48;
        const bar = new THREE.Mesh(
          new THREE.BoxGeometry(0.36, h, 0.36),
          new THREE.MeshStandardMaterial({
            color: 0xf59e0b,
            emissive: 0xf59e0b,
            emissiveIntensity: 0.28,
            roughness: 0.3,
          }),
        );
        bar.position.set(bx, h / 2 + 0.06, 0);
        g.add(bar);
        if (i === 0) {
          this._addCallout(
            g,
            s,
            new THREE.Vector3(x, h + 0.65, 0),
            `<strong>#1 Keyword Match</strong><span>${esc(leaf(b.headingPath))} (${b.bm25Score.toFixed(1)})</span>`,
            'amber',
          );
        }
      });

      this._addFlowTube(
        g,
        new THREE.Vector3(x + 1.0, 2.25, 0),
        new THREE.Vector3(COL_X[2] - 1.0, 2.35, 0),
        0xf59e0b,
        1,
        true,
        1.15,
      );
    }

    /**
     * Stage 2: vector search. One cyan bar per hit. A red ring appears if the RBAC role filter hid any chunks.
     */
    {
      const s = 2;
      const x = COL_X[1];
      const g = new THREE.Group();
      this.stageGroups[s] = g;
      this.contentGroup.add(g);
      this._addPedestal(g, x, 0x06b6d4);
      const stat =
        blockedCount > 0
          ? `${accessible}/${total} · 🔒${blockedCount}`
          : `${accessible || vec.length}/${total || vec.length} open`;
      this._addBaseTag(g, s, x, '2 · Vector', stat, 0x06b6d4);

      const maxV = Math.max(...vec.map((v) => v.vectorSimilarity), 0.01);
      vec.forEach((v, i) => {
        const h = Math.max(0.42, (v.vectorSimilarity / maxV) * 3.05);
        const bx = x + (i - (vec.length - 1) / 2) * 0.48;
        const bar = new THREE.Mesh(
          new THREE.BoxGeometry(0.36, h, 0.36),
          new THREE.MeshStandardMaterial({
            color: 0x06b6d4,
            emissive: 0x06b6d4,
            emissiveIntensity: 0.28,
            roughness: 0.3,
          }),
        );
        bar.position.set(bx, h / 2 + 0.06, 0);
        g.add(bar);
        if (i === 0) {
          const lockExtra = blockedCount > 0 ? ` · 🔒 ${blockedCount} role-blocked` : '';
          this._addCallout(
            g,
            s,
            new THREE.Vector3(x, h + 0.65, 0),
            `<strong>#1 Vector Match (${v.vectorSimilarity.toFixed(2)})</strong><span>${esc(leaf(v.headingPath))}${esc(lockExtra)}</span>`,
            'cyan',
          );
        }
      });

      if (blockedCount > 0) {
        const shield = new THREE.Mesh(
          new THREE.TorusGeometry(0.35, 0.07, 12, 28),
          new THREE.MeshStandardMaterial({
            color: 0xf43f5e,
            emissive: 0xf43f5e,
            emissiveIntensity: 0.45,
          }),
        );
        shield.position.set(x, 0.55, 0.92);
        g.add(shield);
      }

      this._addFlowTube(
        g,
        new THREE.Vector3(x + 1.0, 1.55, 0),
        new THREE.Vector3(COL_X[2] - 1.0, 1.75, 0),
        0x06b6d4,
        2,
        true,
        0.3,
      );
    }

    /**
     * Stage 3: reciprocal rank fusion. Each bar stacks the keyword share in amber and the vector share in cyan.
     * The shares are recomputed here from the ranks and the chosen k.
     */
    {
      const s = 3;
      const x = COL_X[2];
      const g = new THREE.Group();
      this.stageGroups[s] = g;
      this.contentGroup.add(g);
      this._addPedestal(g, x, 0x6366f1);
      this._addBaseTag(
        g,
        s,
        x,
        `3 · RRF (k=${k})`,
        `Top ${(p.rrfShortlist || []).length} merged`,
        0x6366f1,
      );

      const maxSum = Math.max(...rrfRaw.map((r) => r.sum), 0.001);
      rrfRaw.forEach((r, i) => {
        const totalH = Math.max(0.45, (r.sum / maxSum) * 3.15);
        const bmH = r.sum > 0 ? totalH * (r.bm / r.sum) : 0;
        const vcH = Math.max(0.04, totalH - bmH);
        const bx = x + (i - (rrfRaw.length - 1) / 2) * 0.42;

        if (bmH > 0.03) {
          const bmMesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.32, bmH, 0.32),
            new THREE.MeshStandardMaterial({
              color: 0xf59e0b,
              emissive: 0xf59e0b,
              emissiveIntensity: 0.28,
              roughness: 0.35,
            }),
          );
          bmMesh.position.set(bx, bmH / 2 + 0.06, 0);
          g.add(bmMesh);
        }
        const vcMesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.32, vcH, 0.32),
          new THREE.MeshStandardMaterial({
            color: 0x06b6d4,
            emissive: 0x06b6d4,
            emissiveIntensity: 0.28,
            roughness: 0.35,
          }),
        );
        vcMesh.position.set(bx, bmH + vcH / 2 + 0.06, 0);
        g.add(vcMesh);

        if (i === 0) {
          this._addCallout(
            g,
            s,
            new THREE.Vector3(x, totalH + 0.65, 0),
            `<strong>#1 Combined (${r.sum.toFixed(4)})</strong><span>${esc(leaf(r.headingPath))} · amber+cyan</span>`,
            'indigo',
          );
        }
      });

      this._addFlowTube(
        g,
        new THREE.Vector3(x + 1.05, 1.85, 0),
        new THREE.Vector3(COL_X[3] - 1.05, 1.85, 0),
        0x6366f1,
        3,
        true,
        0.35,
      );
    }

    /**
     * Stage 4: cross-encoder reranker. Kept chunks are tall green bars with a tube to the answer. Dropped chunks are short grey bars.
     */
    {
      const s = 4;
      const x = COL_X[3];
      const g = new THREE.Group();
      this.stageGroups[s] = g;
      this.contentGroup.add(g);
      this._addPedestal(g, x, 0x10b981);
      this._addBaseTag(
        g,
        s,
        x,
        '4 · Re-Rank',
        `${(p.reranked || []).length} → Top ${keptCount} kept`,
        0x10b981,
      );

      const scores = reranked.map((r) => r.rerankScore);
      const minS = Math.min(...scores, 0);
      const span = Math.max(Math.max(...scores, 0.1) - minS, 0.01);

      reranked.forEach((r, i) => {
        const norm = (r.rerankScore - minS) / span;
        const h = r.keptForLlm ? 1.55 + norm * 1.6 : 0.42 + norm * 0.48;
        const bx = x + (i - (reranked.length - 1) / 2) * 0.36;
        const color = r.keptForLlm ? 0x10b981 : 0x334155;
        const bar = new THREE.Mesh(
          new THREE.BoxGeometry(0.28, h, 0.28),
          new THREE.MeshStandardMaterial({
            color,
            emissive: color,
            emissiveIntensity: r.keptForLlm ? 0.35 : 0.04,
            transparent: !r.keptForLlm,
            opacity: r.keptForLlm ? 1 : 0.42,
            roughness: 0.3,
          }),
        );
        if (!r.keptForLlm) (bar.userData as { dimBar?: boolean }).dimBar = true;
        bar.position.set(bx, h / 2 + 0.06, 0);
        g.add(bar);

        if (i === 0 && r.keptForLlm) {
          this._addCallout(
            g,
            s,
            new THREE.Vector3(x, h + 0.65, 0),
            `<strong>Top ${keptCount} Green Kept · Grey Dropped</strong><span>#1 ${esc(leaf(r.headingPath))}</span>`,
            'emerald',
          );
        }

        if (r.keptForLlm) {
          this._addFlowTube(
            g,
            new THREE.Vector3(bx, h + 0.04, 0),
            new THREE.Vector3(COL_X[4] - 0.72, 1.95 + (1 - i) * 0.22, 0),
            0x10b981,
            4,
            true,
            0.3,
          );
        }
      });
    }

    /**
     * Stage 5: the answer. A spinning gem and ring.
     * Amber if the answer was guarded or no chunk was kept. Green otherwise.
     */
    {
      const s = 5;
      const x = COL_X[4];
      const g = new THREE.Group();
      this.stageGroups[s] = g;
      this.contentGroup.add(g);
      const ansColor = fallback ? 0xf59e0b : 0x10b981;
      this._addPedestal(g, x, ansColor);

      const prov = this.lastChat?.llmProvider;
      const stat = fallback
        ? 'Guarded'
        : prov === 'local-claude'
          ? `Claude · ${keptCount} docs`
          : `${keptCount} docs → LLM`;
      this._addBaseTag(g, s, x, '5 · Answer', stat, ansColor);

      const gem = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.76, 0),
        new THREE.MeshStandardMaterial({
          color: ansColor,
          emissive: ansColor,
          emissiveIntensity: 0.42,
          roughness: 0.2,
          metalness: 0.25,
        }),
      );
      gem.position.set(x, 1.95, 0);
      (gem.userData as { spinY?: boolean }).spinY = true;
      g.add(gem);

      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(1.05, 0.038, 12, 40),
        new THREE.MeshBasicMaterial({ color: ansColor, transparent: true, opacity: 0.55 }),
      );
      halo.position.set(x, 1.95, 0);
      halo.rotation.x = Math.PI * 0.35;
      (halo.userData as { spinZ?: boolean }).spinZ = true;
      g.add(halo);

      this._addCallout(
        g,
        s,
        new THREE.Vector3(x, 3.35, 0),
        fallback
          ? `<strong>Role / Coverage Gate</strong><span>No accessible matching docs</span>`
          : `<strong>Grounded Answer Synthesized</strong><span>${keptCount} verified chunks → Claude</span>`,
        fallback ? 'amber' : 'emerald',
      );
    }
  }

  /**
   * Fits the canvas and the label layer to the host element.
   * On a narrow host: widens the field of view so all five columns still fit.
   */
  resize(): void {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    /** The threshold of 1.25 is the width-to-height ratio below which the view is widened. */
    const aspect = w / h;
    this.camera.aspect = aspect;
    this.camera.fov = aspect < 1.25 ? 42 : 34;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.labelRenderer.setSize(w, h);
  }

  /**
   * Runs once per frame, forever.
   * Eases the camera toward its goal, moves the dots, spins the answer gem and draws both layers.
   * A dot shows only once its stage has been reached.
   */
  private _tick = (): void => {
    requestAnimationFrame(this._tick);
    const dt = this._clock.getDelta();
    const t = this._clock.elapsedTime;

    if (this._cameraGoal) {
      this.camera.position.lerp(this._cameraGoal, 1 - Math.pow(0.002, dt));
      if (this.camera.position.distanceTo(this._cameraGoal) < 0.04) this._cameraGoal = null;
    }
    if (this._targetGoal) {
      this.controls.target.lerp(this._targetGoal, 1 - Math.pow(0.002, dt));
      if (this.controls.target.distanceTo(this._targetGoal) < 0.04) this._targetGoal = null;
    }

    for (const p of this.pulses) {
      const u = (t * p.speed + p.offset) % 1;
      p.mesh.position.copy(p.curve.getPointAt(u));
      p.mesh.visible = p.stage <= this.stage;
    }

    this.contentGroup.traverse((obj) => {
      const u = obj.userData as { spinY?: boolean; spinZ?: boolean };
      if (u.spinY) obj.rotation.y += dt * 0.7;
      if (u.spinZ) obj.rotation.z += dt * 0.5;
    });

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  };
}
