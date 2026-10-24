/* Free-moving smart particles: a learned swarm (research prototype).
 *
 * Unlike the grid NCA, every particle has a position and a state. It senses
 * the particles within `radius`, and one shared network outputs a state change
 * and a velocity. Matches training/swarm.py exactly (tested against PyTorch).
 * Positions are in [-1, 1]²; y points down.
 */

import { base64ToBytes, fires, halfToFloat } from './model.js';

export interface SwarmModelFile {
  format: 'superparticles-swarm';
  version: 1;
  name: string;
  particles: number;
  channels: number;
  hidden: number;
  radius: number;
  speed: number;
  /** States are clamped to ±stateLimit after each update (default 3). */
  stateLimit?: number;
  /** Pull toward the centre per step, as a fraction of position (default 0). */
  tether?: number;
  /** Positions are clamped to ±bound (default 1). */
  bound?: number;
  fireRate: number;
  dtype: 'float16' | 'float32';
  weights: Record<'w1' | 'b1' | 'w2', { shape: number[]; data: string }>;
  sha256: string;
  metrics?: Record<string, unknown> | null;
}

export interface SwarmModel {
  name: string;
  particles: number;
  channels: number;
  hidden: number;
  radius: number;
  speed: number;
  stateLimit: number;
  tether: number;
  bound: number;
  fireRate: number;
  w1: Float32Array; // (hidden, 4C + 1)
  b1: Float32Array; // (hidden)
  w2: Float32Array; // (C + 2, hidden)
  metrics?: Record<string, unknown> | null;
}

export function parseSwarm(doc: SwarmModelFile): SwarmModel {
  if (doc.format !== 'superparticles-swarm') throw new Error('Not a SuperParticles swarm model');
  if (doc.version !== 1) throw new Error(`Unsupported swarm model version ${doc.version}`);
  const C = doc.channels, H = doc.hidden;
  const read = (k: 'w1' | 'b1' | 'w2', shape: number[]) => {
    const t = doc.weights[k];
    if (t.shape.join() !== shape.join()) throw new Error(`Weight ${k} has shape ${t.shape}, expected ${shape}`);
    const bytes = base64ToBytes(t.data);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = shape.reduce((a, b) => a * b, 1);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = doc.dtype === 'float16' ? halfToFloat(view.getUint16(i * 2, true)) : view.getFloat32(i * 4, true);
    return out;
  };
  return {
    name: doc.name, particles: doc.particles, channels: C, hidden: H,
    radius: doc.radius, speed: doc.speed, stateLimit: doc.stateLimit ?? 3, tether: doc.tether ?? 0, bound: doc.bound ?? 1, fireRate: doc.fireRate,
    w1: read('w1', [H, 4 * C + 1]), b1: read('b1', [H]), w2: read('w2', [C + 2, H]),
    metrics: doc.metrics,
  };
}

