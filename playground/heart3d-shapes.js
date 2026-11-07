// Target shapes for the orchestrated swarm. A shape answers one question: how far is a point from
// the surface (negative inside), and which way is out. Specs are plain data, so the page can send
// them to the training worker: { kind: "heart" | "star" | "sphere" | "ring" | "image", mask?, w?, h? }.

const EPS = 1e-3;

/** Normal by central differences, for shapes without an exact gradient. */
function numericDist(sdf) {
  // gradient from 4 samples on a tetrahedron (instead of 6 for central differences)
  return (x, y, z, n) => {
    const a = sdf(x + EPS, y - EPS, z - EPS), b = sdf(x - EPS, y - EPS, z + EPS);
    const c = sdf(x - EPS, y + EPS, z - EPS), d = sdf(x + EPS, y + EPS, z + EPS);
    n[0] = a - b - c + d; n[1] = -a - b + c + d; n[2] = -a + b - c + d;
    const len = Math.hypot(n[0], n[1], n[2]) || 1e-9;
    n[0] /= len; n[1] /= len; n[2] /= len;
    return sdf(x, y, z);
  };
}

/** A flat 2D shape (signed distance d2 in the xy plane) given thickness: a slab with rounded rims. */
function extrude(d2, half) {
  return (x, y, z) => {
    const a = d2(x, y), b = Math.abs(z) - half;
    return Math.min(Math.max(a, b), 0) + Math.hypot(Math.max(a, 0), Math.max(b, 0));
  };
}

// ---- the heart: the classic implicit surface (Taubin), with its exact gradient ---------------
//   F(x, y, z) = (x² + 9/4 z² + y² − 1)³ − x² y³ − 9/80 z² y³,  y up; surface F = 0, inside F < 0.

function heartDist(x, y, z, n) {
  const a = x * x + 2.25 * z * z + y * y - 1;
  const a2 = 3 * a * a, y3 = y * y * y;
  n[0] = a2 * 2 * x - 2 * x * y3;
  n[1] = a2 * 2 * y - 3 * x * x * y * y - 0.3375 * z * z * y * y;
  n[2] = a2 * 4.5 * z - 0.225 * z * y3;
  const len = Math.hypot(n[0], n[1], n[2]) || 1e-9;
  n[0] /= len; n[1] /= len; n[2] /= len;
  return (a * a * a - x * x * y3 - 0.1125 * z * z * y3) / len; // first-order distance F / |∇F|
}

// ---- a five-pointed star -------------------------------------------------------------------------

// The star as a polygon: 10 corners, alternating outer and inner radius. Exact and simple.
const STAR = (() => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 5, rad = i % 2 ? 0.48 : 1.15;
    pts.push([Math.cos(a) * rad, Math.sin(a) * rad - 0.05]);
  }
  return pts;
})();

function polyD2(x, y) {
  // signed distance to the STAR polygon: distance to the nearest edge, negative inside
  let d = Infinity, inside = false;
  for (let i = 0, j = STAR.length - 1; i < STAR.length; j = i++) {
    const [ax, ay] = STAR[j], [bx, by] = STAR[i];
    const ex = bx - ax, ey = by - ay, wx = x - ax, wy = y - ay;
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    d = Math.min(d, Math.hypot(wx - ex * t, wy - ey * t));
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside ? -d : d;
}

// ---- your own image: its silhouette, as a slab -----------------------------------------------------

/**
 * Signed distance field of a 0/1 mask (w × h, row 0 at the top), in world units, fitted into
 * about [-1.1, 1.1]. Distance to the nearest boundary pixel; negative inside.
 */
function maskD2(mask, w, h) {
  const scale = 2.2 / Math.max(w, h); // world units per pixel
  const at = (i, j) => i >= 0 && j >= 0 && i < w && j < h && mask[j * w + i] > 0;
  const edge = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (at(i, j) && (!at(i - 1, j) || !at(i + 1, j) || !at(i, j - 1) || !at(i, j + 1))) edge.push(i, j);
  }
  const field = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    let best = Infinity;
    for (let k = 0; k < edge.length; k += 2) {
      const d = (edge[k] - i) ** 2 + (edge[k + 1] - j) ** 2;
      if (d < best) best = d;
    }
    // edge pixels sit half a pixel inside the true border
    field[j * w + i] = (at(i, j) ? -(Math.sqrt(best) + 0.5) : Math.sqrt(best) - 0.5) * scale;
  }
  // world (x right, y up, centred) → pixel, bilinear; outside the grid: distance to the grid plus border value
  return (x, y) => {
    const fx = x / scale + w / 2 - 0.5, fy = -y / scale + h / 2 - 0.5;
    const cx = Math.max(0, Math.min(w - 1.001, fx)), cy = Math.max(0, Math.min(h - 1.001, fy));
    const i = Math.floor(cx), j = Math.floor(cy), tx = cx - i, ty = cy - j;
    const v = (field[j * w + i] * (1 - tx) + field[j * w + i + 1] * tx) * (1 - ty)
      + (field[(j + 1) * w + i] * (1 - tx) + field[(j + 1) * w + i + 1] * tx) * ty;
    return v + Math.hypot(fx - cx, fy - cy) * scale;
  };
}

