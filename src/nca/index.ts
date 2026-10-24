/* SuperParticles Smart Particles — neural cellular automata on the GPU.
 *
 * Optional entry point (`superparticles/nca`): nothing here is loaded by the
 * core particle engine. A trained model grows a pattern from a single seed
 * cell, keeps it stable, and regrows it after damage.
 */

import { loadModel, parseModel, type NCAModel, type NCAModelFile } from './model.js';
import { seedState, fitGrid, type NCABackend, type NCABackendKind, type DrawParams } from './backend.js';
import { NCAGridCPU } from './cpu.js';

export { loadModel, parseModel, NCAGridCPU, seedState };
export { NCAGrid3DCPU } from './cpu3d.js';
export { SwarmCPU, SwarmView, createSwarm, parseSwarm, loadSwarm } from './swarm.js';
export type { SwarmModel, SwarmModelFile, SwarmViewOptions } from './swarm.js';
export type { NCAModel, NCAModelFile, NCABackendKind, DrawParams };

export interface SmartParticlesOptions {
  /** Model URL, parsed model, or raw model file object. */
  model: string | URL | NCAModel | NCAModelFile;
  /** Preferred backend; falls back webgpu → webgl2 → cpu. Default 'auto'. */
  backend?: 'auto' | NCABackendKind;
  /** Grid size; defaults to the size the model was trained on. */
  width?: number;
  height?: number;
  /** Seed for the per-cell update mask. Same seed + same actions = same result. */
  seed?: number;
  /** Update steps per animation frame (default 1). */
  stepsPerFrame?: number;
  /** Dot diameter relative to a grid cell (default 0.9). */
  dotScale?: number;
  autoplay?: boolean;
  reducedMotion?: 'pause' | 'ignore';
  /** Click/drag on the canvas cuts a hole (default true). */
  interactive?: boolean;
  /** Hole radius for interactive damage, in cells (default 6). */
  damageRadius?: number;
}

export class SmartParticles {
  readonly model: NCAModel;
  readonly backend: NCABackendKind;
  readonly width: number;
  readonly height: number;
  seed: number;
  stepsPerFrame: number;
  view: DrawParams;

  private step = 0;
  private raf = 0;
  private running = false;
  private stopped = false;
  private cleanup: Array<() => void> = [];

  private constructor(
    readonly canvas: HTMLCanvasElement,
    private impl: NCABackend,
    model: NCAModel,
    opts: SmartParticlesOptions,
  ) {
    this.model = model;
    this.backend = impl.kind;
    this.width = impl.width;
    this.height = impl.height;
    this.seed = opts.seed ?? 0;
    this.stepsPerFrame = opts.stepsPerFrame ?? 1;
    this.view = { view: 'rgba', channel: 4, dotScale: opts.dotScale ?? 0.9 };
  }

  static async create(canvas: HTMLCanvasElement, opts: SmartParticlesOptions): Promise<SmartParticles> {
    const model = await resolveModel(opts.model);
    const w = opts.width ?? model.width;
    const h = opts.height ?? model.height;
    sizeCanvas(canvas);

    const want = opts.backend ?? 'auto';
    const order: NCABackendKind[] =
      want === 'auto' ? ['webgpu', 'webgl2', 'cpu'] :
      want === 'webgpu' ? ['webgpu', 'webgl2', 'cpu'] :
      want === 'webgl2' ? ['webgl2', 'cpu'] : ['cpu'];

    let impl: NCABackend | null = null;
    for (const kind of order) {
      try {
        impl = await createBackend(kind, canvas, model, w, h);
        break;
      } catch (error) {
        console.warn(`SuperParticles NCA: ${kind} backend unavailable`, error);
      }
    }
    if (!impl) throw new Error('No NCA backend available');

    const sp = new SmartParticles(canvas, impl, model, opts);
    sp.reset();
    sp.watch(opts);
    const reduce = (opts.reducedMotion ?? 'pause') === 'pause' && typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;
    if ((opts.autoplay ?? true) && !reduce) sp.resume();
    return sp;
  }

  // ---- simulation ------------------------------------------------------------