export async function loadSwarm(url: string | URL): Promise<SwarmModel> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load swarm model (${res.status})`);
  return parseSwarm(await res.json());
}

/** CPU swarm simulation. O(N²) neighbour search: fine for the few hundred particles it is trained with. */
export class SwarmCPU {
  readonly n: number;
  readonly C: number;
  pos: Float32Array;   // (N, 2)
  state: Float32Array; // (N, C)
  step = 0;
  seed: number;

  private nextPos: Float32Array;
  private nextState: Float32Array;
  private inp: Float64Array;
  private hid: Float64Array;

  constructor(readonly model: SwarmModel, opts: { particles?: number; seed?: number } = {}) {
    this.n = opts.particles ?? model.particles;
    this.C = model.channels;
    this.seed = opts.seed ?? 0;
    this.pos = new Float32Array(this.n * 2);
    this.state = new Float32Array(this.n * this.C);
    this.nextPos = new Float32Array(this.n * 2);
    this.nextState = new Float32Array(this.n * this.C);
    this.inp = new Float64Array(4 * this.C + 1);
    this.hid = new Float64Array(model.hidden);
    this.reset();
  }

  /** Back to a tight random blob in the centre (deterministic for a given seed). */
  reset(spread = 0.08) {
    for (let i = 0; i < this.n; i++) {
      const [a, b] = gauss2(this.seed, i);
      this.pos[2 * i] = a * spread;
      this.pos[2 * i + 1] = b * spread;
      for (let c = 0; c < this.C; c++) this.state[i * this.C + c] = c === 3 ? 1 : 0;
    }
    this.step = 0;
  }

  /**
   * Push the particles within `r` of (x, y) up to `push` away in random directions
   * (positions in [-1, 1]). This matches the damage used in training, which keeps
   * particles within sensing range of the swarm so they can find their way back.
   */
  scatter(x: number, y: number, r: number, push = 0.35) {
    let k = 0;
    for (let i = 0; i < this.n; i++) {
      const dx = this.pos[2 * i] - x, dy = this.pos[2 * i + 1] - y;
      if (dx * dx + dy * dy >= r * r) continue;
      const ang = hash01(this.seed ^ 0x9e3779b9, i, this.step, k++) * 2 * Math.PI;
      const rad = push * Math.sqrt(hash01(this.seed ^ 0x7f4a7c15, i, this.step, k++));
      this.pos[2 * i] = Math.min(1, Math.max(-1, this.pos[2 * i] + Math.cos(ang) * rad));
      this.pos[2 * i + 1] = Math.min(1, Math.max(-1, this.pos[2 * i + 1] + Math.sin(ang) * rad));
    }
  }

  advance(n = 1) {
    for (let i = 0; i < n; i++) this.stepOnce();
  }

  private stepOnce() {
    const { n, C, model, pos, state, nextPos, nextState, inp, hid } = this;
    const R = model.radius, H = model.hidden, P = 4 * C + 1;
    const { w1, b1, w2 } = model;
    nextPos.set(pos);
    nextState.set(state);
    for (let i = 0; i < n; i++) {
      if (!fires(i, 0, this.step, this.seed, model.fireRate)) continue;
      const xi = pos[2 * i], yi = pos[2 * i + 1];
      inp.fill(0);
      let wsum = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const ox = pos[2 * j] - xi, oy = pos[2 * j + 1] - yi;
        const d = Math.sqrt(ox * ox + oy * oy);
        if (d >= R) continue;
        const t = 1 - d / R;
        const w = t * t;
        wsum += w;
        const gx = (w * ox) / R, gy = (w * oy) / R;
        for (let c = 0; c < C; c++) {
          const s = state[j * C + c];
          inp[C + c] += w * s;
          inp[2 * C + c] += gx * s;
          inp[3 * C + c] += gy * s;
        }
      }
      const norm = Math.max(wsum, 1e-6);
      for (let c = 0; c < C; c++) {
        inp[c] = state[i * C + c];
        inp[C + c] /= norm;
        inp[2 * C + c] /= norm;
        inp[3 * C + c] /= norm;
      }
      inp[4 * C] = Math.log1p(wsum);
      for (let h = 0; h < H; h++) {
        let s = b1[h];
        const row = h * P;
        for (let k = 0; k < P; k++) s += w1[row + k] * inp[k];
        hid[h] = s > 0 ? s : 0;
      }
      for (let o = 0; o < C + 2; o++) {
        let s = 0;
        const row = o * H;
        for (let h = 0; h < H; h++) s += w2[row + h] * hid[h];
        if (o < C) nextState[i * C + o] = Math.min(model.stateLimit, Math.max(-model.stateLimit, state[i * C + o] + s));
        else {
          const k = 2 * i + (o - C);
          const b = model.bound;
          nextPos[k] = Math.min(b, Math.max(-b, pos[k] + model.speed * Math.tanh(s) - model.tether * pos[k]));
        }
      }
    }
    this.pos.set(nextPos);
    this.state.set(nextState);
    this.step++;
  }
}

// Deterministic pseudo-random helpers based on the shared hash
function hash01(seed: number, a: number, b: number, c: number) {
  let h = Math.imul(a, 0x8da6b343) ^ Math.imul(b, 0xd8163841) ^ Math.imul(c, 0xcb1ab31f) ^ seed;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return ((h >>> 8) + 0.5) / (1 << 24);
}
function gauss2(seed: number, i: number): [number, number] {
  const u = hash01(seed, i, 1, 0), v = hash01(seed, i, 2, 0);
  const r = Math.sqrt(-2 * Math.log(u));
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
}

export interface SwarmViewOptions {
  model: string | URL | SwarmModel | SwarmModelFile;
  particles?: number;
  seed?: number;
  stepsPerFrame?: number;
  /** Dot radius in CSS pixels (default scales with the canvas). */
  dotSize?: number;
  autoplay?: boolean;
  reducedMotion?: 'pause' | 'ignore';
  /** Click/drag scatters nearby particles (default true). */
  interactive?: boolean;
}

/** A Canvas2D view of a learned swarm with click-to-scatter. */
export class SwarmView {
  readonly sim: SwarmCPU;
  stepsPerFrame: number;
  private raf = 0;
  private running = false;
  private stopped = false;
  private cleanup: Array<() => void> = [];
  private ctx: CanvasRenderingContext2D;

  private constructor(readonly canvas: HTMLCanvasElement, model: SwarmModel, private opts: SwarmViewOptions) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D unavailable');
    this.ctx = ctx;
    this.sim = new SwarmCPU(model, { particles: opts.particles, seed: opts.seed });
    this.stepsPerFrame = opts.stepsPerFrame ?? 1;
  }

  static async create(canvas: HTMLCanvasElement, opts: SwarmViewOptions) {
    const m = opts.model;
    const model = typeof m === 'string' || m instanceof URL ? await loadSwarm(m) : 'format' in m ? parseSwarm(m) : m;
    const view = new SwarmView(canvas, model, opts);
    view.watch();
    view.draw();
    const reduce = (opts.reducedMotion ?? 'pause') === 'pause' && typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;
    if ((opts.autoplay ?? true) && !reduce) view.resume();
    return view;
  }

  get paused() { return !this.running; }
  resume() {
    if (this.running || this.stopped) return;
    this.running = true;
    this.raf = requestAnimationFrame(this.frame);
  }
  pause() { this.running = false; cancelAnimationFrame(this.raf); }
  stop() {
    if (this.stopped) return;
    this.pause();
    this.stopped = true;
    this.cleanup.forEach(f => f());
  }
  advance(n = 1) { this.sim.advance(n); this.draw(); }
  reset() { this.sim.reset(); this.draw(); }

  /** Map a client (CSS px) point to swarm coordinates. */
  toSwarm(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    const s = Math.min(rect.width, rect.height) / 2.2;
    return { x: (clientX - rect.left - rect.width / 2) / s, y: (clientY - rect.top - rect.height / 2) / s };
  }

  scatterAtClient(x: number, y: number, r = 0.3) {
    const p = this.toSwarm(x, y);
    this.sim.scatter(p.x, p.y, r);
    this.draw();
  }

  private frame = () => {
    if (!this.running) return;
    this.advance(this.stepsPerFrame);
    this.raf = requestAnimationFrame(this.frame);
  };

  draw() {
    const c = this.canvas, g = this.ctx;
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1;
    const w = Math.max(1, Math.round((c.clientWidth || 300) * dpr)), h = Math.max(1, Math.round((c.clientHeight || 300) * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    const s = Math.min(w, h) / 2.2;
    const r = (this.opts.dotSize ?? Math.max(1.5, s * 0.018)) * (this.opts.dotSize ? dpr : 1);
    const { pos, state, n, C } = this.sim;
    for (let i = 0; i < n; i++) {
      const col = (k: number) => Math.round(Math.min(1, Math.max(0, state[i * C + k])) * 255);
      g.fillStyle = `rgb(${col(0)},${col(1)},${col(2)})`;
      g.beginPath();
      g.arc(w / 2 + pos[2 * i] * s, h / 2 + pos[2 * i + 1] * s, r, 0, Math.PI * 2);
      g.fill();
    }
  }

  private watch() {
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.draw());
      ro.observe(this.canvas);
      this.cleanup.push(() => ro.disconnect());
    }
    if (this.opts.interactive ?? true) {
      let down = false;
      const onDown = (e: PointerEvent) => { down = true; this.scatterAtClient(e.clientX, e.clientY); };
      const onMove = (e: PointerEvent) => { if (down) this.scatterAtClient(e.clientX, e.clientY, 0.2); };
      const onUp = () => { down = false; };
      this.canvas.addEventListener('pointerdown', onDown);
      this.canvas.addEventListener('pointermove', onMove);
      addEventListener('pointerup', onUp);
      this.cleanup.push(() => {
        this.canvas.removeEventListener('pointerdown', onDown);
        this.canvas.removeEventListener('pointermove', onMove);
        removeEventListener('pointerup', onUp);
      });
    }
  }
}

export function createSwarm(canvas: HTMLCanvasElement, opts: SwarmViewOptions) {
  return SwarmView.create(canvas, opts);
}
