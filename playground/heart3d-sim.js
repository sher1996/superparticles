// Orchestrated 3D heart: the simulation, shared by the page, the trainer (a worker) and the
// live training view. No DOM here.
//
//   orchestrator  sees the whole swarm against the target heart and sends instructions:
//                 "planner"  hand-written: quotas per zone, sends particles to zones short of them
//                 "learned"  a small network that sends every zone a call strength
//   smart         each carries out its instruction on its own: travel, sense the surface,
//                 keep its spacing from neighbours
//   followers     each listens to one smart particle and stays near it on the surface
//
// The target shape comes from heart3d-shapes.js (the heart by default).

import { createShape } from "./heart3d-shapes.js";

export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Evenly spread points on the surface: sample a thin shell, then project onto F = 0. */
function sampleSurface(shape, n, rand) {
  const pts = new Float32Array(n * 3), g = new Float64Array(3);
  const [x0, x1, y0, y1, z0, z1] = shape.box;
  let k = 0;
  while (k < n) {
    let x = x0 + rand() * (x1 - x0), y = y0 + rand() * (y1 - y0), z = z0 + rand() * (z1 - z0);
    if (Math.abs(shape.dist(x, y, z, g)) > 0.01) continue; // shell of constant thickness: uniform by area
    for (let it = 0; it < 4; it++) {
      const d = shape.dist(x, y, z, g);
      x -= d * g[0]; y -= d * g[1]; z -= d * g[2];
    }
    pts[3 * k] = x; pts[3 * k + 1] = y; pts[3 * k + 2] = z;
    k++;
  }
  return pts;
}

/** k-means on 3D points; returns centroids and per-cluster counts. */
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

function zoneName(shape, x, y, z) {
  const side = x < -0.35 ? "left" : x > 0.35 ? "right" : "middle";
  const face = z > 0.2 ? "front" : z < -0.2 ? "back" : "side";
  if (shape === "heart") {
    if (y > 0.55 && side !== "middle") return `${side} lobe (${face})`;
    if (y > 0.55) return `top cleft (${face})`;
    if (y < -0.45) return `bottom tip (${face})`;
    return `lower ${side} (${face})`;
  }
  const height = y > 0.4 ? "top" : y < -0.4 ? "bottom" : "middle";
  return height === "middle" && side === "middle" ? `centre (${face})` : `${height} ${side} (${face})`;
}

/**
 * How thin the shape is at each surface point: march inward along the normal and take the
 * deepest the shape gets (the half-thickness). A thin leg is ~0.03 deep, a body ~0.4.
 */
function halfThickness(shape, target) {
  const n = target.length / 3, out = new Float32Array(n), nrm = new Float64Array(3), tmp = new Float64Array(3);
  for (let p = 0; p < n; p++) {
    const x = target[3 * p], y = target[3 * p + 1], z = target[3 * p + 2];
    shape.dist(x, y, z, nrm);
    let deepest = 0;
    // steps as big as the distance allows: tiny inside a thin leg, larger inside a body
    for (let s = 0.003; s <= 0.6;) {
      const d = shape.dist(x - nrm[0] * s, y - nrm[1] * s, z - nrm[2] * s, tmp);
      if (d < deepest) deepest = d;
      else if (d > deepest + 0.01) break; // came out the other side
      s += Math.min(0.03, Math.max(0.003, Math.abs(d) * 0.5));
    }
    out[p] = -deepest;
  }
  return out;
}

/** Spread k centres over the points, more where the weight is higher (k-means on a weighted resample). */
function weightedCentres(pts, weight, k, rand) {
  const n = weight.length, cum = new Float64Array(n);
  for (let i = 0, s = 0; i < n; i++) cum[i] = s += weight[i];
  const pick = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = rand() * cum[n - 1];
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
    pick.set(pts.subarray(3 * lo, 3 * lo + 3), 3 * i);
  }
  return kmeans(pick, k, 12, rand).c;
}

/**
 * The target shape, its zones and each zone's quota of smart particles.
 * detail: protect thin parts. Thin areas weigh more, so they get more zones, a bigger share of
 * particles and tighter spacing (otherwise a leg with tiny area gets one particle and vanishes).
 */
