/**
 * Why this file exists: the 3D cosine similarity view on the pipeline page.
 * It draws the Query Vector, the selected Chunk Vector and every indexed chunk,
 * and lets the user drag the angle between them. Without it, the user could not
 * see why a small angle means a close match in vector search.
 * Labels use plain English, with no q or d symbols.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

/** The angle the view shows: a matching chunk, an unrelated chunk, or one the user set. */
export type CosinePreset = 'match' | 'unrelated' | 'custom';

/**
 * What the view reports to the page after every change.
 * `thetaDeg` is the angle between the two vectors, in degrees.
 * `cosine` is the cosine of that angle, from 1 at 0 degrees to 0 at 90 degrees.
 * `chunkLabel` is the text shown on the Chunk Vector.
 */
export interface CosineState {
  thetaDeg: number;
  cosine: number;
  preset: CosinePreset;
  chunkLabel: string;
}

/** One indexed chunk to plot. `similarity` is its cosine similarity to the query, from 0 to 1. */
export interface ChunkCloudItem {
  label: string;
  similarity: number;
}

/** Escapes text for label HTML. Chunk text goes into innerHTML, so markup must not run. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Interactive 3D scene that shows cosine similarity as an angle.
 * It owns one WebGL canvas and one label layer inside the host element.
 * The user can orbit the camera, drag the purple handle, or click a chunk dot.
 * Colors: teal is the Query Vector, purple is the selected Chunk Vector, blue is
 * the cloud of indexed chunks, orange is the angle, and grey is a reference arrow.
 */
export class Cosine3D {
  host: HTMLElement;

  /**
   * Called with the new state each time the angle changes. The page sets this to update its text.
   */
  onChange?: (state: CosineState) => void;

  private scene: THREE.Scene;

  private camera: THREE.PerspectiveCamera;

  private renderer: THREE.WebGLRenderer;

  private labels: CSS2DRenderer;

  private controls: OrbitControls;

  private queryArrow: THREE.ArrowHelper;

  private chunkArrow: THREE.ArrowHelper;

  private ghostArrow: THREE.ArrowHelper;

  private handle: THREE.Mesh;

  private arc: THREE.Line;

  private cloudGroup = new THREE.Group();

  private queryLabel!: CSS2DObject;

  private chunkLabelObj!: CSS2DObject;

  private thetaDeg = 21;

  private preset: CosinePreset = 'match';

  private chunkLabel = 'Chunk Vector: selected support section';

  private dragging = false;

  /**
   * Flat floor at height zero. A drag is turned into an angle by finding where the mouse ray hits it.
   */
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private raycaster = new THREE.Raycaster();

  private pointer = new THREE.Vector2();

  /** Handle of the running sweep animation, or null when none runs. */
  private anim: number | null = null;

  /** Handle of the latest render frame. It is stored but never cancelled. */
  private _raf = 0;

  /**
   * Builds the scene inside `host` and starts drawing.
   * Adds a WebGL canvas and a label layer to the host.
   * Listens for pointer presses on the canvas, and for pointer moves and releases on the window.
   * Those window listeners are never removed.
   * Starts at 21 degrees, the matching-chunk example. It runs a frame loop for the life of the page.
   */
  constructor(host: HTMLElement) {
    this.host = host;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070b14);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(4.5, 3.2, 5.5);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    host.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'css2d-layer';
    host.appendChild(this.labels.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0.2, 0);