  /** Current step number since the last reset. */
  getStep() {
    return this.step;
  }

  /** Advance exactly `n` steps (works while paused) and redraw. */
  advance(n = 1) {
    this.impl.advance(n, this.step, this.seed);
    this.step += n;
    this.draw();
  }

  /** Clear the grid back to a single seed cell. */
  reset() {
    this.impl.setState(seedState(this.model, this.width, this.height));
    this.step = 0;
    this.draw();
  }

  /** Cut a hole (grid coordinates, radius in cells). */
  damage(cx: number, cy: number, r: number) {
    this.impl.damage(cx, cy, r);
    this.draw();
  }

  /** Cut a hole at a point given in CSS pixels relative to the canvas. */
  damageAtClient(x: number, y: number, r: number) {
    const g = this.clientToGrid(x, y);
    this.damage(g.x, g.y, r);
  }

  clientToGrid(x: number, y: number) {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / Math.max(1, rect.width);
    const fit = fitGrid(this.canvas, this.width, this.height);
    return { x: ((x - rect.left) * dpr - fit.ox) / fit.cell - 0.5, y: ((y - rect.top) * dpr - fit.oy) / fit.cell - 0.5 };
  }

  /**
   * Replace the full state (channel-major C×H×W), e.g. to restore a saved
   * scene. Pass the step it was saved at to continue the exact same replay.
   */
  setState(state: Float32Array, step = 0) {
    if (state.length !== this.model.channels * this.width * this.height) throw new Error('State has the wrong size');
    this.impl.setState(state);
    this.step = step;
    this.draw();
  }

  /** Full state, channel-major (C×H×W). */
  readState() {
    return this.impl.readState();
  }

  /** Visible RGBA (premultiplied) + alive mask summary. */
  async snapshot() {
    const s = await this.readState();
    const plane = this.width * this.height;
    let alive = 0;
    for (let i = 0; i < plane; i++) if (s[3 * plane + i] > this.model.aliveThreshold) alive++;
    return { rgba: s.subarray(0, 4 * plane), alive, step: this.step };
  }

  /** Show the visible colours, or one hidden channel as a heat map. */
  setView(view: 'rgba' | 'hidden', channel = this.view.channel) {
    this.view = { ...this.view, view, channel };
    this.draw();
  }

  // ---- lifecycle ---------------------------------------------------------------

  get paused() {
    return !this.running;
  }

  resume() {
    if (this.running || this.stopped) return;
    this.running = true;
    this.raf = requestAnimationFrame(this.frame);
  }

  pause() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  stop() {
    if (this.stopped) return;
    this.pause();
    this.stopped = true;
    this.cleanup.forEach(fn => fn());
    this.impl.destroy();
  }

  private frame = () => {
    if (!this.running) return;
    this.advance(this.stepsPerFrame);
    this.raf = requestAnimationFrame(this.frame);
  };

  private draw() {
    if (!this.stopped) this.impl.draw(this.view);
  }

