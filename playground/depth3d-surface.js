// From a picture's silhouette and a depth map to a 3D target the swarm can build.
// No DOM here.
//
//   silhouette  0/1 mask, w × h, row 0 at the top
//   depth       0..1 per pixel, 1 = nearest to the camera (what the AI model guessed)
//
// The front of the solid is a relief: each pixel stands out by its depth. The model only sees the
// front, so the back has to be made up. Two choices:
//   "mirror"  the back is the front mirrored (a pillow / coin: thick where the front bulges)
//   "flat"    the back is a flat wall (a carved relief you could hang up)
// Near the silhouette the thickness tapers off, so the rims are rounded instead of cut straight.
//
// The solid is filled into a voxel grid, then turned into a signed distance field (exact Euclidean
// distance transform, inside and outside), lightly smoothed, and looked up trilinearly. That gives
// the same { name, box, dist(x, y, z, n) } interface as createShape in heart3d-shapes.js.

const INF = 1e20;

/** 1D squared distance transform (Felzenszwalb & Huttenlocher), in place on f via scratch arrays. */
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s;
    while (true) {
      const p = v[k];
      s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
      if (s <= z[k] && k > 0) k--; else break;
    }
    if (s <= z[k]) { v[0] = q; z[0] = -INF; z[1] = INF; k = 0; continue; }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) ** 2 + f[v[k]];
  }
}

/** Squared distance (in voxels) from every voxel to the nearest voxel where feature[] is true. */
function edt3d(feature, nx, ny, nz) {
  const g = new Float32Array(nx * ny * nz);
  for (let i = 0; i < g.length; i++) g[i] = feature[i] ? 0 : INF;
  const m = Math.max(nx, ny, nz);
  const f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  const pass = (count, stride, len, base) => {
    for (let a = 0; a < count; a++) {
      const o = base(a);
      for (let q = 0; q < len; q++) f[q] = g[o + q * stride];
      edt1d(f, len, d, v, z);
      for (let q = 0; q < len; q++) g[o + q * stride] = d[q];
    }
  };
  // index = (k * ny + j) * nx + i
  pass(ny * nz, 1, nx, (a) => a * nx);                                             // along x
  pass(nx * nz, nx, ny, (a) => (Math.floor(a / nx) * ny) * nx + (a % nx));          // along y
  pass(nx * ny, nx * ny, nz, (a) => a);                                             // along z
  return g;
}

/** 2D squared distance from every pixel to the nearest pixel where feature[] is true. */
export function edt2d(feature, w, h) {
  return edt3d(feature, w, h, 1);
}

/** Separable [1 2 1]/4 blur along each axis of a 3D field (smooths the voxel stair-steps). */
function blur3(g, nx, ny, nz) {
  const tmp = new Float32Array(g.length);
  const axis = (src, dst, stride, len, idx) => {
    for (let n = 0; n < g.length; n++) {
      const q = idx(n);
      const a = q > 0 ? src[n - stride] : src[n], b = q < len - 1 ? src[n + stride] : src[n];
      dst[n] = (a + 2 * src[n] + b) * 0.25;
    }
  };
  axis(g, tmp, 1, nx, (n) => n % nx);
  axis(tmp, g, nx, ny, (n) => Math.floor(n / nx) % ny);
  axis(g, tmp, nx * ny, nz, (n) => Math.floor(n / (nx * ny)));
  g.set(tmp);
}

/**
 * Build the swarm's target from a silhouette and a depth map.
 * relief: how far the nearest part stands out, in world units (the whole thing is ~2.2 wide).
 * Returns { name, box, dist, info } — info has sizes and timing for the page.
 */
