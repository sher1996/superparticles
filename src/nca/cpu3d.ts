/* CPU reference for 3D voxel NCA models (Chapter 7). Matches training/nca3d.py.
 * State is channel-major (C, D, H, W); the fire mask hashes (x + W*z, y). */

import { fires, type NCAModel } from './model.js';

export class NCAGrid3DCPU {
  readonly C: number;
  readonly W: number;
  readonly H: number;
  readonly D: number;
  state: Float32Array;
  step = 0;
  seed: number;

  private next: Float32Array;
  private pre: Uint8Array;
  private needed: Uint8Array;
  private perception: Float64Array;
  private hidden: Float64Array;

  constructor(readonly model: NCAModel, opts: { size?: number; seed?: number } = {}) {
    if (model.dims !== 3) throw new Error('NCAGrid3DCPU needs a 3D model');
    this.C = model.channels;
    this.W = this.H = this.D = opts.size ?? model.width;
    this.seed = opts.seed ?? 0;
    const vox = this.W * this.H * this.D;
    this.state = new Float32Array(this.C * vox);
    this.next = new Float32Array(this.C * vox);
    this.pre = new Uint8Array(vox);
    this.needed = new Uint8Array(vox);
    this.perception = new Float64Array(4 * this.C);
    this.hidden = new Float64Array(model.hidden);
    this.plant();
  }

  get voxels() {
    return this.W * this.H * this.D;
  }

  plant() {
    this.state.fill(0);
    const c = this.W >> 1;
    const v = (c * this.H + c) * this.W + c;
    for (let ch = 3; ch < this.C; ch++) this.state[ch * this.voxels + v] = 1;
    this.step = 0;
  }

  /** Zero a ball of voxels (grid units). */
  damage(cx: number, cy: number, cz: number, r: number) {
    const { W, H, D, C } = this;
    for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 >= r * r) continue;
      const v = (z * H + y) * W + x;
      for (let c = 0; c < C; c++) this.state[c * this.voxels + v] = 0;
    }
  }

  private aliveAt(src: Float32Array, x: number, y: number, z: number) {
    const { W, H, D } = this;
    const t = this.model.aliveThreshold;
    const base = 3 * this.voxels;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy, zz = z + dz;
      if (xx < 0 || yy < 0 || zz < 0 || xx >= W || yy >= H || zz >= D) continue;
      if (src[base + (zz * H + yy) * W + xx] > t) return true;
    }
    return false;
  }

  advance(n = 1) {
    for (let i = 0; i < n; i++) this.stepOnce();
  }

  private stepOnce() {
    const { C, W, H, D, model, state, next, pre, needed, perception, hidden } = this;
    const V = this.voxels;
    const Hd = model.hidden, P = 4 * C;
    const { w1, b1, w2 } = model;

    for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      pre[(z * H + y) * W + x] = this.aliveAt(state, x, y, z) ? 1 : 0;
    }
    // Only voxels that are alive or touch a live voxel can matter (see cpu.ts)
    needed.fill(0);
    for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!pre[(z * H + y) * W + x]) continue;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, zz = z + dz;
        if (xx >= 0 && yy >= 0 && zz >= 0 && xx < W && yy < H && zz < D) needed[(zz * H + yy) * W + xx] = 1;
      }
    }

    next.set(state);
    const S = [1, 2, 1], G = [-1, 0, 1];
    for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = (z * H + y) * W + x;
      if (!needed[v]) continue;
      if (!fires(x + W * z, y, this.step, this.seed, model.fireRate)) continue;

      for (let c = 0; c < C; c++) {
        const base = c * V;
        let sx = 0, sy = 0, sz = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy, zz = z + dz;
          if (xx < 0 || yy < 0 || zz < 0 || xx >= W || yy >= H || zz >= D) continue;
          const val = state[base + (zz * H + yy) * W + xx];
          sx += S[dz + 1] * S[dy + 1] * G[dx + 1] * val;
          sy += S[dz + 1] * G[dy + 1] * S[dx + 1] * val;
          sz += G[dz + 1] * S[dy + 1] * S[dx + 1] * val;
        }
        perception[4 * c] = state[base + v];
        perception[4 * c + 1] = sx / 32;
        perception[4 * c + 2] = sy / 32;
        perception[4 * c + 3] = sz / 32;
      }
      for (let j = 0; j < Hd; j++) {
        let s = b1[j];
        const row = j * P;
        for (let k = 0; k < P; k++) s += w1[row + k] * perception[k];
        hidden[j] = s > 0 ? s : 0;
      }
      for (let c = 0; c < C; c++) {
        let s = 0;
        const row = c * Hd;
        for (let j = 0; j < Hd; j++) s += w2[row + j] * hidden[j];
        next[c * V + v] = state[c * V + v] + s;
      }
    }

    for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = (z * H + y) * W + x;
      needed[v] = pre[v] && this.aliveAt(next, x, y, z) ? 1 : 0;
    }
    for (let c = 0; c < C; c++) {
      const base = c * V;
      for (let v = 0; v < V; v++) state[base + v] = needed[v] ? next[base + v] : 0;
    }
    this.step++;
  }

  /** Live voxels as a point list: [x, y, z, r, g, b, a] per voxel (un-premultiplied colour). */
  points(): Float32Array {
    const { W, H, D } = this;
    const V = this.voxels;
    const t = this.model.aliveThreshold;
    const out: number[] = [];
    for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = (z * H + y) * W + x;
      const a = Math.min(1, Math.max(0, this.state[3 * V + v]));
      if (a <= t) continue;
      const k = 1 / Math.max(a, 1e-3);
      out.push(x, y, z,
        Math.min(1, Math.max(0, this.state[v] * k)),
        Math.min(1, Math.max(0, this.state[V + v] * k)),
        Math.min(1, Math.max(0, this.state[2 * V + v] * k)), a);
    }
    return new Float32Array(out);
  }
}
