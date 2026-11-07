// A swarm world around a ready-made shape object. Same fields as createWorld in heart3d-sim.js
// (which only takes shape specs it knows, so it can't take the depth shape): target points spread
// evenly on the surface, zones by k-means, each zone's quota of smart particles, neighbours, spacing.

import { mulberry } from "./heart3d-sim.js";

function sampleSurface(shape, n, rand) {
  const pts = new Float32Array(n * 3), g = new Float64Array(3);
  const [x0, x1, y0, y1, z0, z1] = shape.box;
  let k = 0, tries = 0;
  while (k < n && tries < n * 2000) {
    tries++;
    let x = x0 + rand() * (x1 - x0), y = y0 + rand() * (y1 - y0), z = z0 + rand() * (z1 - z0);
    if (Math.abs(shape.dist(x, y, z, g)) > 0.01) continue; // thin shell: uniform by area
    for (let it = 0; it < 4; it++) {
      const d = shape.dist(x, y, z, g);
      x -= d * g[0]; y -= d * g[1]; z -= d * g[2];
    }
    pts[3 * k] = x; pts[3 * k + 1] = y; pts[3 * k + 2] = z;
    k++;
  }
  return pts.subarray(0, k * 3);
}

function kmeans(pts, k, iters, rand) {
  const n = pts.length / 3, c = new Float32Array(k * 3);
  for (let j = 0; j < k; j++) {
    const i = Math.floor(rand() * n);
    c.set(pts.subarray(3 * i, 3 * i + 3), 3 * j);
  }
  const sum = new Float64Array(k * 3), cnt = new Int32Array(k);
  for (let it = 0; it < iters; it++) {
    sum.fill(0); cnt.fill(0);
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        const dx = pts[3 * i] - c[3 * j], dy = pts[3 * i + 1] - c[3 * j + 1], dz = pts[3 * i + 2] - c[3 * j + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd) { bd = d; best = j; }
      }
      cnt[best]++;
      sum[3 * best] += pts[3 * i]; sum[3 * best + 1] += pts[3 * i + 1]; sum[3 * best + 2] += pts[3 * i + 2];
    }
    for (let j = 0; j < k; j++) if (cnt[j]) for (let d = 0; d < 3; d++) c[3 * j + d] = sum[3 * j + d] / cnt[j];
  }
  return { c, cnt };
}

function zoneName(x, y, z) {
  const side = x < -0.35 ? "left" : x > 0.35 ? "right" : "middle";
  const face = z > 0.05 ? "front" : z < -0.05 ? "back" : "rim";
  const height = y > 0.4 ? "top" : y < -0.4 ? "bottom" : "middle";
  return height === "middle" && side === "middle" ? `centre (${face})` : `${height} ${side} (${face})`;
}

export function createShapeWorld(shape, { smart = 600, zones = 96, targetN = 6000, seed = 7 } = {}) {
  const rand = mulberry(seed);
  const target = sampleSurface(shape, targetN, rand);
  targetN = target.length / 3;
  const km = kmeans(target, zones, 12, rand);
  const quota = new Int32Array(zones);
  let left = smart;
  for (let j = 0; j < zones; j++) left -= (quota[j] = Math.floor((km.cnt[j] / targetN) * smart));
  for (let j = 0; left > 0; j = (j + 1) % zones, left--) quota[j]++;
  const ideal = kmeans(target, smart, 6, mulberry(seed + 1)).c;
  let s = 0;
  for (let i = 0; i < smart; i++) {
    let bd = Infinity;
    for (let j = 0; j < smart; j++) {
      if (i === j) continue;
      const d = (ideal[3 * i] - ideal[3 * j]) ** 2 + (ideal[3 * i + 1] - ideal[3 * j + 1]) ** 2 + (ideal[3 * i + 2] - ideal[3 * j + 2]) ** 2;
      if (d < bd) bd = d;
    }
    s += Math.sqrt(bd);
  }
  const d2 = (a, b) => (km.c[3 * a] - km.c[3 * b]) ** 2 + (km.c[3 * a + 1] - km.c[3 * b + 1]) ** 2 + (km.c[3 * a + 2] - km.c[3 * b + 2]) ** 2;
  const nbr = new Int32Array(zones * 6);
  for (let j = 0; j < zones; j++) {
    const order = [...Array(zones).keys()].filter((k) => k !== j).sort((a, b) => d2(j, a) - d2(j, b));
    nbr.set(order.slice(0, 6), j * 6);
  }
  const names = Array.from({ length: zones }, (_, j) => zoneName(km.c[3 * j], km.c[3 * j + 1], km.c[3 * j + 2]));
  const spacing = s / smart;
  // heart3d-sim.js gives thin parts their own denser spacing; a depth relief has none, so every zone is uniform
  return {
    shape, spec: { kind: "depth" }, target, targetN, zones, zc: km.c, quota, names, nbr, smart, spacing,
    zoneSpacing: new Float32Array(zones).fill(spacing), maxSpacing: spacing,
    weight: new Float32Array(targetN).fill(1), thin: new Uint8Array(targetN), thinShare: 0,
  };
}