/** A 2D distance function precomputed on a grid over [-ext, ext]² (bilinear lookups are much faster). */
function gridD2(fn, ext = 1.3, res = 160) {
  const step = (2 * ext) / (res - 1), field = new Float32Array(res * res);
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) field[j * res + i] = fn(-ext + i * step, -ext + j * step);
  return (x, y) => {
    const fx = (x + ext) / step, fy = (y + ext) / step;
    const cx = Math.max(0, Math.min(res - 1.001, fx)), cy = Math.max(0, Math.min(res - 1.001, fy));
    const i = Math.floor(cx), j = Math.floor(cy), tx = cx - i, ty = cy - j;
    const v = (field[j * res + i] * (1 - tx) + field[j * res + i + 1] * tx) * (1 - ty)
      + (field[(j + 1) * res + i] * (1 - tx) + field[(j + 1) * res + i + 1] * tx) * ty;
    return v + Math.hypot(fx - cx, fy - cy) * step;
  };
}

// ---- a bug: a round body with thin legs and antennae (a test for thin parts) ---------------------

function capsule(x, y, z, ax, ay, az, bx, by, bz, r) {
  const ex = bx - ax, ey = by - ay, ez = bz - az, wx = x - ax, wy = y - ay, wz = z - az;
  const t = Math.max(0, Math.min(1, (wx * ex + wy * ey + wz * ez) / (ex * ex + ey * ey + ez * ez)));
  return Math.hypot(wx - ex * t, wy - ey * t, wz - ez * t) - r;
}
const BUG_LIMBS = (() => {
  const limbs = [];
  for (const side of [-1, 1]) {
    for (const [y, tilt] of [[0.18, 0.35], [-0.05, 0], [-0.28, -0.35]]) {
      // a leg: out from the body, then down to the ground
      limbs.push([side * 0.38, y, 0, side * 0.8, y + tilt * 0.4, 0.15, 0.014]);
      limbs.push([side * 0.8, y + tilt * 0.4, 0.15, side * 1.05, y + tilt * 0.6 - 0.25, 0.3, 0.011]);
    }
    limbs.push([side * 0.1, 0.55, 0.1, side * 0.45, 1.15, 0.3, 0.008]); // antenna
  }
  return limbs;
})();
function bugSdf(x, y, z) {
  let d = Math.hypot(x / 0.42, (y - 0.05) / 0.62, z / 0.38) * 0.38 - 0.38; // body (approximate ellipsoid)
  d = Math.min(d, Math.hypot(x, y - 0.62, z - 0.05) - 0.2);               // head
  for (const l of BUG_LIMBS) d = Math.min(d, capsule(x, y, z, ...l));
  return d;
}

/**
 * A distance grid (res³ values, x slowest, z fastest, over [lo, hi]³, negative inside) as a
 * distance function: trilinear inside the grid, plus the distance to the grid outside it.
 */
function gridSdf({ res, lo, hi, data }) {
  const step = (hi - lo) / (res - 1), R = res, R2 = res * res;
  return (x, y, z) => {
    const fx = (x - lo) / step, fy = (y - lo) / step, fz = (z - lo) / step;
    const cx = Math.max(0, Math.min(R - 1.001, fx)), cy = Math.max(0, Math.min(R - 1.001, fy)), cz = Math.max(0, Math.min(R - 1.001, fz));
    const i = Math.floor(cx), j = Math.floor(cy), k = Math.floor(cz), tx = cx - i, ty = cy - j, tz = cz - k;
    const o = i * R2 + j * R + k;
    const c00 = data[o] * (1 - tz) + data[o + 1] * tz, c01 = data[o + R] * (1 - tz) + data[o + R + 1] * tz;
    const c10 = data[o + R2] * (1 - tz) + data[o + R2 + 1] * tz, c11 = data[o + R2 + R] * (1 - tz) + data[o + R2 + R + 1] * tz;
    const v = (c00 * (1 - ty) + c01 * ty) * (1 - tx) + (c10 * (1 - ty) + c11 * ty) * tx;
    return v + Math.hypot(fx - cx, fy - cy, fz - cz) * step;
  };
}

