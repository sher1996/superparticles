/* Neural cellular automaton model format (superparticles-nca v1) and loader.
 *
 * The update rule is defined by training/nca.py; every runtime (this CPU
 * reference, WebGL2, WebGPU) must reproduce it. Layouts:
 *   state: Float32Array, channel-major (C, H, W) — same as PyTorch
 *   w1: (hidden, 3C), perception index 3c + k, k ∈ {identity, sobel_x, sobel_y}
 *   b1: (hidden)
 *   w2: (C, hidden)
 */

export interface NCAModelFile {
  format: 'superparticles-nca';
  version: 1;
  name: string;
  channels: number;
  hidden: number;
  perception: 'identity+sobel3x3';
  fireRate: number;
  aliveThreshold: number;
  grid: { width: number; height: number };
  seed: 'center';
  dtype: 'float16' | 'float32';
  weights: Record<'w1' | 'b1' | 'w2', { shape: number[]; data: string }>;
  sha256: string;
  training?: Record<string, unknown>;
  metrics?: Record<string, unknown> | null;
}

export interface NCAModel {
  name: string;
  channels: number;
  hidden: number;
  fireRate: number;
  aliveThreshold: number;
  width: number;
  height: number;
  w1: Float32Array;
  b1: Float32Array;
  w2: Float32Array;
  metrics?: Record<string, unknown> | null;
}

export function parseModel(doc: NCAModelFile): NCAModel {
  if (doc.format !== 'superparticles-nca') throw new Error('Not a SuperParticles NCA model');
  if (doc.version !== 1) throw new Error(`Unsupported NCA model version ${doc.version}`);
  if (doc.perception !== 'identity+sobel3x3') throw new Error(`Unsupported perception "${doc.perception}"`);
  const C = doc.channels, Hd = doc.hidden;
  const read = (k: 'w1' | 'b1' | 'w2', expect: number[]) => {
    const t = doc.weights[k];
    if (t.shape.join() !== expect.join()) throw new Error(`Weight ${k} has shape ${t.shape}, expected ${expect}`);
    const out = decode(t.data, doc.dtype);
    if (out.length !== expect.reduce((a, b) => a * b, 1)) throw new Error(`Weight ${k} has the wrong length`);
    return out;
  };
  return {
    name: doc.name,
    channels: C,
    hidden: Hd,
    fireRate: doc.fireRate,
    aliveThreshold: doc.aliveThreshold,
    width: doc.grid.width,
    height: doc.grid.height,
    w1: read('w1', [Hd, 3 * C]),
    b1: read('b1', [Hd]),
    w2: read('w2', [C, Hd]),
    metrics: doc.metrics,
  };
}

/** Fetch and parse a model file. */
export async function loadModel(url: string | URL): Promise<NCAModel> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load NCA model (${res.status})`);
  return parseModel(await res.json());
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decode(b64: string, dtype: 'float16' | 'float32'): Float32Array {
  const bytes = base64ToBytes(b64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dtype === 'float32') {
    const out = new Float32Array(bytes.byteLength / 4);
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
    return out;
  }
  const out = new Float32Array(bytes.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = halfToFloat(view.getUint16(i * 2, true));
  return out;
}

export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

/**
 * Per-cell fire decision shared by all runtimes: murmur3-style finaliser over
 * (x, y, step, seed); the cell updates when the top 24 bits < fireRate · 2^24.
 */
export function hashU32(x: number, y: number, step: number, seed: number): number {
  let h = Math.imul(x, 0x8da6b343);
  h ^= Math.imul(y, 0xd8163841);
  h ^= Math.imul(step, 0xcb1ab31f);
  h ^= seed;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function fires(x: number, y: number, step: number, seed: number, fireRate: number): boolean {
  return (hashU32(x, y, step, seed) >>> 8) < Math.floor(fireRate * (1 << 24));
}
