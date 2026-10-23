/* SuperParticles – Public Façade */

import { loadPlugins, setPluginEnabled, getPluginState, disablePlugin, registerPlugin } from './plugin.js';
import { resizeParticleBuffers, resetParticles, setSpeed, style } from './core.js';

// Re-export types for third-party plugin authors
export type { Vec2, Bounds, ForceFn, ShaderSource, ParticlePlugin, PluginOptions, ShaderPlugin } from './types/plugin.js';

// Re-export plugin management functions
export { setPluginEnabled, getPluginState, registerPlugin };

export type RendererKind = 'canvas2d' | 'webgl2' | 'webgpu';

export type EngineHandle = {
  /** The renderer actually in use (may differ from the one requested if it was unavailable). */
  renderer: RendererKind;
  stop: () => void;
  disablePlugin: (id: string) => void;
};

export interface Options {
  color?: string;
  speed?: number;
  useWebGL?: boolean;
  useWebGPU?: boolean;
  particleCount?: number;
  /** Particle size in CSS pixels. */
  particleSize?: number;
  deterministic?: boolean;
}

const defaults: Required<Options> = {
  color: '#70c1ff',
  speed: 40,
  useWebGL: false,
  useWebGPU: false,
  particleCount: 1000,
  particleSize: 2,
  deterministic: false,
};

let opts: Required<Options> = { ...defaults };
let running = false;
let generation = 0;

/** Update options. Color, size, speed, count and deterministic apply live. */
export function setOptions(next: Options) {
  if (next.speed !== undefined) {
    opts.speed = next.speed;
    if (running) setSpeed(next.speed);
  }
  if (next.particleCount !== undefined && next.particleCount !== opts.particleCount) {
    opts.particleCount = next.particleCount;
    if (running) resizeParticleBuffers(next.particleCount);
  }
  if (next.deterministic !== undefined && next.deterministic !== opts.deterministic) {
    opts.deterministic = next.deterministic;
    if (running) resetParticles(next.deterministic);
  }
  if (next.color !== undefined) opts.color = style.color = next.color;
  if (next.particleSize !== undefined) opts.particleSize = style.size = next.particleSize;
  if (next.useWebGL !== undefined) opts.useWebGL = next.useWebGL;
  if (next.useWebGPU !== undefined) opts.useWebGPU = next.useWebGPU;
}

export function exportState(): Required<Options> {
  return { ...opts };
}

export function importState(state: Options) {
  setOptions(state);
}

/**
 * Start rendering into `canvas`. Falls back WebGPU → WebGL2 → Canvas2D when a
 * renderer is unavailable; check `handle.renderer` for the one in use.
 *
 * A canvas keeps the first context type it is given, so to switch renderers
 * pass a fresh canvas element.
 */
export async function init(canvas: HTMLCanvasElement, options: Options = {}): Promise<EngineHandle> {
  opts = { ...defaults, ...options };
  style.color = opts.color;
  style.size = opts.particleSize;

  const cfg = { speed: opts.speed, deterministic: opts.deterministic, particleCount: opts.particleCount };
  let renderer: { stop: () => void } | null = null;
  let kind: RendererKind = 'canvas2d';

  if (opts.useWebGPU && typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const { drawGPU } = await import('./drawGPU.js');
      renderer = await drawGPU(canvas, cfg);
      kind = 'webgpu';
    } catch (error) {
      console.warn('SuperParticles: WebGPU unavailable, falling back', error);
    }
  }
  if (!renderer && (opts.useWebGL || opts.useWebGPU)) {
    try {
      const { initWebGL2 } = await import('./drawGL.js');
      renderer = initWebGL2(canvas, cfg);
      kind = 'webgl2';
    } catch (error) {
      console.warn('SuperParticles: WebGL2 unavailable, falling back', error);
    }
  }
  if (!renderer) {
    const { initCanvas2D } = await import('./draw2d.js');
    renderer = initCanvas2D(canvas, cfg);
    kind = 'canvas2d';
  }
  running = true;
  const myGeneration = ++generation;

  // Load plugins after first paint
  await loadPlugins({ deterministic: opts.deterministic });

  const active = renderer;
  return {
    renderer: kind,
    stop: () => {
      active.stop();
      if (myGeneration === generation) running = false;
    },
    disablePlugin,
  };
}