export function buildDepthShape({ mask, depth, w, h, relief = 0.5, back = "mirror", base = 0.06, rim = 0.12, name = "picture" }) {
  const t0 = performance.now();
  const scale = 2.2 / Math.max(w, h); // world units per pixel (= per voxel)

  // thickness taper near the silhouette: distance (world units) to the nearest outside pixel
  const outside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) outside[i] = mask[i] ? 0 : 1;
  // pad by one pixel all round so the picture border counts as outside
  const pw = w + 2, ph = h + 2, padded = new Uint8Array(pw * ph).fill(1);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) padded[(j + 1) * pw + i + 1] = outside[j * w + i];
  const e2 = edt2d(padded, pw, ph);

  // front height zf and back zb per pixel (z towards the viewer)
  const zf = new Float32Array(w * h), zb = new Float32Array(w * h);
  let zmax = 0, zmin = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const p = j * w + i;
    if (!mask[p]) continue;
    const edge = (Math.sqrt(e2[(j + 1) * pw + i + 1]) - 0.5) * scale;
    const taper = Math.sqrt(Math.min(1, Math.max(0.05, edge / rim))); // round rim, like a quarter circle
    const t = (base + relief * depth[p]) * taper;
    if (back === "flat") { zf[p] = -relief * 0.5 + t; zb[p] = -relief * 0.5 - base; }
    else { zf[p] = t; zb[p] = -t; }
    zmax = Math.max(zmax, zf[p]); zmin = Math.min(zmin, zb[p]);
  }

  // voxel grid around it: P voxels of empty space on every side
  const P = 5;
  const nx = w + 2 * P, ny = h + 2 * P;
  const k0 = Math.floor(zmin / scale) - P, nz = Math.ceil(zmax / scale) + P - k0 + 1;
  const N = nx * ny * nz, inside = new Uint8Array(N), out = new Uint8Array(N);
  for (let k = 0; k < nz; k++) {
    const z = (k + k0) * scale;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const pi = i - P, pj = j - P, n = (k * ny + j) * nx + i;
      let ins = false;
      if (pi >= 0 && pj >= 0 && pi < w && pj < h) {
        const p = pj * w + pi;
        ins = mask[p] > 0 && z <= zf[p] && z >= zb[p];
      }
      inside[n] = ins ? 1 : 0; out[n] = ins ? 0 : 1;
    }
  }
  const dOut = edt3d(inside, nx, ny, nz); // outside voxels: distance to the solid
  const dIn = edt3d(out, nx, ny, nz);     // inside voxels: distance to empty space
  const field = new Float32Array(N);
  for (let n = 0; n < N; n++) field[n] = (inside[n] ? -(Math.sqrt(dIn[n]) - 0.5) : Math.sqrt(dOut[n]) - 0.5) * scale;
  blur3(field, nx, ny, nz);

  // world → voxel: x = (i - P + 0.5 - w/2) * scale, y = -(j - P + 0.5 - h/2) * scale, z = (k + k0) * scale
  const ox = P - 0.5 + w / 2, oy = P - 0.5 + h / 2;
  const sdf = (x, y, z) => {
    const fx = x / scale + ox, fy = -y / scale + oy, fz = z / scale - k0;
    const cx = Math.max(0, Math.min(nx - 1.001, fx)), cy = Math.max(0, Math.min(ny - 1.001, fy)), cz = Math.max(0, Math.min(nz - 1.001, fz));
    const i = cx | 0, j = cy | 0, k = cz | 0, tx = cx - i, ty = cy - j, tz = cz - k;
    const a = (k * ny + j) * nx + i, b = a + nx * ny;
    const c00 = field[a] + (field[a + 1] - field[a]) * tx, c10 = field[a + nx] + (field[a + nx + 1] - field[a + nx]) * tx;
    const c01 = field[b] + (field[b + 1] - field[b]) * tx, c11 = field[b + nx] + (field[b + nx + 1] - field[b + nx]) * tx;
    const c0 = c00 + (c10 - c00) * ty, c1 = c01 + (c11 - c01) * ty;
    // beyond the grid: add the distance to it (keeps far-away particles heading home)
    return c0 + (c1 - c0) * tz + Math.hypot(fx - cx, fy - cy, fz - cz) * scale;
  };
  const eps = scale * 0.5;
  const dist = (x, y, z, n) => {
    n[0] = sdf(x + eps, y, z) - sdf(x - eps, y, z);
    n[1] = sdf(x, y + eps, z) - sdf(x, y - eps, z);
    n[2] = sdf(x, y, z + eps) - sdf(x, y, z - eps);
    const len = Math.hypot(n[0], n[1], n[2]) || 1e-9;
    n[0] /= len; n[1] /= len; n[2] /= len;
    return sdf(x, y, z);
  };
  const hx = (w / 2 + 1) * scale, hy = (h / 2 + 1) * scale;
  const box = [-hx, hx, -hy, hy, zmin - scale, zmax + scale];
  return { name, box, dist, info: { voxels: [nx, ny, nz], ms: performance.now() - t0, zmin, zmax, scale } };
}