/** Read the helper's reply: header length, JSON header, then res³ float16 distances. */
export function parseDistanceGrid(buffer, name) {
  const view = new DataView(buffer);
  const hlen = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, hlen)));
  const n = header.res ** 3, half = new Uint16Array(buffer.slice(4 + hlen, 4 + hlen + n * 2));
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const h = half[i], s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
    data[i] = e === 0 ? s * m * 2 ** -24 : e === 31 ? s * Infinity : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return { kind: "grid", res: header.res, lo: header.bounds[0], hi: header.bounds[1], data, name, seconds: header.seconds };
}

/**
 * The picture with its background cut out (transparent), as a PNG for the image → 3D helper.
 * Same rule as imageToMask: keep its own transparency, or drop the corner colour.
 */
export async function cutOutPng(image, maxSize = 1024, tolerance = 60) {
  const s = Math.min(1, maxSize / Math.max(image.width, image.height));
  const c = document.createElement("canvas");
  c.width = Math.round(image.width * s); c.height = Math.round(image.height * s);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(image, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height), px = img.data;
  let transparent = false;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 128) { transparent = true; break; }
  if (!transparent) {
    const bg = [px[0], px[1], px[2]];
    for (let i = 0; i < px.length; i += 4) {
      if (Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]) <= tolerance) px[i + 3] = 0;
    }
    g.putImageData(img, 0, 0);
  }
  return new Promise((resolve) => c.toBlob(resolve, "image/png"));
}

export const SHAPES = { heart: "Heart", star: "Star", sphere: "Sphere", ring: "Ring", bug: "Bug (thin legs)" };

export function createShape(spec = { kind: "heart" }) {
  switch (spec.kind) {
    case "sphere":
      return { name: "sphere", box: [-1.1, 1.1, -1.1, 1.1, -1.1, 1.1], dist: numericDist((x, y, z) => Math.hypot(x, y, z) - 0.95) };
    case "ring":
      return { name: "ring", box: [-1.2, 1.2, -1.2, 1.2, -0.5, 0.5], dist: numericDist((x, y, z) => Math.hypot(Math.hypot(x, y) - 0.78, z) - 0.32) };
    case "star":
      return { name: "star", box: [-1.25, 1.25, -1.25, 1.25, -0.35, 0.35], dist: numericDist(extrude(gridD2(polyD2), 0.22)) };
    case "bug":
      return { name: "bug", box: [-1.25, 1.25, -0.8, 1.3, -0.5, 0.6], dist: numericDist(bugSdf) };
    case "image": {
      const d2 = maskD2(spec.mask, spec.w, spec.h);
      return { name: spec.name || "your image", box: [-1.25, 1.25, -1.25, 1.25, -0.35, 0.35], dist: numericDist(extrude(d2, 0.18)) };
    }
    case "grid": // a full 3D shape as a distance grid, e.g. from the local image → 3D helper
      return { name: spec.name || "3D model", box: [spec.lo, spec.hi, spec.lo, spec.hi, spec.lo, spec.hi], dist: numericDist(gridSdf(spec)) };
    default:
      return { name: "heart", box: [-1.25, 1.25, -1.1, 1.3, -0.75, 0.75], dist: heartDist };
  }
}

/**
 * An image's silhouette as a mask (DOM only). Transparent pixels are outside; an image without
 * transparency loses the colour of its corner as background.
 */
export function imageToMask(image, size = 96, tolerance = 60) {
  const c = document.createElement("canvas");
  const s = Math.min(size / image.width, size / image.height);
  const w = Math.max(1, Math.round(image.width * s)), h = Math.max(1, Math.round(image.height * s));
  c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(image, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  let transparent = false;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 128) { transparent = true; break; }
  const bg = [px[0], px[1], px[2]];
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    mask[i] = transparent
      ? (px[o + 3] >= 128 ? 1 : 0)
      : (Math.abs(px[o] - bg[0]) + Math.abs(px[o + 1] - bg[1]) + Math.abs(px[o + 2] - bg[2]) > tolerance ? 1 : 0);
  }
  return { mask, w, h };
}
