/* Common interface for NCA backends (CPU reference, WebGL2, WebGPU). */

import type { NCAModel } from './model.js';

export type NCABackendKind = 'webgpu' | 'webgl2' | 'cpu';

export interface DrawParams {
  /** 'rgba' shows the visible channels; 'hidden' shows one channel as a heat map. */
  view: 'rgba' | 'hidden';
  channel: number;
  /** Dot diameter relative to the cell size. */
  dotScale: number;
}

export interface NCABackend {
  readonly kind: NCABackendKind;
  readonly width: number;
  readonly height: number;
  /** Run `n` update steps starting at global step `step`. */
  advance(n: number, step: number, seed: number): void;
  /** Replace the whole state (channel-major C×H×W). */
  setState(state: Float32Array): void;
  /** Read the whole state back (channel-major C×H×W). */
  readState(): Promise<Float32Array>;
  /** Zero all channels inside a disc (grid units). */
  damage(cx: number, cy: number, r: number): void;
  draw(p: DrawParams): void;
  resize?(): void;
  destroy(): void;
}

/** Seed state: one live cell in the centre (alpha + hidden = 1). */
export function seedState(model: NCAModel, width: number, height: number): Float32Array {
  const plane = width * height;
  const s = new Float32Array(model.channels * plane);
  const cell = (height >> 1) * width + (width >> 1);
  for (let c = 3; c < model.channels; c++) s[c * plane + cell] = 1;
  return s;
}

/** Letterbox the grid into the canvas. Returns device-pixel cell size and origin. */
export function fitGrid(canvas: { width: number; height: number }, w: number, h: number) {
  const cell = Math.min(canvas.width / w, canvas.height / h);
  return { cell, ox: (canvas.width - w * cell) / 2, oy: (canvas.height - h * cell) / 2 };
}

/**
 * Reorder w1 columns from the training layout (3c + k) to blocked layout
 * (k * C + c): [identity(C) | sobel_x(C) | sobel_y(C)], which lets GPU code
 * work on whole vec4 channel groups.
 */
export function blockW1(model: NCAModel): Float32Array {
  const C = model.channels, P = 3 * C;
  const out = new Float32Array(model.w1.length);
  for (let j = 0; j < model.hidden; j++) {
    for (let c = 0; c < C; c++) {
      for (let k = 0; k < 3; k++) out[j * P + k * C + c] = model.w1[j * P + 3 * c + k];
    }
  }
  return out;
}