  private watch(opts: SmartParticlesOptions) {
    const onResize = () => {
      sizeCanvas(this.canvas);
      this.impl.resize?.();
      this.draw();
    };
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(onResize);
      ro.observe(this.canvas);
      this.cleanup.push(() => ro.disconnect());
    }
    if (typeof document !== 'undefined') {
      let hiddenPause = false;
      const onVis = () => {
        if (document.hidden && this.running) { hiddenPause = true; this.pause(); }
        else if (!document.hidden && hiddenPause) { hiddenPause = false; this.resume(); }
      };
      document.addEventListener('visibilitychange', onVis);
      this.cleanup.push(() => document.removeEventListener('visibilitychange', onVis));
    }
    if (opts.interactive ?? true) {
      const r = opts.damageRadius ?? 6;
      let down = false;
      const cut = (e: PointerEvent) => this.damageAtClient(e.clientX, e.clientY, r);
      const onDown = (e: PointerEvent) => { down = true; cut(e); };
      const onMove = (e: PointerEvent) => { if (down) cut(e); };
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

/** Create a Smart Particles view on `canvas`. */
export function createSmartParticles(canvas: HTMLCanvasElement, opts: SmartParticlesOptions) {
  return SmartParticles.create(canvas, opts);
}

async function resolveModel(m: SmartParticlesOptions['model']): Promise<NCAModel> {
  if (typeof m === 'string' || m instanceof URL) return loadModel(m);
  if ('format' in m) return parseModel(m);
  return m;
}

function sizeCanvas(c: HTMLCanvasElement) {
  const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1;
  const w = Math.max(1, Math.round((c.clientWidth || 300) * dpr));
  const h = Math.max(1, Math.round((c.clientHeight || 300) * dpr));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
}

async function createBackend(kind: NCABackendKind, canvas: HTMLCanvasElement, model: NCAModel, w: number, h: number): Promise<NCABackend> {
  if (kind === 'webgpu') {
    if (typeof navigator === 'undefined' || !navigator.gpu) throw new Error('WebGPU not supported');
    // Probe presentation on a throwaway canvas first so failure leaves `canvas` usable
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU adapter unavailable');
    const device = await adapter.requestDevice();
    try {
      await probe(device);
    } catch (e) {
      device.destroy();
      throw e;
    }
    const { createWebGPUNCA } = await import('./webgpu.js');
    return createWebGPUNCA(canvas, model, w, h, { device, ownsDevice: true });
  }
  if (kind === 'webgl2') {
    const { createWebGL2NCA } = await import('./webgl2.js');
    return createWebGL2NCA(canvas, model, w, h);
  }
  return createCPUBackend(canvas, model, w, h);
}

async function probe(device: GPUDevice) {
  if (typeof OffscreenCanvas === 'undefined') return;
  const ctx = new OffscreenCanvas(1, 1).getContext('webgpu');
  if (!ctx) throw new Error('WebGPU canvas context unavailable');
  ctx.configure({ device, format: navigator.gpu!.getPreferredCanvasFormat(), alphaMode: 'premultiplied' });
  const enc = device.createCommandEncoder();
  enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] }).end();
  device.queue.submit([enc.finish()]);
  await device.queue.onSubmittedWorkDone();
  ctx.unconfigure();
}

/** CPU reference wrapped as a backend, drawn with Canvas2D. Slow, but runs everywhere. */
function createCPUBackend(canvas: HTMLCanvasElement, model: NCAModel, w: number, h: number): NCABackend {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  const grid = new NCAGridCPU(model, { width: w, height: h });
  const plane = w * h;
  return {
    kind: 'cpu',
    width: w,
    height: h,
    advance(n, step, seed) {
      grid.step = step;
      grid.seed = seed;
      grid.advance(n);
    },
    setState(s) { grid.state.set(s); },
    async readState() { return grid.state.slice(); },
    damage(cx, cy, r) { grid.damage(cx, cy, r); },
    draw(p) {
      const fit = fitGrid(canvas, w, h);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const s = grid.state;
      for (let i = 0; i < plane; i++) {
        const a = Math.min(1, Math.max(0, s[3 * plane + i]));
        if (a <= model.aliveThreshold) continue;
        let r: number, g: number, b: number;
        if (p.view === 'rgba') {
          r = s[i] / a; g = s[plane + i] / a; b = s[2 * plane + i] / a;
        } else {
          const t = Math.min(1, Math.max(0, 0.5 + 0.5 * Math.tanh(s[p.channel * plane + i])));
          const k = 0.4 + 0.6 * Math.abs(t * 2 - 1);
          r = (0.15 + 0.85 * t) * k; g = 0.35 * k; b = (1 - 0.85 * t) * k;
        }
        const x = i % w, y = (i / w) | 0;
        const rad = 0.5 * fit.cell * p.dotScale * (0.55 + 0.45 * a);
        ctx.globalAlpha = p.view === 'rgba' ? a : 1;
        ctx.fillStyle = `rgb(${clamp255(r)},${clamp255(g)},${clamp255(b)})`;
        ctx.beginPath();
        ctx.arc(fit.ox + (x + 0.5) * fit.cell, fit.oy + (y + 0.5) * fit.cell, rad, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    },
    destroy() {},
  };
}

const clamp255 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
