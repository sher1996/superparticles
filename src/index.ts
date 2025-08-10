/* SuperParticles – Public Façade */

import { loadPlugins, setPluginEnabled, getPluginState, disablePlugin } from './plugin.js';
import { globalPluginState, debugState, resizeParticleBuffers } from './core.js';

// Re-export types for third-party plugin authors
export type { Vec2, ForceFn, ShaderSource, ParticlePlugin, PluginOptions, ShaderPlugin } from './types/plugin.js';

// Re-export plugin management functions
export { setPluginEnabled, getPluginState, globalPluginState, debugState };

export type EngineHandle = {
  stop: () => void;
  disablePlugin: (id: string) => void;
};

export interface Options {
  color?: string;
  speed?: number;
  useWebGL?: boolean;
  useWebGPU?: boolean;
  particleCount?: number;
  deterministic?: boolean;
}

// Global options state
let opts: Required<Options> = { 
  color: '#70c1ff', 
  speed: 40, 
  useWebGL: false, 
  useWebGPU: false, 
  particleCount: 1000, 
  deterministic: false 
};

export function setOptions(next: Options) {
  if (next.speed !== undefined) opts.speed = next.speed;
  if (next.deterministic !== undefined) opts.deterministic = next.deterministic;
  if (next.particleCount !== undefined && next.particleCount !== opts.particleCount) {
    // re-size buffers safely
    resizeParticleBuffers(next.particleCount);
    opts.particleCount = next.particleCount;
  }
  if (next.color !== undefined) opts.color = next.color;
  if (next.useWebGL !== undefined) opts.useWebGL = next.useWebGL;
  if (next.useWebGPU !== undefined) opts.useWebGPU = next.useWebGPU;
}

export function exportState() { 
  return { ...opts }; 
}

export function importState(state: Options) { 
  setOptions(state); 
}

export async function init(
  canvas: HTMLCanvasElement,
  { color = '#70c1ff', speed = 40, useWebGL = false, useWebGPU = false, particleCount = 1000, deterministic = false }: Options = {},
) : Promise<EngineHandle> {
  // Update global options
  opts = { color, speed, useWebGL, useWebGPU, particleCount, deterministic };
  
  let renderer: { stop: () => void };

  if (useWebGPU && 'gpu' in navigator) {
    const { drawGPU } = await import('./drawGPU.js');
    renderer = await drawGPU(canvas, { color, speed, particleCount });
  } else if (useWebGL && !!canvas.getContext('webgl2')) {
    const { initWebGL2 } = await import('./drawGL.js');
    renderer = await initWebGL2(canvas, { color, speed, deterministic });
  } else {
    const { initCanvas2D } = await import('./draw2d.js');
    renderer = initCanvas2D(canvas, { color, speed });
  }

  // Load plugins after first paint
  await loadPlugins({ deterministic });

  return {
    stop: renderer.stop,
    disablePlugin,
  };
} 