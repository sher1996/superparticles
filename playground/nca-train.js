// In-browser NCA training with TensorFlow.js (Chapter 9a).
//
// Same model and recipe as training/nca.py + train.py, in NHWC layout:
//   perception = depthwiseConv2d(x, [identity, sobel_x, sobel_y]) -> channel 3c + k
//   update     = conv1x1(relu(conv1x1(perception) + b1))           (w2 starts at zero)
// so the exported weights drop straight into the superparticles-nca v1 format.
//
// `tf` is passed in (tfjs-core with a backend registered) so this file has no
// import-time dependency and can be loaded by the page and by tests alike.

export const CHANNELS = 16;
export const HIDDEN = 128;
const FIRE_RATE = 0.5;
const ALIVE = 0.1;

/** Depthwise kernel [3, 3, C, 3]: identity, sobel_x, sobel_y per channel. */
function perceptionKernel(tf) {
  const id = [0, 0, 0, 0, 1, 0, 0, 0, 0];
  const sx = [-1, 0, 1, -2, 0, 2, -1, 0, 1].map((v) => v / 8);
  const sy = [-1, -2, -1, 0, 0, 0, 1, 2, 1].map((v) => v / 8);
  const k = new Float32Array(9 * CHANNELS * 3);
  for (let i = 0; i < 9; i++) {
    for (let c = 0; c < CHANNELS; c++) {
      k[(i * CHANNELS + c) * 3 + 0] = id[i];
      k[(i * CHANNELS + c) * 3 + 1] = sx[i];
      k[(i * CHANNELS + c) * 3 + 2] = sy[i];
    }
  }
  return tf.tensor4d(k, [3, 3, CHANNELS, 3]);
}

/** Small seeded PRNG (mulberry32), so a seeded training run is reproducible. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a trainable NCA. `weights` (optional) are superparticles-nca arrays
 * { w1: (H, 3C), b1: (H), w2: (C, H) } to start from, e.g. for parity tests.
 */
export function createNCA(tf, weights, rng = Math.random) {
  // tf.random* takes an integer seed per call; draw them from rng so seeded runs repeat
  const nextSeed = () => Math.floor(rng() * 2 ** 31);
  const kernel = perceptionKernel(tf);
  let w1, b1, w2;
  if (weights) {
    // (H, 3C) -> conv kernel [1, 1, 3C, H]
    w1 = tf.variable(tf.reshape(tf.transpose(tf.tensor2d(weights.w1, [HIDDEN, 3 * CHANNELS])), [1, 1, 3 * CHANNELS, HIDDEN]));
    b1 = tf.variable(tf.tensor1d(weights.b1));
    w2 = tf.variable(tf.reshape(tf.transpose(tf.tensor2d(weights.w2, [CHANNELS, HIDDEN])), [1, 1, HIDDEN, CHANNELS]));
  } else {
    // PyTorch's default conv init: U(-1/sqrt(fan_in), 1/sqrt(fan_in))
    const bound = 1 / Math.sqrt(3 * CHANNELS);
    w1 = tf.variable(tf.randomUniform([1, 1, 3 * CHANNELS, HIDDEN], -bound, bound, 'float32', nextSeed()));
    b1 = tf.variable(tf.randomUniform([HIDDEN], -bound, bound, 'float32', nextSeed()));
    w2 = tf.variable(tf.zeros([1, 1, HIDDEN, CHANNELS]));
  }

  // 1 where any 3x3 neighbour has alpha > ALIVE. tf.step gives the same 0/1 as a
  // comparison but has a (zero) gradient, so the mask acts as a constant, as in PyTorch.
  const alive = (x) => tf.step(tf.sub(tf.maxPool(tf.slice(x, [0, 0, 0, 3], [-1, -1, -1, 1]), 3, 1, 'same'), ALIVE));

  /** One update step. `fire` is a [B, H, W, 1] 0/1 tensor, or omitted for a random mask. */
  function step(x, fire) {
    return tf.tidy(() => {
      const pre = alive(x);
      const p = tf.depthwiseConv2d(x, kernel, 1, 'same');
      const h = tf.relu(tf.add(tf.conv2d(p, w1, 1, 'valid'), b1));
      const dx = tf.conv2d(h, w2, 1, 'valid');
      const mask = fire ?? tf.cast(tf.lessEqual(tf.randomUniform([x.shape[0], x.shape[1], x.shape[2], 1], 0, 1, 'float32', nextSeed()), FIRE_RATE), 'float32');
      const y = tf.add(x, tf.mul(dx, mask));
      const keep = tf.mul(pre, alive(y));
      return tf.mul(y, keep);
    });
  }

  /** Weights in superparticles-nca layout (Float32Arrays). */
  async function exportWeights() {
    const t1 = tf.transpose(tf.reshape(w1, [3 * CHANNELS, HIDDEN]));
    const t2 = tf.transpose(tf.reshape(w2, [HIDDEN, CHANNELS]));
    const W1 = await t1.data();
    const B1 = await b1.data();
    const W2 = await t2.data();
    t1.dispose();
    t2.dispose();
    return { w1: new Float32Array(W1), b1: new Float32Array(B1), w2: new Float32Array(W2) };
  }

  return { step, variables: [w1, b1, w2], exportWeights, dispose: () => [kernel, w1, b1, w2].forEach((t) => t.dispose()) };
}

