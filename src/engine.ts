/* SuperParticles – Engine: owns one simulation, its plugins, a renderer and the frame loop */

import { Simulation, dt } from './core.js';
import { PluginHost, loadPlugins } from './plugin.js';
import type { Renderer, RendererKind, RenderContext, Style, View } from './render.js';

export interface Options {
  color?: string;
  speed?: number;
  useWebGL?: boolean;
  useWebGPU?: boolean;
  particleCount?: number;
  /** Particle size in CSS pixels. */
  particleSize?: number;
  deterministic?: boolean;
  /**
   * Fixed simulation area in world units. When set, the scene is scaled to fit
   * the canvas, so the same seed produces the same motion on every screen.
   * When omitted, the world follows the canvas size in CSS pixels.
   */
  world?: { width: number; height: number } | null;
  /** Start the frame loop immediately (default true). */
  autoplay?: boolean;
  /**
   * What to do when the viewer has asked for reduced motion
   * (prefers-reduced-motion). 'pause' (default) draws one still frame and waits
   * for resume(); 'ignore' animates anyway.
   */
  reducedMotion?: 'pause' | 'ignore';
  /** Stop simulating while the page is hidden (default true). */
  pauseWhenHidden?: boolean;
  /** Called if the GPU device is lost; the engine stops drawing. */
  onRendererLost?: (reason: string) => void;
}

export type EngineState = Required<Pick<Options,
  'color' | 'speed' | 'useWebGL' | 'useWebGPU' | 'particleCount' | 'particleSize' | 'deterministic'>>;

export const defaults: EngineState = {
  color: '#70c1ff',
  speed: 40,
  useWebGL: false,
  useWebGPU: false,
  particleCount: 1000,
  particleSize: 2,
  deterministic: false,
};

const MAX_STEPS_PER_FRAME = 8; // after a long stall, drop time rather than freeze catching up

export class Engine {
  readonly sim = new Simulation();
  readonly plugins = new PluginHost();
  renderer!: RendererKind;

  private impl!: Renderer;
  private readonly style: Style;
  private readonly view: View = { sx: 1, sy: 1, ox: 0, oy: 0, dpr: 1 };
  private opts: EngineState;
  private world: { width: number; height: number } | null;
  private raf = 0;
  private acc = 0;
  private prev = 0;
  private running = false;
  private stopped = false;
  private hiddenPause = false;
  private cleanup: Array<() => void> = [];

  private constructor(readonly canvas: HTMLCanvasElement, private readonly options: Options) {
    this.opts = { ...defaults, ...pick(options) };
    this.style = { color: this.opts.color, size: this.opts.particleSize };
    this.world = options.world ?? null;
  }

  /** Create an engine on `canvas`. Falls back WebGPU → WebGL2 → Canvas2D. */
  static async create(canvas: HTMLCanvasElement, options: Options = {}): Promise<Engine> {
    const engine = new Engine(canvas, options);
    await engine.start();
    return engine;
  }

  private async start() {
    this.measure();
    this.sim.reset({
      w: this.sim.bounds.w, h: this.sim.bounds.h,
      speed: this.opts.speed, deterministic: this.opts.deterministic, count: this.opts.particleCount,
    });

    const rc: RenderContext = { canvas: this.canvas, sim: this.sim, plugins: this.plugins, style: this.style, view: this.view };
    const want = this.opts;
    let impl: Renderer | null = null;

    if (want.useWebGPU && typeof navigator !== 'undefined' && navigator.gpu) {
      try {
        const { createWebGPU } = await import('./drawGPU.js');
        impl = await createWebGPU(rc, reason => this.lost(reason));
        this.renderer = 'webgpu';
      } catch (error) {
        console.warn('SuperParticles: WebGPU unavailable, falling back', error);
      }
    }
    if (!impl && (want.useWebGL || want.useWebGPU)) {
      try {
        const { createWebGL2 } = await import('./drawGL.js');
        impl = createWebGL2(rc);
        this.renderer = 'webgl2';
      } catch (error) {
        console.warn('SuperParticles: WebGL2 unavailable, falling back', error);
      }
    }
    if (!impl) {
      const { createCanvas2D } = await import('./draw2d.js');
      impl = createCanvas2D(rc);
      this.renderer = 'canvas2d';
    }
    this.impl = impl;
    this.impl.resize?.();

    this.watchSize();
    this.watchVisibility();

    await loadPlugins();

    this.impl.draw();
    const reduce = (this.options.reducedMotion ?? 'pause') === 'pause' && prefersReducedMotion();
    if ((this.options.autoplay ?? true) && !reduce) this.resume();
  }

  // ---- lifecycle -----------------------------------------------------------

  get paused() {
    return !this.running;
  }

  resume() {
    if (this.running || this.stopped) return;
    this.running = true;
    this.prev = performance.now();
    this.acc = 0;
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
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.impl?.destroy();
  }

