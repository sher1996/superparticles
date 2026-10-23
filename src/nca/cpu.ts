/* CPU reference implementation of the NCA update.
 * Slow but exact: it defines what the GPU paths are tested against. */

import { fires, type NCAModel } from './model.js';

export class NCAGridCPU {
  readonly C: number;
  readonly W: number;
  readonly H: number;
  /** Channel-major (C, H, W) state. */
  state: Float32Array;
  step = 0;
  seed: number;

  private next: Float32Array;
  private alivePre: Uint8Array;
  private needed: Uint8Array;
  private perception: Float64Array;
  private hidden: Float64Array;

  constructor(readonly model: NCAModel, opts: { width?: number; height?: number; seed?: number } = {}) {
    this.C = model.channels;
    this.W = opts.width ?? model.width;
    this.H = opts.height ?? model.height;
    this.seed = opts.seed ?? 0;
    const n = this.C * this.W * this.H;
    this.state = new Float32Array(n);
    this.next = new Float32Array(n);
    this.alivePre = new Uint8Array(this.W * this.H);
    this.needed = new Uint8Array(this.W * this.H);
    this.perception = new Float64Array(3 * this.C);
    this.hidden = new Float64Array(model.hidden);
    this.plant();
  }

  /** Clear the grid and place one live seed cell in the centre. */
  plant(cx = this.W >> 1, cy = this.H >> 1) {
    this.state.fill(0);
    const plane = this.W * this.H;
    for (let c = 3; c < this.C; c++) this.state[c * plane + cy * this.W + cx] = 1;
    this.step = 0;
  }

  /** Zero a disc of cells (radius in cells). */
  damage(cx: number, cy: number, r: number) {
    const plane = this.W * this.H;
    for (let y = 0; y < this.H; y++) {
      for (let x = 0; x < this.W; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 >= r * r) continue;
        for (let c = 0; c < this.C; c++) this.state[c * plane + y * this.W + x] = 0;
      }
    }
  }

  private alpha(src: Float32Array, x: number, y: number) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return 0;
    return src[3 * this.W * this.H + y * this.W + x];
  }

  private aliveAt(src: Float32Array, x: number, y: number) {
    const t = this.model.aliveThreshold;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (this.alpha(src, x + dx, y + dy) > t) return true;
      }
    }
    return false;
  }

  /** Advance `n` steps. */
  advance(n = 1) {
    for (let i = 0; i < n; i++) this.stepOnce();
  }

  private stepOnce() {
    const { C, W, H, model, state, next, alivePre, perception, hidden } = this;
    const plane = W * H;
    const Hd = model.hidden, P = 3 * C;
    const { w1, b1, w2 } = model;

    const { needed } = this;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) alivePre[y * W + x] = this.aliveAt(state, x, y) ? 1 : 0;
    // A cell's update matters if it was alive, or if it borders a live cell
    // (its new alpha decides whether that neighbour survives the post check).
    needed.fill(0);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!alivePre[y * W + x]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < W && yy < H) needed[yy * W + xx] = 1;
          }
        }
      }
    }

    next.set(state);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const cell = y * W + x;
        if (!needed[cell]) continue;
        if (!fires(x, y, this.step, this.seed, model.fireRate)) continue;

        // Perception: identity + Sobel x/y per channel, zero padding
        for (let c = 0; c < C; c++) {
          const base = c * plane;
          const at = (xx: number, yy: number) =>
            xx < 0 || yy < 0 || xx >= W || yy >= H ? 0 : state[base + yy * W + xx];
          const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
          const l = at(x - 1, y), r = at(x + 1, y);
          const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
          perception[3 * c] = state[base + cell];
          perception[3 * c + 1] = ((tr + 2 * r + br) - (tl + 2 * l + bl)) / 8;
          perception[3 * c + 2] = ((bl + 2 * b + br) - (tl + 2 * t + tr)) / 8;
        }
        // Hidden layer
        for (let j = 0; j < Hd; j++) {
          let s = b1[j];
          const row = j * P;
          for (let k = 0; k < P; k++) s += w1[row + k] * perception[k];
          hidden[j] = s > 0 ? s : 0;
        }
        // Residual update
        for (let c = 0; c < C; c++) {
          let s = 0;
          const row = c * Hd;
          for (let j = 0; j < Hd; j++) s += w2[row + j] * hidden[j];
          next[c * plane + cell] = state[c * plane + cell] + s;
        }
      }
    }

    // Keep cells alive both before and after the update; zero the rest
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const cell = y * W + x;
        needed[cell] = alivePre[cell] && this.aliveAt(next, x, y) ? 1 : 0;
      }
    }
    for (let c = 0; c < C; c++) {
      const base = c * plane;
      for (let cell = 0; cell < plane; cell++) state[base + cell] = needed[cell] ? next[base + cell] : 0;
    }
    this.step++;
  }
}