export function createWorld({ smart = 600, zones = 96, targetN = 6000, seed = 7, shape: spec = { kind: "heart" }, detail = true } = {}) {
  const rand = mulberry(seed);
  const shape = createShape(spec);
  const target = sampleSurface(shape, targetN, rand);
  // ideal spacing between smart particles on the surface: mean nearest-neighbour distance
  // of an even spread (k-means with one centre per smart particle)
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
  const spacing = s / smart;

  // detail weight per target point: 1 on broad areas, up to 8 where the shape is much thinner
  // than the particle spacing
  const thick = halfThickness(shape, target);
  const weight = new Float32Array(targetN).fill(1);
  if (detail) for (let p = 0; p < targetN; p++) weight[p] = Math.min(8, Math.max(1, (0.45 * spacing / Math.max(thick[p], 0.004)) ** 1.5));
  // thin parts, for measuring (the same with or without detail mode)
  const thin = Uint8Array.from(thick, (t) => (t < 0.35 * spacing ? 1 : 0));

  // zones: more of them where the weight is high; quota = the zone's share of the total weight
  const zc = detail ? weightedCentres(target, weight, zones, rand) : kmeans(target, zones, 12, rand).c;
  const zoneW = new Float64Array(zones), zoneN = new Int32Array(zones);
  for (let p = 0; p < targetN; p++) {
    let best = 0, bd = Infinity;
    for (let j = 0; j < zones; j++) {
      const d = (target[3 * p] - zc[3 * j]) ** 2 + (target[3 * p + 1] - zc[3 * j + 1]) ** 2 + (target[3 * p + 2] - zc[3 * j + 2]) ** 2;
      if (d < bd) { bd = d; best = j; }
    }
    zoneW[best] += weight[p];
    zoneN[best]++;
  }
  const totalW = zoneW.reduce((a, b) => a + b, 0);
  const quota = new Int32Array(zones);
  const minQuota = detail ? 2 : 0; // every zone that holds part of the shape is guaranteed particles
  let left = smart;
  for (let j = 0; j < zones; j++) {
    quota[j] = zoneN[j] ? Math.max(minQuota, Math.floor((zoneW[j] / totalW) * smart)) : 0;
    left -= quota[j];
  }
  // hand out (or take back) the rounding difference, starting with the largest zones
  const bySize = [...Array(zones).keys()].sort((a, b) => zoneW[b] - zoneW[a]);
  for (let k = 0; left !== 0; k = (k + 1) % zones) {
    const j = bySize[k];
    if (left > 0) { quota[j]++; left--; } else if (quota[j] > minQuota) { quota[j]--; left++; }
  }
  // each zone's own spacing: denser where the weight is high (density ∝ weight)
  const meanW = totalW / targetN;
  const zoneSpacing = Float32Array.from({ length: zones }, (_, j) => spacing * Math.sqrt(meanW / (zoneN[j] ? zoneW[j] / zoneN[j] : 1)));
  const km = { c: zc };

  // each zone's 6 nearest zones (for the learned brain's view of the neighbourhood)
  const nbr = new Int32Array(zones * 6);
  for (let j = 0; j < zones; j++) {
    const order = [...Array(zones).keys()].filter((k) => k !== j)
      .sort((a, b) => dz2(km.c, j, a) - dz2(km.c, j, b));
    nbr.set(order.slice(0, 6), j * 6);
  }
  const names = Array.from({ length: zones }, (_, j) => zoneName(shape.name, km.c[3 * j], km.c[3 * j + 1], km.c[3 * j + 2]));
  return {
    shape, spec, target, targetN, zones, zc: km.c, quota, names, nbr, smart, spacing,
    zoneSpacing, maxSpacing: Math.max(...zoneSpacing), weight, thin, thinShare: thin.reduce((a, b) => a + b, 0) / targetN,
  };
}
const dz2 = (c, a, b) => (c[3 * a] - c[3 * b]) ** 2 + (c[3 * a + 1] - c[3 * b + 1]) ** 2 + (c[3 * a + 2] - c[3 * b + 2]) ** 2;