  private lost(reason: string) {
    console.warn('SuperParticles: GPU device lost:', reason);
    this.pause();
    this.options.onRendererLost?.(reason);
  }

  private frame = (now: number) => {
    if (!this.running) return;
    this.acc += now - this.prev;
    this.prev = now;
    let steps = Math.floor(this.acc / (dt * 1000));
    if (steps > MAX_STEPS_PER_FRAME) {
      steps = MAX_STEPS_PER_FRAME;
      this.acc = 0;
    } else {
      this.acc -= steps * dt * 1000;
    }
    if (steps) this.sim.advance(steps);
    this.impl.draw();
    this.raf = requestAnimationFrame(this.frame);
  };

  /** Advance exactly `n` steps (works while paused) and redraw. */
  step(n = 1) {
    this.sim.advance(n);
    if (!this.stopped) this.impl.draw();
  }

  getStep() {
    return this.sim.step;
  }

  /** Hash of the exact particle state, for replay checks. */
  stateHash() {
    return this.sim.stateHash();
  }

  // ---- options -------------------------------------------------------------

  setOptions(next: Options) {
    const o = this.opts;
    if (next.speed !== undefined && next.speed !== o.speed) {
      o.speed = next.speed;
      this.sim.setSpeed(next.speed);
    }
    if (next.particleCount !== undefined && next.particleCount !== o.particleCount) {
      o.particleCount = next.particleCount;
      this.sim.resize(next.particleCount);
    }
    if (next.deterministic !== undefined && next.deterministic !== o.deterministic) {
      o.deterministic = next.deterministic;
      this.sim.reset({ deterministic: next.deterministic });
    }
    if (next.color !== undefined) o.color = this.style.color = next.color;
    if (next.particleSize !== undefined) o.particleSize = this.style.size = next.particleSize;
    if (next.useWebGL !== undefined) o.useWebGL = next.useWebGL;
    if (next.useWebGPU !== undefined) o.useWebGPU = next.useWebGPU;
    if (next.world !== undefined) {
      this.world = next.world;
      this.measure();
    }
    if (this.paused && !this.stopped) this.impl.draw();
  }

  exportState(): EngineState {
    return { ...this.opts };
  }

  importState(state: Options) {
    this.setOptions(state);
  }

  /** Re-scatter particles from the seed and reset the step counter. */
  reset() {
    this.sim.reset();
    if (!this.stopped) this.impl.draw();
  }

  // ---- plugins -------------------------------------------------------------

  setPluginEnabled(type: 'force' | 'shader', id: string, enabled: boolean) {
    this.plugins.setEnabled(type, id, enabled);
    this.sim.forces = this.plugins.forces;
  }

  disablePlugin(id: string) {
    this.plugins.disable(id);
    this.sim.forces = this.plugins.forces;
  }

  getPluginState() {
    return this.plugins.state();
  }

  // ---- sizing --------------------------------------------------------------

  /** Sync canvas backing size and the world → pixel transform. */
  private measure() {
    const c = this.canvas;
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1;
    const cssW = c.clientWidth || (typeof innerWidth === 'number' ? innerWidth : 800);
    const cssH = c.clientHeight || (typeof innerHeight === 'number' ? innerHeight : 600);
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }

    const v = this.view;
    v.dpr = dpr;
    if (this.world) {
      // fit (letterbox) the fixed world into the canvas
      const s = Math.min(pw / this.world.width, ph / this.world.height);
      v.sx = v.sy = s;
      v.ox = (pw - this.world.width * s) / 2;
      v.oy = (ph - this.world.height * s) / 2;
      this.sim.setBounds(this.world.width, this.world.height);
    } else {
      v.sx = v.sy = dpr;
      v.ox = v.oy = 0;
      this.sim.setBounds(cssW, cssH);
    }
  }

  private watchSize() {
    const onResize = () => {
      this.measure();
      this.impl.resize?.();
      if (this.paused && !this.stopped) this.impl.draw();
    };
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(onResize);
      ro.observe(this.canvas);
      this.cleanup.push(() => ro.disconnect());
    } else {
      addEventListener('resize', onResize);
      this.cleanup.push(() => removeEventListener('resize', onResize));
    }
  }

  private watchVisibility() {
    if ((this.options.pauseWhenHidden ?? true) === false || typeof document === 'undefined') return;
    const onVis = () => {
      if (document.hidden && this.running) {
        this.hiddenPause = true;
        this.pause();
      } else if (!document.hidden && this.hiddenPause) {
        this.hiddenPause = false;
        this.resume();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    this.cleanup.push(() => document.removeEventListener('visibilitychange', onVis));
  }
}

function pick(o: Options): Partial<EngineState> {
  const out: Partial<EngineState> = {};
  for (const k of Object.keys(defaults) as Array<keyof EngineState>) {
    if (o[k] !== undefined) (out as Record<string, unknown>)[k] = o[k];
  }
  return out;
}

function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