/** Seed state [B, S, S, 16]: one live cell in the centre. */
export function seedBatch(tf, batch, size) {
  const data = new Float32Array(batch * size * size * CHANNELS);
  const c = size >> 1;
  for (let b = 0; b < batch; b++) {
    for (let ch = 3; ch < CHANNELS; ch++) data[((b * size + c) * size + c) * CHANNELS + ch] = 1;
  }
  return tf.tensor4d(data, [batch, size, size, CHANNELS]);
}

/**
 * Turn an image into a premultiplied RGBA target [S, S, 4] (Float32Array),
 * fitted into the grid with `pad` empty cells around it.
 * removeBackground makes pixels close to the corner colour transparent (for JPEGs).
 */
export function imageToTarget(image, size, pad, { removeBackground = false, tolerance = 40 } = {}) {
  const inner = size - 2 * pad;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true });
  const scale = Math.min(inner / image.width, inner / image.height);
  const w = Math.max(1, Math.round(image.width * scale)), h = Math.max(1, Math.round(image.height * scale));
  g.imageSmoothingQuality = 'high';
  g.drawImage(image, (size - w) / 2, (size - h) / 2, w, h);
  const px = g.getImageData(0, 0, size, size).data;
  let bg = null;
  if (removeBackground) {
    // corner of the drawn image area
    const x0 = Math.round((size - w) / 2), y0 = Math.round((size - h) / 2);
    const i = (y0 * size + x0) * 4;
    bg = [px[i], px[i + 1], px[i + 2]];
  }
  const out = new Float32Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    let a = px[i * 4 + 3] / 255;
    if (bg) {
      const d = Math.abs(px[i * 4] - bg[0]) + Math.abs(px[i * 4 + 1] - bg[1]) + Math.abs(px[i * 4 + 2] - bg[2]);
      if (d < tolerance) a = 0;
    }
    out[i * 4] = (px[i * 4] / 255) * a;
    out[i * 4 + 1] = (px[i * 4 + 1] / 255) * a;
    out[i * 4 + 2] = (px[i * 4 + 2] / 255) * a;
    out[i * 4 + 3] = a;
  }
  return out;
}

/**
 * Pool-based training with damage (as in train.py). Call `trainStep()` in a loop.
 * Options: size, batch, pool, rollout [min, max], damage, lr, steps (for the LR schedule),
 * seed (optional: makes the run reproducible on a given backend).
 */
