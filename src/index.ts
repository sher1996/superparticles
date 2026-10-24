/* SuperParticles – Public Façade */

import { Engine, defaults, type Options, type EngineState } from './engine.js';
import { registerPlugin } from './plugin.js';
import type { RendererKind } from './render.js';

// Re-export types for third-party plugin authors
export type { Vec2, Bounds, ForceFn, ShaderSource, ParticlePlugin, PluginOptions, ShaderPlugin } from './types/plugin.js';
export type { Options, EngineState, RendererKind };
export { Engine, registerPlugin };

/**
 * Create an independent engine. Prefer this for new code: each engine has its
 * own particles, plugins and options, so several can run on one page.
 */
export function createEngine(canvas: HTMLCanvasElement, options: Options = {}): Promise<Engine> {
  return Engine.create(canvas, options);
}

// ---------------------------------------------------------------------------
// Single-engine convenience API (kept for existing pages and the playground).
// These functions act on the engine most recently started with init().

export type EngineHandle = {
  /** The renderer actually in use (may differ from the one requested if it was unavailable). */
  renderer: RendererKind;
  engine: Engine;
  stop: () => void;
  disablePlugin: (id: string) => void;
};

let current: Engine | null = null;
let pending: EngineState = { ...defaults };

/**
 * Start rendering into `canvas`. A canvas keeps the first context type it is
 * given, so to switch renderers pass a fresh canvas element.
 */
export async function init(canvas: HTMLCanvasElement, options: Options = {}): Promise<EngineHandle> {
  const engine = await Engine.create(canvas, options);
  current = engine;
  pending = engine.exportState();
  return {
    renderer: engine.renderer,
    engine,
    stop: () => {
      engine.stop();
      if (current === engine) current = null;
    },
    disablePlugin: id => engine.disablePlugin(id),
  };
}

/** Update options. Color, size, speed, count and deterministic apply live. */
export function setOptions(next: Options) {
  if (current) current.setOptions(next);
  for (const k of Object.keys(defaults) as Array<keyof EngineState>) {
    if (next[k] !== undefined) (pending as Record<string, unknown>)[k] = next[k];
  }
}

export function exportState(): EngineState {
  return current ? current.exportState() : { ...pending };
}

export function importState(state: Options) {
  setOptions(state);
}

export function setPluginEnabled(type: 'force' | 'shader', id: string, enabled: boolean) {
  current?.setPluginEnabled(type, id, enabled);
}

export function getPluginState() {
  return current ? current.getPluginState() : { forces: [], shaders: [] };
}
