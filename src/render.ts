/* Shared renderer contract */

import type { Simulation } from './core.js';
import type { PluginHost } from './plugin.js';

/** Live render style; renderers read it every frame. Size is in CSS pixels. */
export interface Style {
  color: string;
  size: number;
}

/** Maps world units to canvas (device) pixels: px = world * scale + offset. */
export interface View {
  sx: number;
  sy: number;
  ox: number;
  oy: number;
  dpr: number;
}

export interface RenderContext {
  canvas: HTMLCanvasElement;
  sim: Simulation;
  plugins: PluginHost;
  style: Style;
  view: View;
}

export interface Renderer {
  draw(): void;
  /** Called after the canvas backing size changed. */
  resize?(): void;
  destroy(): void;
}

export type RendererKind = 'canvas2d' | 'webgl2' | 'webgpu';