export function createTrainer(tf, target, opts = {}) {
  const rng = opts.seed === undefined ? Math.random : makeRng(opts.seed);
  const size = opts.size ?? 48;
  const batch = opts.batch ?? 4;
  const poolSize = opts.pool ?? 256;
  const rollout = opts.rollout ?? [48, 64];
  const damageCount = opts.damage ?? 1;
  const baseLr = opts.lr ?? 2e-3;
  const total = opts.steps ?? 2000;

  const nca = createNCA(tf, undefined, rng);
  const optimizer = tf.train.adam(baseLr);
  const tgt = tf.tensor4d(target, [1, size, size, 4]);
  let pool = seedBatch(tf, poolSize, size);
  let stepNo = 0;

  const lr = (s) => {
    if (s < 50) return baseLr * (s + 1) / 50;
    const t = (s - 50) / Math.max(1, total - 50);
    return baseLr * (0.1 + 0.9 * 0.5 * (1 + Math.cos(Math.PI * t)));
  };

  function damageMask(n) {
    // zero a random disc in each sample
    const m = new Float32Array(n * size * size);
    for (let b = 0; b < n; b++) {
      const cx = (rng() - 0.5), cy = (rng() - 0.5);
      const r = 0.1 + rng() * 0.3;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const u = (x / (size - 1)) * 2 - 1, v = (y / (size - 1)) * 2 - 1;
        m[(b * size + y) * size + x] = (u - cx) ** 2 + (v - cy) ** 2 < (2 * r) ** 2 ? 0 : 1;
      }
    }
    return tf.tensor4d(m, [n, size, size, 1]);
  }

  async function trainStep() {
    optimizer.learningRate = lr(stepNo);
    // sample a batch from the pool, worst first
    const idx = Array.from({ length: batch }, () => Math.floor(rng() * poolSize));
    const idxT = tf.tensor1d(idx, 'int32');
    let x = tf.tidy(() => tf.gather(pool, idxT));
    const per = await tf.tidy(() => tf.mean(tf.square(tf.sub(tf.slice(x, [0, 0, 0, 0], [-1, -1, -1, 4]), tgt)), [1, 2, 3])).data();
    const order = Array.from(per.keys()).sort((a, b) => per[b] - per[a]);
    const orderedIdx = order.map((i) => idx[i]);
    const ordered = tf.tidy(() => {
      let y = tf.gather(x, tf.tensor1d(order, 'int32'));
      // worst sample -> seed, best samples -> damaged
      const seed = seedBatch(tf, 1, size);
      y = tf.concat([seed, tf.slice(y, [1, 0, 0, 0], [-1, -1, -1, -1])], 0);
      if (damageCount > 0 && stepNo > 100) {
        const keep = tf.slice(y, [0, 0, 0, 0], [batch - damageCount, -1, -1, -1]);
        const hurt = tf.mul(tf.slice(y, [batch - damageCount, 0, 0, 0], [-1, -1, -1, -1]), damageMask(damageCount));
        y = tf.concat([keep, hurt], 0);
      }
      return y;
    });
    x.dispose();
    idxT.dispose();

    const n = rollout[0] + Math.floor(rng() * (rollout[1] - rollout[0] + 1));
    let final = null;
    const { value, grads } = tf.variableGrads(() => {
      let s = ordered;
      for (let i = 0; i < n; i++) s = nca.step(s);
      final = tf.keep(s);
      return tf.mean(tf.square(tf.sub(tf.slice(s, [0, 0, 0, 0], [-1, -1, -1, 4]), tgt)));
    }, nca.variables);
    // per-variable gradient normalisation (as in train.py)
    const normed = {};
    for (const [name, g] of Object.entries(grads)) {
      normed[name] = tf.tidy(() => tf.div(g, tf.add(tf.norm(g), 1e-8)));
      g.dispose();
    }
    optimizer.applyGradients(normed);
    Object.values(normed).forEach((g) => g.dispose());

    // write the batch back into the pool
    const next = tf.tidy(() => {
      const mask = new Float32Array(poolSize);
      const upd = new Int32Array(poolSize);
      orderedIdx.forEach((p, i) => { mask[p] = 1; upd[p] = i; });
      const m = tf.tensor4d(mask, [poolSize, 1, 1, 1]);
      const scattered = tf.gather(final, tf.tensor1d(upd, 'int32'));
      return tf.add(tf.mul(pool, tf.sub(1, m)), tf.mul(scattered, m));
    });
    pool.dispose();
    pool = next;
    ordered.dispose();

    const loss = (await value.data())[0];
    value.dispose();
    const preview = final;
    stepNo++;
    return { step: stepNo, loss, iters: n, preview }; // caller disposes preview
  }

  async function toModelFile(name) {
    const w = await nca.exportWeights();
    return modelFile(name, w, size);
  }

  return {
    trainStep,
    toModelFile,
    get step() { return stepNo; },
    dispose() { nca.dispose(); tgt.dispose(); pool.dispose(); optimizer.dispose(); },
  };
}

// ---- export to superparticles-nca v1 -----------------------------------------

function toHalf(v) {
  // round-to-nearest-even float32 -> float16
  const f = new Float32Array([v]);
  const u = new Uint32Array(f.buffer)[0];
  const sign = (u >>> 16) & 0x8000;
  let exp = ((u >>> 23) & 0xff) - 127 + 15;
  let mant = u & 0x7fffff;
  if (exp >= 31) return sign | 0x7c00 | (exp === 128 + 15 && mant ? 0x200 : 0);
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - exp;
    let half = mant >> shift;
    const rem = mant & ((1 << shift) - 1), mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && half & 1)) half++;
    return sign | half;
  }
  let half = (exp << 10) | (mant >> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && half & 1)) half++;
  return sign | half;
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function modelFile(name, w, size) {
  const enc = (arr) => {
    const h = new Uint16Array(arr.length);
    for (let i = 0; i < arr.length; i++) h[i] = toHalf(arr[i]);
    return new Uint8Array(h.buffer);
  };
  const parts = { w1: enc(w.w1), b1: enc(w.b1), w2: enc(w.w2) };
  const all = new Uint8Array(parts.w1.length + parts.b1.length + parts.w2.length);
  all.set(parts.w1, 0);
  all.set(parts.b1, parts.w1.length);
  all.set(parts.w2, parts.w1.length + parts.b1.length);
  return {
    format: 'superparticles-nca',
    version: 1,
    name,
    channels: CHANNELS,
    hidden: HIDDEN,
    perception: 'identity+sobel3x3',
    fireRate: FIRE_RATE,
    aliveThreshold: ALIVE,
    grid: { width: size, height: size },
    seed: 'center',
    dtype: 'float16',
    weights: {
      w1: { shape: [HIDDEN, 3 * CHANNELS], data: b64(parts.w1) },
      b1: { shape: [HIDDEN], data: b64(parts.b1) },
      w2: { shape: [CHANNELS, HIDDEN], data: b64(parts.w2) },
    },
    sha256: await sha256Hex(all),
    training: { trainer: 'browser (TensorFlow.js)', size },
    metrics: null,
  };
}