    this.scene.add(new THREE.AmbientLight(0x99aacc, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1);
    key.position.set(3, 6, 4);
    this.scene.add(key);
    this.scene.add(new THREE.GridHelper(8, 16, 0x2a3a5c, 0x152038));
    this.scene.add(new THREE.AxesHelper(1.2));

    const origin = new THREE.Vector3(0, 0.05, 0);
    this.queryArrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      origin,
      2.2,
      0x37d6c5,
      0.28,
      0.18,
    );
    this.chunkArrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      origin,
      2.2,
      0xc084fc,
      0.28,
      0.18,
    );
    this.ghostArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, 1),
      origin,
      2.0,
      0x64748b,
      0.2,
      0.12,
    );
    this.ghostArrow.cone.material = new THREE.MeshBasicMaterial({
      color: 0x64748b,
      transparent: true,
      opacity: 0.35,
    });
    this.ghostArrow.line.material = new THREE.LineBasicMaterial({
      color: 0x64748b,
      transparent: true,
      opacity: 0.35,
    });
    this.scene.add(this.queryArrow, this.chunkArrow, this.ghostArrow, this.cloudGroup);

    this.handle = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 16, 16),
      new THREE.MeshStandardMaterial({
        color: 0xc084fc,
        emissive: 0xc084fc,
        emissiveIntensity: 0.5,
      }),
    );
    this.scene.add(this.handle);

    const arcGeom = new THREE.BufferGeometry();
    this.arc = new THREE.Line(
      arcGeom,
      new THREE.LineBasicMaterial({ color: 0xffb020, linewidth: 2 }),
    );
    this.scene.add(this.arc);

    this.queryLabel = this._label(
      this.queryArrow.cone,
      `<div class="title">Query Vector: your question</div>`,
      'label-chip vector',
    );
    this.chunkLabelObj = this._label(
      this.chunkArrow.cone,
      `<div class="title">Chunk Vector: selected support section</div>`,
      'label-chip',
    );

    this.renderer.domElement.addEventListener('pointerdown', (e) => this._onDown(e));
    window.addEventListener('pointermove', (e) => this._onMove(e));
    window.addEventListener('pointerup', () => {
      this.dragging = false;
      this.controls.enabled = true;
    });

    this.setTheta(21, 'match', 'Chunk Vector: "ERR_PAYMENT_402 billing declined"');
    this.resize();
    this._tick();
  }

  /** Attaches an HTML label to a 3D object, a little above it. Returns the label. */
  private _label(parent: THREE.Object3D, html: string, cls = 'label-chip'): CSS2DObject {
    const el = document.createElement('div');
    el.className = cls;
    el.innerHTML = html;
    const lab = new CSS2DObject(el);
    lab.position.set(0, 0.25, 0);
    parent.add(lab);
    return lab;
  }

  /** Plot every chunk as a subtle arrow/point around the Query Vector by similarity angle. */
  /**
   * Plots every indexed chunk as a faint arrow and dot around the Query Vector.
   * Each chunk sits at the angle whose cosine equals its similarity.
   * A similarity outside 0 to 1 is clamped, so a negative score shows as 90 degrees.
   * Chunks with higher similarity are longer and brighter.
   * Clears the old cloud first. The user can click a dot to move the Chunk Vector to it.
   * Each dot gets a label with the first 28 characters of the chunk name and its similarity.
   */
  setChunkCloud(items: ChunkCloudItem[]): void {
    while (this.cloudGroup.children.length) {
      const c = this.cloudGroup.children.pop()!;
      this.cloudGroup.remove(c);
    }
    const origin = new THREE.Vector3(0, 0.05, 0);
    items.forEach((item, i) => {
      const sim = Math.min(1, Math.max(0, item.similarity));
      /** Angle in radians whose cosine equals the similarity. */
      const theta = Math.acos(sim);
      /**
       * A small turn around the vertical axis, set by the chunk's position in the list.
       * Without it, chunks with the same similarity would lie on top of each other.
       */
      const yaw = ((i * 47) % 360) * (Math.PI / 180);
      const dir = new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta));
      dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw * 0.15);
      dir.normalize();
      const len = 1.6 + sim * 0.5;
      const arrow = new THREE.ArrowHelper(dir, origin, len, 0x3a4a6a, 0.12, 0.08);
      arrow.line.material = new THREE.LineBasicMaterial({
        color: 0x5b8cff,
        transparent: true,
        opacity: 0.25 + sim * 0.45,
      });
      arrow.cone.material = new THREE.MeshBasicMaterial({
        color: 0x5b8cff,
        transparent: true,
        opacity: 0.3 + sim * 0.5,
      });
      (arrow.userData as { cloudLabel: string; similarity: number }).cloudLabel = item.label;
      (arrow.userData as { cloudLabel: string; similarity: number }).similarity = sim;
      this.cloudGroup.add(arrow);

      const tip = new THREE.Mesh(
        new THREE.SphereGeometry(0.045, 10, 10),
        new THREE.MeshStandardMaterial({
          color: 0x5b8cff,
          emissive: 0x5b8cff,
          emissiveIntensity: 0.25 + sim * 0.4,
        }),
      );
      tip.position.copy(dir.clone().multiplyScalar(len));
      (tip.userData as { pickable: boolean; label: string; sim: number }).pickable = true;
      (tip.userData as { pickable: boolean; label: string; sim: number }).label = item.label;
      (tip.userData as { pickable: boolean; label: string; sim: number }).sim = sim;
      this.cloudGroup.add(tip);
      this._label(
        tip,
        `<div class="meta">${esc(item.label.slice(0, 28))} · ${sim.toFixed(2)}</div>`,
        'label-chip',
      );
    });
  }

  /**
   * Jumps to a preset example.
   * - match: 21 degrees, a payment-error chunk. The grey arrow is set to 88 degrees.
   * - unrelated: 88 degrees, a Single Sign-On chunk. The grey arrow points almost along the query.
   * - custom: only records that the user is in control. The angle stays as it is.
   */
  applyPreset(kind: CosinePreset): void {
    if (kind === 'match') {
      this.setTheta(21, 'match', 'Chunk Vector: "ERR_PAYMENT_402 billing declined"');
      this.ghostArrow.visible = true;
      this.ghostArrow.setDirection(new THREE.Vector3(Math.cos(1.535), 0, Math.sin(1.535)));
    } else if (kind === 'unrelated') {
      this.setTheta(88, 'unrelated', 'Chunk Vector: "Single Sign-On (SSO) certificate rotation"');
      this.ghostArrow.visible = true;
      this.ghostArrow.setDirection(new THREE.Vector3(1, 0, 0.05).normalize());
    } else {
      this.preset = 'custom';
    }
  }

  /**
   * Moves the Chunk Vector to an angle in degrees, clamped to 0 to 180.
   * Redraws the arrow, the handle, the orange arc and the label.
   * Then tells the page through `onChange`.
   * At 0 degrees the cosine is 1, so the chunk points the same way as the question.
   * At 90 degrees the cosine is 0, so the chunk has no relation to the question.
   */
  setTheta(deg: number, preset: CosinePreset = 'custom', label?: string): void {
    this.thetaDeg = Math.max(0, Math.min(180, deg));
    this.preset = preset;
    if (label) this.chunkLabel = label;
    const rad = (this.thetaDeg * Math.PI) / 180;
    const dir = new THREE.Vector3(Math.cos(rad), 0, Math.sin(rad));
    this.chunkArrow.setDirection(dir);
    this.handle.position.set(dir.x * 2.2, 0.05, dir.z * 2.2);
    this._updateArc(rad);
    if (this.chunkLabelObj?.element) {
      this.chunkLabelObj.element.innerHTML = `<div class="title">${esc(this.chunkLabel)}</div>`;
    }
    const cosine = Math.cos(rad);
    this.onChange?.({
      thetaDeg: this.thetaDeg,
      cosine,
      preset: this.preset,
      chunkLabel: this.chunkLabel,
    });
  }

  /**
   * Slides the angle from one value to another over `ms` milliseconds.
   * It starts fast and slows down. A new sweep cancels the one still running.
   * Each frame calls `setTheta`, so the label and the page update as it moves.
   */
  animateSweep(fromDeg: number, toDeg: number, ms = 2000): void {
    if (this.anim) cancelAnimationFrame(this.anim);
    const start = performance.now();
    /** One frame of the sweep. Asks for another frame until the time is up. */
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      const deg = fromDeg + (toDeg - fromDeg) * eased;
      this.setTheta(deg, 'custom', 'Chunk Vector: sweeping toward Query Vector');
      if (t < 1) this.anim = requestAnimationFrame(tick);
      else this.anim = null;
    };
    this.anim = requestAnimationFrame(tick);
  }

  /**
   * Redraws the orange arc that marks the angle between the two vectors.
   * Frees the old arc shape first. Without that, every redraw would leak graphics memory.
   */
  private _updateArc(thetaRad: number): void {
    const pts: THREE.Vector3[] = [];
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const a = (thetaRad * i) / steps;
      pts.push(new THREE.Vector3(Math.cos(a) * 0.9, 0.08, Math.sin(a) * 0.9));
    }
    this.arc.geometry.dispose();
    this.arc.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  }

  /**
   * Handles a press on the canvas.
   * If the press hits a chunk dot: the Chunk Vector jumps to that chunk's angle.
   * If it hits the purple handle: a drag starts and the camera orbit is switched off.
   * Without that, dragging the handle would also spin the camera.
   */
  private _onDown(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    /** Looks for a chunk dot under the pointer. */
    const tips = this.cloudGroup.children.filter(
      (c) => (c.userData as { pickable?: boolean }).pickable,
    );
    const hits = this.raycaster.intersectObjects(tips, false);
    if (hits[0]) {
      const u = hits[0].object.userData as { label: string; sim: number };
      const deg = (Math.acos(Math.min(1, Math.max(0, u.sim))) * 180) / Math.PI;
      this.setTheta(deg, 'custom', `Chunk Vector: ${u.label}`);
      return;
    }

    const hit = this.raycaster.intersectObject(this.handle);
    if (hit.length) {
      this.dragging = true;
      this.controls.enabled = false;
    }
  }

  /**
   * Turns a mouse drag into an angle while the handle is held.
   * Finds where the mouse ray meets the floor, then measures the angle from the Query Vector.
   * The angle is limited to 0 to 90 degrees. The first angle it computes, `clamped`, is never used.
   */
  private _onMove(e: PointerEvent): void {
    if (!this.dragging) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const pt = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(this.plane, pt);
    if (!pt) return;
    const deg = (Math.atan2(pt.z, pt.x) * 180) / Math.PI;
    const clamped = Math.max(
      0,
      Math.min(
        90,
        ((deg % 360) + 360) % 360 > 180
          ? 180 - ((((deg % 360) + 360) % 360) - 180)
          : ((deg % 360) + 360) % 360,
      ),
    );
    /**
     * Angle from the +X axis, using the absolute floor position so it never goes negative.
     * Limited to 0 to 90 degrees to keep the lesson simple.
     */
    let a = Math.atan2(Math.abs(pt.z), Math.max(0.0001, pt.x)) * (180 / Math.PI);
    a = Math.max(0, Math.min(90, a));
    this.setTheta(a, 'custom', 'Chunk Vector: selected support section');
  }

  /** Fits the canvas and label layer to the host size. Call it when the host changes size. */
  resize(): void {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.labels.setSize(w, h);
  }

  /**
   * Draws one frame, then asks for the next one.
   * Updates the camera controls, draws the 3D scene, and draws the labels on top.
   */
  private _tick = (): void => {
    this._raf = requestAnimationFrame(this._tick);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };
}