// ---- silhouette helpers ------------------------------------------------------------------------

/** Keep only the largest 4-connected blob of a 0/1 mask; fill holes smaller than maxHole of its area. */
export function cleanMask(mask, w, h, maxHole = 0.02) {
  const label = new Int32Array(w * h).fill(-1), stack = new Int32Array(w * h);
  const flood = (start, val, id) => {
    let sp = 0, count = 0;
    stack[sp++] = start; label[start] = id;
    while (sp) {
      const p = stack[--sp], i = p % w, j = (p - i) / w;
      count++;
      const nb = [i > 0 ? p - 1 : -1, i < w - 1 ? p + 1 : -1, j > 0 ? p - w : -1, j < h - 1 ? p + w : -1];
      for (const q of nb) if (q >= 0 && label[q] < 0 && mask[q] === val) { label[q] = id; stack[sp++] = q; }
    }
    return count;
  };
  let best = -1, bestN = 0, id = 0;
  for (let p = 0; p < w * h; p++) if (mask[p] && label[p] < 0) {
    const n = flood(p, mask[p], id);
    if (n > bestN) { bestN = n; best = id; }
    id++;
  }
  const out = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) out[p] = label[p] === best ? 1 : 0;
  // holes: background blobs that don't touch the border
  label.fill(-1);
  const bg = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) bg[p] = out[p] ? 0 : 1;
  for (let p = 0; p < w * h; p++) if (bg[p] && label[p] < 0) {
    const { count, touches, cells } = floodBg(bg, label, stack, w, h, p, id++);
    if (!touches && count < bestN * maxHole) for (const q of cells) out[q] = 1;
  }
  return out;
}

function floodBg(bg, label, stack, w, h, start, id) {
  let sp = 0, touches = false;
  const cells = [];
  stack[sp++] = start; label[start] = id;
  while (sp) {
    const p = stack[--sp], i = p % w, j = (p - i) / w;
    cells.push(p);
    if (i === 0 || j === 0 || i === w - 1 || j === h - 1) touches = true;
    if (i > 0 && bg[p - 1] && label[p - 1] < 0) { label[p - 1] = id; stack[sp++] = p - 1; }
    if (i < w - 1 && bg[p + 1] && label[p + 1] < 0) { label[p + 1] = id; stack[sp++] = p + 1; }
    if (j > 0 && bg[p - w] && label[p - w] < 0) { label[p - w] = id; stack[sp++] = p - w; }
    if (j < h - 1 && bg[p + w] && label[p + w] < 0) { label[p + w] = id; stack[sp++] = p + w; }
  }
  return { count: cells.length, touches, cells };
}

/** Otsu threshold of values (0..1) where sel[] is set. */
export function otsu(values, sel) {
  const hist = new Float64Array(64);
  let total = 0;
  for (let i = 0; i < values.length; i++) if (!sel || sel[i]) { hist[Math.min(63, Math.max(0, Math.floor(values[i] * 64)))]++; total++; }
  let sum = 0;
  for (let b = 0; b < 64; b++) sum += b * hist[b];
  let wB = 0, sB = 0, best = 0, thr = 32;
  for (let b = 0; b < 64; b++) {
    wB += hist[b];
    if (!wB || wB === total) continue;
    sB += b * hist[b];
    const mB = sB / wB, mF = (sum - sB) / (total - wB), v = wB * (total - wB) * (mB - mF) ** 2;
    if (v > best) { best = v; thr = b + 1; }
  }
  return thr / 64;
}