// ---- the learned brain -------------------------------------------------------------------------
// One small network shared by all zones. For zone j it reads
//   fullness   smart particles in the zone / its quota
//   around     mean fullness of its 6 nearest zones
//   strays     share of smart particles off the heart
// and outputs a call strength. Smart particles head for zones that call, weighed by distance.

export const BRAIN_IN = 3, BRAIN_HIDDEN = 8;
export const BRAIN_PARAMS = BRAIN_IN * BRAIN_HIDDEN + BRAIN_HIDDEN + BRAIN_HIDDEN + 1;

export function brainCall(w, fullness, around, strays) {
  let o = w[BRAIN_PARAMS - 1];
  const b1 = BRAIN_IN * BRAIN_HIDDEN, w2 = b1 + BRAIN_HIDDEN;
  for (let h = 0; h < BRAIN_HIDDEN; h++) {
    const a = w[h * 3] * fullness + w[h * 3 + 1] * around + w[h * 3 + 2] * strays + w[b1 + h];
    o += w[w2 + h] * Math.tanh(a);
  }
  return o;
}

// ---- the swarm ---------------------------------------------------------------------------------

export class Swarm {
  constructor(world, { followers = 0, mode = "planner", brain = null } = {}) {
    this.w = world;
    this.mode = mode;
    this.brain = brain;
    const n = world.smart;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.zone = new Int32Array(n).fill(-1); // planner: instruction "go to / hold this zone"
    this.call = new Float32Array(world.zones); // learned: call strength per zone
    this.acc = new Float32Array(n * 3);
    this.h = new Float32Array(n).fill(world.spacing); // each smart particle's spacing: its zone's
    this.n3 = new Float64Array(3);
    this.projectFollowers = true; // keep followers on the true surface (thin parts)
    this.report = [];
    this.stats = { orders: 0, strays: 0, missing: 0, crowded: 0, surfErr: 0, coverage: 0 };
    this.fPos = new Float32Array(0);
    this.fOff = new Float32Array(0);
    this.setFollowers(followers);
  }

  setFollowers(count) {
    const old = this.fPos, n = this.w.smart;
    this.followers = count;
    this.fPos = new Float32Array(count * 3);
    this.fOff = new Float32Array(count * 3);
    const r = mulberry(11);
    for (let i = 0; i < count; i++) {
      this.fOff[3 * i] = r() * 2 - 1; this.fOff[3 * i + 1] = r() * 2 - 1; this.fOff[3 * i + 2] = r() * 2 - 1;
      if (3 * i + 2 < old.length) this.fPos.set(old.subarray(3 * i, 3 * i + 3), 3 * i);
      else this.fPos.set(this.pos.subarray(3 * (i % n), 3 * (i % n) + 3), 3 * i);
    }
  }

  /** Everyone back to a small blob in the middle. */
  blob(rand = Math.random) {
    const n = this.w.smart;
    for (let i = 0; i < n; i++) {
      const u = rand() * Math.PI * 2, v = Math.acos(rand() * 2 - 1), rad = 0.15 * Math.cbrt(rand());
      this.pos[3 * i] = rad * Math.sin(v) * Math.cos(u);
      this.pos[3 * i + 1] = rad * Math.cos(v);
      this.pos[3 * i + 2] = rad * Math.sin(v) * Math.sin(u);
    }
    this.vel.fill(0);
    this.zone.fill(-1);
    this.call.fill(0);
    for (let i = 0; i < this.followers; i++) this.fPos.set(this.pos.subarray(3 * (i % n), 3 * (i % n) + 3), 3 * i);
    this.report.length = 0;
  }

  nearestZone(x, y, z) {
    const c = this.w.zc;
    let best = 0, bd = Infinity;
    for (let j = 0; j < this.w.zones; j++) {
      const d = (x - c[3 * j]) ** 2 + (y - c[3 * j + 1]) ** 2 + (z - c[3 * j + 2]) ** 2;
      if (d < bd) { bd = d; best = j; }
    }
    return best;
  }

  /** Who is where: smart particles per zone, and who is off the heart. */
  census() {
    const { zones, smart, spacing } = this.w;
    const count = new Int32Array(zones), members = Array.from({ length: zones }, () => []), strays = [];
    for (let i = 0; i < smart; i++) {
      const x = this.pos[3 * i], y = this.pos[3 * i + 1], z = this.pos[3 * i + 2];
      if (Math.abs(this.w.shape.dist(x, y, z, this.n3)) > spacing * 2) { strays.push(i); continue; }
      const j = this.nearestZone(x, y, z);
      count[j]++;
      members[j].push(i);
      this.h[i] = this.w.zoneSpacing[j];
    }
    return { count, members, strays };
  }

  orchestrate() {
    if (this.mode === "learned") this.orchestrateLearned();
    else this.orchestratePlanner();
  }

  orchestratePlanner() {
    const { zones, quota, names } = this.w;
    const { count, members, strays } = this.census();
    const need = [], spare = [], problems = [];
    let missing = 0, crowded = 0;
    for (let j = 0; j < zones; j++) {
      const d = quota[j] - count[j];
      if (d > 0) { missing += d; for (let k = 0; k < d; k++) need.push(j); }
      if (d < 0) {
        crowded -= d;
        // send away the ones furthest from the zone centre
        members[j].sort((a, b) => this.dist2zone(b, j) - this.dist2zone(a, j));
        for (let k = 0; k < -d; k++) spare.push(members[j][k]);
      }
      if (Math.abs(d) >= 3) problems.push([Math.abs(d), d > 0 ? `${names[j]}: missing ${d}` : `${names[j]}: ${-d} too many`]);
    }
    // strays first, then spares, each to the nearest zone that still needs someone
    let orders = 0;
    const strayed = new Set(strays);
    for (const i of [...strays, ...spare]) {
      if (!need.length) {
        if (this.zone[i] < 0 || strayed.has(i)) this.setOrder(i, this.nearestZone(this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]));
        continue;
      }
      let bk = 0, bd = Infinity;
      for (let k = 0; k < need.length; k++) {
        const d = this.dist2zone(i, need[k]);
        if (d < bd) { bd = d; bk = k; }
      }
      if (this.setOrder(i, need[bk])) orders++;
      need.splice(bk, 1);
    }
    // settled in a zone that is fine: "hold your zone"
    for (let j = 0; j < zones; j++) for (const i of members[j]) if (this.zone[i] < 0) this.setOrder(i, j);
    Object.assign(this.stats, { orders, strays: strays.length, missing, crowded });
    problems.sort((a, b) => b[0] - a[0]);
    const lines = [];
    if (strays.length) lines.push(`${strays.length} smart particles are off the heart: sent back`);
    for (const [, text] of problems.slice(0, 4)) lines.push(text);
    if (orders) lines.push(`${orders} new instructions sent`);
    if (!lines.length) lines.push("All zones on plan. Holding the shape.");
    this.report.splice(0, this.report.length, ...lines);
  }

  orchestrateLearned() {
    const { zones, quota, nbr, names, smart } = this.w;
    const { count, strays } = this.census();
    const full = new Float32Array(zones);
    for (let j = 0; j < zones; j++) full[j] = Math.min(3, count[j] / quota[j]);
    const strayShare = strays.length / smart;
    let missing = 0, crowded = 0;
    for (let j = 0; j < zones; j++) {
      let around = 0;
      for (let k = 0; k < 6; k++) around += full[nbr[j * 6 + k]];
      this.call[j] = brainCall(this.brain, full[j], around / 6, strayShare);
      const d = quota[j] - count[j];
      if (d > 0) missing += d; else crowded -= d;
    }
    Object.assign(this.stats, { orders: 0, strays: strays.length, missing, crowded });
    // report the loudest calls: where the brain thinks help is needed
    const loud = [...this.call.keys()].sort((a, b) => this.call[b] - this.call[a]).slice(0, 4);
    this.report.splice(0, this.report.length, ...loud.map((j) => `calling ${names[j]} (${this.call[j].toFixed(2)}, ${count[j]}/${quota[j]} there)`));
  }

  dist2zone(i, j) {
    const c = this.w.zc;
    return (this.pos[3 * i] - c[3 * j]) ** 2 + (this.pos[3 * i + 1] - c[3 * j + 1]) ** 2 + (this.pos[3 * i + 2] - c[3 * j + 2]) ** 2;
  }

  setOrder(i, j) {
    if (this.zone[i] === j) return false;
    this.zone[i] = j;
    return true;
  }

  /** Smart particles: carry out the instruction, sense the surface, keep spacing. */
  /** Neighbours by spatial grid (cell = the largest reach), so thousands of smart particles stay fast. */
  buildGrid() {
    const cell = this.w.maxSpacing * 1.5, G = Math.max(1, Math.ceil(5 / cell)), n = this.w.smart, pos = this.pos;
    const cellOf = (v) => Math.max(0, Math.min(G - 1, Math.floor((v + 2.5) / cell)));
    if (!this.grid || this.grid.G !== G) this.grid = { G, start: new Int32Array(G * G * G + 1), items: new Int32Array(n), cellIx: new Int32Array(n) };
    const g = this.grid;
    g.start.fill(0);
    for (let i = 0; i < n; i++) {
      const c = cellOf(pos[3 * i]) + G * (cellOf(pos[3 * i + 1]) + G * cellOf(pos[3 * i + 2]));
      g.cellIx[i] = c;
      g.start[c + 1]++;
    }
    for (let c = 0; c < G * G * G; c++) g.start[c + 1] += g.start[c];
    const fill = g.start.slice(0, G * G * G);
    for (let i = 0; i < n; i++) g.items[fill[g.cellIx[i]]++] = i;
    g.cellOf = cellOf;
    return g;
  }

  stepSmart(dt) {
    const { smart, spacing: h, zones, zc } = this.w;
    const pos = this.pos, vel = this.vel, acc = this.acc, n3 = this.n3, hs = this.h;
    acc.fill(0);
    // keep spacing from neighbours; the spacing is each pair's own (tighter on thin parts)
    const g = this.buildGrid(), G = g.G;
    for (let i = 0; i < smart; i++) {
      const xi = pos[3 * i], yi = pos[3 * i + 1], zi = pos[3 * i + 2];
      const cx = g.cellOf(xi), cy = g.cellOf(yi), cz = g.cellOf(zi);
      for (let a = Math.max(0, cz - 1); a <= Math.min(G - 1, cz + 1); a++) for (let b = Math.max(0, cy - 1); b <= Math.min(G - 1, cy + 1); b++) for (let c = Math.max(0, cx - 1); c <= Math.min(G - 1, cx + 1); c++) {
        const cellId = c + G * (b + G * a);
        for (let k = g.start[cellId]; k < g.start[cellId + 1]; k++) {
          const j = g.items[k];
          if (j <= i) continue;
          const dx = xi - pos[3 * j], dy = yi - pos[3 * j + 1], dz = zi - pos[3 * j + 2];
          const d2 = dx * dx + dy * dy + dz * dz, reach = 0.75 * (hs[i] + hs[j]); // 1.5 × the pair's spacing
          if (d2 >= reach * reach || d2 < 1e-12) continue;
          const d = Math.sqrt(d2), f = ((reach - d) / reach) * 3.5 / d;
          acc[3 * i] += dx * f; acc[3 * i + 1] += dy * f; acc[3 * i + 2] += dz * f;
          acc[3 * j] -= dx * f; acc[3 * j + 1] -= dy * f; acc[3 * j + 2] -= dz * f;
        }
      }
    }
    const learned = this.mode === "learned";
    for (let i = 0; i < smart; i++) {
      const o = 3 * i;
      const x = pos[o], y = pos[o + 1], z = pos[o + 2];
      const dist = this.w.shape.dist(x, y, z, n3);
      const nx = n3[0], ny = n3[1], nz = n3[2];
      // spacing only slides along the surface
      const an = acc[o] * nx + acc[o + 1] * ny + acc[o + 2] * nz;
      let ax = acc[o] - an * nx, ay = acc[o + 1] - an * ny, az = acc[o + 2] - an * nz;
      // where to go: the planner's instruction, or the zone the brain's calls make most worth it
      let tx = 0, ty = 0, tz = 0, has = false;
      if (learned) {
        let best = -Infinity, bj = 0;
        for (let j = 0; j < zones; j++) {
          const v = this.call[j] - Math.sqrt((x - zc[3 * j]) ** 2 + (y - zc[3 * j + 1]) ** 2 + (z - zc[3 * j + 2]) ** 2) * 2;
          if (v > best) { best = v; bj = j; }
        }
        tx = zc[3 * bj] - x; ty = zc[3 * bj + 1] - y; tz = zc[3 * bj + 2] - z; has = true;
      } else if (this.zone[i] >= 0) {
        const j = this.zone[i];
        tx = zc[3 * j] - x; ty = zc[3 * j + 1] - y; tz = zc[3 * j + 2] - z; has = true;
      }
      if (has) {
        const td = Math.hypot(tx, ty, tz);
        const pull = td > h * 2 ? 6 : td * 1.5; // travel fast when far, relax when there
        if (td > 1e-6) { ax += (tx / td) * pull; ay += (ty / td) * pull; az += (tz / td) * pull; }
      }
      // sense the surface: settle onto it
      const k = Math.max(-1.2, Math.min(1.2, dist)) * 30;
      ax -= nx * k; ay -= ny * k; az -= nz * k;
      let vx = (vel[o] + ax * dt) * 0.9, vy = (vel[o + 1] + ay * dt) * 0.9, vz = (vel[o + 2] + az * dt) * 0.9;
      const sp = Math.hypot(vx, vy, vz), max = 2.2;
      if (sp > max) { vx *= max / sp; vy *= max / sp; vz *= max / sp; }
      vel[o] = vx; vel[o + 1] = vy; vel[o + 2] = vz;
      pos[o] = x + vx * dt; pos[o + 1] = y + vy * dt; pos[o + 2] = z + vz * dt;
    }
  }

  /**
   * Followers: stay near your smart particle, spread over its patch of surface. The patch is as
   * wide as the leader's spacing (narrower on thin parts), and the spot is pulled back onto the
   * true surface, so followers on a thin leg wrap round the leg instead of floating beside it.
   */
  stepFollowers(dt, t, buzz = 0.4) {
    const { smart, spacing } = this.w, pos = this.pos, fPos = this.fPos, fOff = this.fOff, n3 = this.n3, shape = this.w.shape;
    const k = 1 - Math.exp(-dt * 9);
    // each leader's surface direction, once per frame
    if (!this.lNorm || this.lNorm.length !== smart * 3) this.lNorm = new Float32Array(smart * 3);
    const ln = this.lNorm;
    for (let j = 0; j < smart; j++) {
      shape.dist(pos[3 * j], pos[3 * j + 1], pos[3 * j + 2], n3);
      ln[3 * j] = n3[0]; ln[3 * j + 1] = n3[1]; ln[3 * j + 2] = n3[2];
    }
    for (let i = 0; i < this.followers; i++) {
      const j = i % smart, o = 3 * i, h = this.h[j];
      const r = h * 0.75, wob = buzz * h * 0.15;
      const lx = pos[3 * j], ly = pos[3 * j + 1], lz = pos[3 * j + 2];
      const nx = ln[3 * j], ny = ln[3 * j + 1], nz = ln[3 * j + 2];
      let ox = fOff[o], oy = fOff[o + 1], oz = fOff[o + 2];
      const on = ox * nx + oy * ny + oz * nz;
      ox -= on * nx; oy -= on * ny; oz -= on * nz;
      let tx = lx + ox * r + Math.sin(t * 2.3 + i) * wob;
      let ty = ly + oy * r + Math.sin(t * 1.7 + i * 1.3) * wob;
      let tz = lz + oz * r + Math.sin(t * 2.9 + i * 0.7) * wob;
      if (this.projectFollowers && h < spacing * 0.9) { // only where the shape is detailed: broad areas don't need it
        const d = shape.dist(tx, ty, tz, n3);
        tx -= d * n3[0]; ty -= d * n3[1]; tz -= d * n3[2];
      }
      fPos[o] += (tx - fPos[o]) * k; fPos[o + 1] += (ty - fPos[o + 1]) * k; fPos[o + 2] += (tz - fPos[o + 2]) * k;
    }
  }

  /**
   * How identical: share of target points with a particle within tol, and the mean distance
   * of the particles to the true surface. `points` defaults to the followers.
   */
  measure(points = this.fPos, count = this.followers, tol = this.w.spacing * 0.5) {
    const { target, targetN } = this.w;
    let err = 0;
    for (let i = 0; i < count; i++) err += Math.abs(this.w.shape.dist(points[3 * i], points[3 * i + 1], points[3 * i + 2], this.n3));
    const cell = tol, grid = new Map();
    const key = (a, b, c) => (a * 73856093) ^ (b * 19349663) ^ (c * 83492791);
    for (let i = 0; i < count; i++) {
      const kk = key(Math.floor(points[3 * i] / cell), Math.floor(points[3 * i + 1] / cell), Math.floor(points[3 * i + 2] / cell));
      let list = grid.get(kk);
      if (!list) grid.set(kk, (list = []));
      list.push(i);
    }
    let hit = 0, thinHit = 0, thinN = 0;
    const thin = this.w.thin;
    for (let p = 0; p < targetN; p++) {
      const x = target[3 * p], y = target[3 * p + 1], z = target[3 * p + 2];
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      let found = false;
      for (let a = -1; a <= 1 && !found; a++) for (let b = -1; b <= 1 && !found; b++) for (let c = -1; c <= 1 && !found; c++) {
        const list = grid.get(key(cx + a, cy + b, cz + c));
        if (!list) continue;
        for (const i of list) {
          if ((points[3 * i] - x) ** 2 + (points[3 * i + 1] - y) ** 2 + (points[3 * i + 2] - z) ** 2 < tol * tol) { found = true; break; }
        }
      }
      if (found) hit++;
      if (thin[p]) { thinN++; if (found) thinHit++; }
    }
    this.stats.coverage = hit / targetN;
    this.stats.thinCoverage = thinN ? thinHit / thinN : null; // the thin parts on their own
    this.stats.surfErr = err / Math.max(1, count);
    return this.stats.coverage;
  }

  /** Damage for the orchestrator to fix: kick the smart particles near a point. */
  scatter(cx, cy, cz, radius, strength, rand = Math.random) {
    for (let i = 0; i < this.w.smart; i++) {
      const dx = this.pos[3 * i] - cx, dy = this.pos[3 * i + 1] - cy, dz = this.pos[3 * i + 2] - cz;
      if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
      this.vel[3 * i] += (rand() * 2 - 1 + dx) * strength;
      this.vel[3 * i + 1] += (rand() * 2 - 1 + dy) * strength;
      this.vel[3 * i + 2] += (rand() * 2 - 1 + dz) * strength;
    }
  }
}

/**
 * One training/benchmark episode: a blob builds the heart, then a patch is scattered and must
 * be repaired. Score = mean "no holes" coverage of the smart particles at checkpoints: share of
 * the true surface with a smart particle within one spacing (0..1, higher is better).
 * Measured: an untrained brain ≈ no orchestrator ≈ 0.73 at the end; the hand-written planner ≈ 0.92.
 */
export const EPISODE_STEPS = 600, EPISODE_DAMAGE = 300;
export function episode(world, { mode, brain, seed }) {
  const rand = mulberry(seed);
  const s = new Swarm(world, { mode, brain });
  s.blob(rand);
  const checks = [200, 299, 360, 450, 525, 599];
  let score = 0;
  for (let step = 0; step < EPISODE_STEPS; step++) {
    if (step % 10 === 0 && mode !== "none") s.orchestrate();
    if (step === EPISODE_DAMAGE) {
      const i = Math.floor(rand() * world.smart);
      s.scatter(s.pos[3 * i], s.pos[3 * i + 1], s.pos[3 * i + 2], 0.6, 3, rand);
    }
    s.stepSmart(1 / 120);
    if (checks.includes(step)) score += s.measure(s.pos, world.smart, world.spacing);
  }
  return score / checks.length;
}
