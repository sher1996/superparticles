// Carving a 3D shape from several 2D views, like a sculptor walking round the block.
//
// Nobody is given the 3D shape. The orchestrator only has CAMERAS: one per view (front, side,
// top), each holding the silhouette the user gave for that view. Every few frames it looks at the
// swarm through each camera and sends instructions:
//
//   carve   a camera sees a smart particle outside its outline: "move in, this way, this far"
//           (in that camera's image plane). Space any one view rules out is emptied.
//   settle  a particle every camera accepts is sent to its nearest wall: the outline edge of the
//           camera that is closest to ruling it out. So the swarm presses out against the walls
//           the cameras put up and ends on the surface of the carved shape (the visual hull).
//   fill    a camera sees part of its outline with nobody in it: the orchestrator casts that
//           pixel's ray through the OTHER cameras to find depths all views agree on, and sends a
//           particle from a crowded spot there.
//
// Smart particles carry out the instruction and keep their spacing; followers stay near their
// smart particle, flat on the surface, and obey the same camera walls. No 3D field of the shape is ever built: everything comes
// from per-camera checks of where the particles are.

import { mulberry } from "./heart3d-sim.js";

export const VIEWS = {
  front: { label: "Front", dir: "looking along −z" },
  side: { label: "Side", dir: "from the right, looking along −x" },
  top: { label: "Top", dir: "from above, looking along −y" },
};

/**
 * World → a camera's image plane (a to the right, b up) and depth d (towards the camera).
 *   front: a = x,  b = y,  d = z
 *   side:  a = −z, b = y,  d = x   (the object's front is on the left of a side image)
 *   top:   a = x,  b = −z, d = y   (the object's front is at the bottom of a top image)
 */
export function project(kind, x, y, z, out) {
  if (kind === "front") { out[0] = x; out[1] = y; out[2] = z; }
  else if (kind === "side") { out[0] = -z; out[1] = y; out[2] = x; }
  else { out[0] = x; out[1] = -z; out[2] = y; }
  return out;
}

/** A move (da, db) in a camera's image plane plus dd along its depth, as a 3D move. */
export function lift(kind, da, db, dd, out) {
  if (kind === "front") { out[0] = da; out[1] = db; out[2] = dd; }
  else if (kind === "side") { out[0] = dd; out[1] = db; out[2] = -da; }
  else { out[0] = da; out[1] = dd; out[2] = -db; }
  return out;
}

/** Cut a 0/1 mask down to the box around its pixels. */
function cropMask({ mask, w, h }) {
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!mask[j * w + i]) continue;
    if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; if (j > y1) y1 = j;
  }
  if (x1 < 0) return null;
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, out = new Uint8Array(cw * ch);
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) out[j * cw + i] = mask[(j + y0) * w + i + x0] ? 1 : 0;
  return { mask: out, w: cw, h: ch };
}

const PAD = 6;

/**
 * A camera: the silhouette on a padded pixel grid centred on the origin, `s` world units per
 * pixel. For every pixel it knows how far the outline is (negative inside, world units) and which
 * outline pixel is nearest: that is all the orchestrator uses to judge a particle.
 */
function makeCamera(kind, crop, s) {
  const W = crop.w + 2 * PAD, H = crop.h + 2 * PAD, mask = new Uint8Array(W * H);
  let area = 0;
  for (let j = 0; j < crop.h; j++) for (let i = 0; i < crop.w; i++) {
    if (crop.mask[j * crop.w + i]) { mask[(j + PAD) * W + i + PAD] = 1; area++; }
  }
  const at = (i, j) => i >= 0 && j >= 0 && i < W && j < H && mask[j * W + i] === 1;
  const edge = [];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (at(i, j) && (!at(i - 1, j) || !at(i + 1, j) || !at(i, j - 1) || !at(i, j + 1))) edge.push(i, j);
  }
  const sd = new Float32Array(W * H), ex = new Int16Array(W * H), ey = new Int16Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let best = Infinity, bk = 0;
    for (let k = 0; k < edge.length; k += 2) {
      const d = (edge[k] - i) ** 2 + (edge[k + 1] - j) ** 2;
      if (d < best) { best = d; bk = k; }
    }
    const p = j * W + i;
    sd[p] = (at(i, j) ? -(Math.sqrt(best) + 0.5) : Math.sqrt(best) - 0.5) * s;
    ex[p] = edge[bk]; ey[p] = edge[bk + 1];
  }
  return { kind, label: VIEWS[kind].label, W, H, s, mask, sd, ex, ey, area, cw: crop.w, ch: crop.h };
}

/** Pixel index of image-plane point (a, b), or −1 off the grid. */
export function pixel(cam, a, b) {
  const i = Math.floor(a / cam.s + cam.W / 2), j = Math.floor(-b / cam.s + cam.H / 2);
  return i < 0 || j < 0 || i >= cam.W || j >= cam.H ? -1 : j * cam.W + i;
}
const insideCam = (cam, a, b) => { const p = pixel(cam, a, b); return p >= 0 && cam.mask[p] === 1; };

/**
 * What a camera says about image-plane point (a, b): distance to its outline (negative inside)
 * and, in `e`, the nearest outline point (image plane, world units).
 */
function judge(cam, a, b, e) {
  const fi = a / cam.s + cam.W / 2, fj = -b / cam.s + cam.H / 2;
  const i = Math.max(0, Math.min(cam.W - 1, Math.floor(fi))), j = Math.max(0, Math.min(cam.H - 1, Math.floor(fj)));
  const p = j * cam.W + i;
  e[0] = (cam.ex[p] + 0.5 - cam.W / 2) * cam.s;
  e[1] = -(cam.ey[p] + 0.5 - cam.H / 2) * cam.s;
  return cam.sd[p] + Math.hypot(fi - Math.max(0, Math.min(cam.W, fi)), fj - Math.max(0, Math.min(cam.H, fj))) * cam.s;
}

/**
 * Cameras from the given silhouettes: { front, side?, top? }, each { mask, w, h } (row 0 at the
 * top). Front is needed plus at least one of side/top. Views are lined up by their bounding
 * boxes: side height = front height, top width = front width; the whole thing fits ~2.2 units.
 */
export function buildCameras(views) {
  const f = views.front && cropMask(views.front);
  const sd = views.side && cropMask(views.side);
  const tp = views.top && cropMask(views.top);
  if (!f) throw new Error("A front view is needed.");
  if (!sd && !tp) throw new Error("Give a side or a top view as well: one view can't tell the depth.");
  let sf = 1;
  const ss = sd ? (f.h * sf) / sd.h : 0, st = tp ? (f.w * sf) / tp.w : 0;
  const X = f.w * sf, Y = f.h * sf, Z = sd ? sd.w * ss : tp.h * st;
  const k = 2.2 / Math.max(X, Y, Z);
  const cams = [makeCamera("front", f, sf * k)];
  if (sd) cams.push(makeCamera("side", sd, ss * k));
  if (tp) cams.push(makeCamera("top", tp, st * k));
  return cams;
}

// ---- the swarm ---------------------------------------------------------------------------------

const NONE = 0, PLANE = 1, POINT = 2;

export class CarveSwarm {
  constructor(cams, { smart = 600, followers = 8000, seed = 3 } = {}) {
    this.n = smart;
    this.pos = new Float32Array(smart * 3);
    this.vel = new Float32Array(smart * 3);
    this.acc = new Float32Array(smart * 3);
    this.kind = new Uint8Array(smart);       // instruction: none / reach a wall (plane) / go to a point
    this.tgt = new Float32Array(smart * 3);  // instruction target
    this.dir = new Float32Array(smart * 3);  // PLANE: which way to move
    this.nrm = new Float32Array(smart * 3).fill(0); // outward surface direction (for followers)
    this.ttl = new Int16Array(smart);
    this.nb = new Uint8Array(smart);         // neighbours within reach: how crowded it is
    this.out = new Uint8Array(smart);        // some camera currently rules it out
    this.rand = mulberry(seed);
    this.report = [];
    this.fPos = new Float32Array(0);
    this.fOff = new Float32Array(0);
    this.followers = 0;
    this.v3 = new Float64Array(3); this.e2 = new Float64Array(2); this.m3 = new Float64Array(3);
    this.setCameras(cams);
    for (let i = 0; i < smart; i++) this.nrm[3 * i + 2] = 1;
    this.setFollowers(followers);
  }

  /** New views: the swarm keeps its place and gets re-carved. */
  setCameras(cams) {
    this.cams = cams;
    const front = cams[0], side = cams.find((c) => c.kind === "side"), top = cams.find((c) => c.kind === "top");
    const hx = (front.cw * front.s) / 2, hy = (front.ch * front.s) / 2;
    const hz = side ? (side.cw * side.s) / 2 : (top.ch * top.s) / 2;
    this.half = [hx, hy, hz];
    // spacing between smart particles, from the surface the cameras suggest: for a box the
    // surface is exactly 2 × (sum of the three projected areas); a ball is 4/3 ×. Take 1.7.
    const areaOf = (c) => c.area * c.s * c.s;
    const A = areaOf(front) + (side ? areaOf(side) : 4 * hy * hz * 0.8) + (top ? areaOf(top) : 4 * hx * hz * 0.8);
    const S = 1.7 * A;
    this.surface = S;
    this.h = Math.sqrt((2 * S) / (Math.sqrt(3) * this.n));
    this.reach = 1.6 * Math.max(hx, hy, hz) + 0.2;
    this.cover = cams.map((c) => new Uint8Array(c.W * c.H));   // what each camera sees of the smart team
    this.fCover = cams.map((c) => new Uint8Array(c.W * c.H));  // ... and of the followers (drawn)
    this.views = cams.map((c) => ({ kind: c.kind, label: c.label, match: 0, outside: 0, empty: 0, carved: 0, sent: 0, disagree: this.disagreement(c) }));
    this.kind.fill(NONE);
  }

  /** Share of a camera's outline that no depth agrees with in all the other cameras. */
  disagreement(cam) {
    let bad = 0;
    for (let j = 0; j < cam.H; j++) for (let i = 0; i < cam.W; i++) {
      if (!cam.mask[j * cam.W + i]) continue;
      if (!this.agree(cam, (i + 0.5 - cam.W / 2) * cam.s, -(j + 0.5 - cam.H / 2) * cam.s)) bad++;
    }
    return bad / cam.area;
  }

  /**
   * Cast the ray of image-plane point (a, b) of `cam` through every other camera. Returns the
   * nearest and furthest depth where all of them see something there, or null.
   */
  agree(cam, a, b) {
    // step half a pixel of the finest camera, so thin slivers aren't missed
    const steps = Math.ceil((2 * this.reach) / (0.5 * Math.min(...this.cams.map((c) => c.s)))), v = this.v3, q = this.m3;
    let d0 = NaN, d1 = NaN;
    for (let k = 0; k <= steps; k++) {
      const d = -this.reach + (2 * this.reach * k) / steps;
      lift(cam.kind, a, b, d, v);
      let ok = true;
      for (const other of this.cams) {
        if (other === cam) continue;
        project(other.kind, v[0], v[1], v[2], q);
        if (judge(other, q[0], q[1], this.e2) > other.s) { ok = false; break; } // a pixel of slack: views of different sizes round differently
      }
      if (ok) { if (Number.isNaN(d0)) d0 = d; d1 = d; }
    }
    return Number.isNaN(d0) ? null : [d0, d1];
  }

  setFollowers(count) {
    const old = this.fPos, n = this.n;
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

  /** Everyone back to a small lump in the middle: the uncarved block. */
  blob(rand = Math.random) {
    for (let i = 0; i < this.n; i++) {
      const u = rand() * Math.PI * 2, v = Math.acos(rand() * 2 - 1), rad = 0.15 * Math.cbrt(rand());
      this.pos[3 * i] = rad * Math.sin(v) * Math.cos(u);
      this.pos[3 * i + 1] = rad * Math.cos(v);
      this.pos[3 * i + 2] = rad * Math.sin(v) * Math.sin(u);
    }
    this.vel.fill(0);
    this.kind.fill(NONE);
    for (let i = 0; i < this.followers; i++) this.fPos.set(this.pos.subarray(3 * (i % this.n), 3 * (i % this.n) + 3), 3 * i);
    this.report.length = 0;
  }

  // ---- the orchestrator ----------------------------------------------------------------------

  /** Look at every smart particle through every camera: carve or settle. */
  orchestrate() {
    const { cams, pos, v3: q, e2: e, m3: mv } = this;
    for (const v of this.views) v.carved = 0;
    for (let i = 0; i < this.n; i++) {
      const o = 3 * i, x = pos[o], y = pos[o + 1], z = pos[o + 2];
      let sx = 0, sy = 0, sz = 0, out = false, far = 0, best = -Infinity, bx = 0, by = 0, bz = 0;
      for (let c = 0; c < cams.length; c++) {
        const cam = cams[c];
        project(cam.kind, x, y, z, q);
        const d = judge(cam, q[0], q[1], e);
        lift(cam.kind, e[0] - q[0], e[1] - q[1], 0, mv);
        if (d > far) far = d;
        if (d > 0) { out = true; sx += mv[0]; sy += mv[1]; sz += mv[2]; if (d > 0.5 * this.h) this.views[c].carved++; }
        else if (d > best) { best = d; bx = mv[0]; by = mv[1]; bz = mv[2]; }
      }
      this.out[i] = far > 0.5 * this.h ? 1 : 0; // clearly outside, not just resting on a wall
      if (this.kind[i] === POINT && !out) continue; // on its way to fill a gap
      if (out) {
        // carve: some camera rules this spot out, move in
        this.instructPlane(i, x, y, z, sx, sy, sz, -1);
      } else {
        // every camera accepts it: settle on the nearest wall they put up
        this.instructPlane(i, x, y, z, bx, by, bz, 1);
      }
    }
  }

  instructPlane(i, x, y, z, mx, my, mz, outward) {
    const o = 3 * i, len = Math.hypot(mx, my, mz);
    this.kind[i] = PLANE;
    this.tgt[o] = x + mx; this.tgt[o + 1] = y + my; this.tgt[o + 2] = z + mz;
    if (len < 1e-9) { this.dir.set(this.nrm.subarray(o, o + 3), o); return; }
    this.dir[o] = mx / len; this.dir[o + 1] = my / len; this.dir[o + 2] = mz / len;
    this.nrm[o] = outward * this.dir[o]; this.nrm[o + 1] = outward * this.dir[o + 1]; this.nrm[o + 2] = outward * this.dir[o + 2];
  }

  /** Splat points into a camera's image, each as a disc of radius r pixels (tally: count them). */
  splat(cam, grid, points, count, r, tally = false) {
    grid.fill(0);
    const q = this.v3, W = cam.W, H = cam.H, r2 = r * r + 0.5;
    for (let i = 0; i < count; i++) {
      project(cam.kind, points[3 * i], points[3 * i + 1], points[3 * i + 2], q);
      const ci = Math.floor(q[0] / cam.s + W / 2), cj = Math.floor(-q[1] / cam.s + H / 2);
      for (let dj = -r; dj <= r; dj++) {
        const j = cj + dj;
        if (j < 0 || j >= H) continue;
        for (let di = -r; di <= r; di++) {
          const ii = ci + di;
          if (ii < 0 || ii >= W || di * di + dj * dj > r2) continue;
          const p = j * W + ii;
          grid[p] = tally ? Math.min(255, grid[p] + 1) : 1;
        }
      }
    }
  }

  /** Compare each camera's outline with what it sees of the smart team; send particles to gaps. */
  fillGaps(perView = 10) {
    const { cams, pos, rand, v3: v } = this;
    let nbSum = 0;
    for (let i = 0; i < this.n; i++) nbSum += this.nb[i];
    const crowded = nbSum / this.n;
    for (let c = 0; c < cams.length; c++) {
      const cam = cams[c], grid = this.cover[c], st = this.views[c];
      // every ray through a closed surface meets it at least twice (front and back), so a camera
      // pixel is only filled when two smart particles are near it
      const r = Math.max(1, Math.round((0.6 * this.h) / cam.s));
      this.splat(cam, grid, pos, this.n, r, true);
      const gaps = [];
      for (let p = 0; p < grid.length; p++) if (cam.mask[p] && grid[p] < 2) gaps.push(p);
      st.empty = gaps.length / cam.area;
      st.sent = 0;
      if (gaps.length < cam.area * 0.003) continue;
      for (let t = 0; t < perView * 3 && st.sent < perView; t++) {
        const p = gaps[Math.floor(rand() * gaps.length)];
        if (grid[p] >= 2) continue; // filled by an order this round
        const i0 = p % cam.W, j0 = (p - i0) / cam.W;
        const a = (i0 + 0.5 - cam.W / 2) * cam.s, b = -(j0 + 0.5 - cam.H / 2) * cam.s;
        const span = this.agree(cam, a, b);
        if (!span) continue; // the other views rule this spot out everywhere
        // the gap's near and far surface: which of them has nobody? Send the closest particle
        // from a crowded spot there.
        const ends = span.map((d) => lift(cam.kind, a, b, d, new Float64Array(3)));
        const reach2 = (0.7 * this.h) ** 2, free = [true, true];
        for (let i = 0; i < this.n; i++) for (let k = 0; k < 2; k++) {
          if ((pos[3 * i] - ends[k][0]) ** 2 + (pos[3 * i + 1] - ends[k][1]) ** 2 + (pos[3 * i + 2] - ends[k][2]) ** 2 < reach2) free[k] = false;
        }
        if (!free[0] && !free[1]) continue;
        let bi = -1, bd = Infinity, be = 0;
        for (let i = 0; i < this.n; i++) {
          if (this.kind[i] === POINT || this.nb[i] < crowded) continue;
          for (let k = 0; k < 2; k++) {
            if (!free[k]) continue;
            const d = (pos[3 * i] - ends[k][0]) ** 2 + (pos[3 * i + 1] - ends[k][1]) ** 2 + (pos[3 * i + 2] - ends[k][2]) ** 2;
            if (d < bd) { bd = d; bi = i; be = k; }
          }
        }
        if (bi < 0) break;
        const o = 3 * bi;
        this.kind[bi] = POINT;
        this.ttl[bi] = 160;
        this.tgt.set(ends[be], o);
        lift(cam.kind, 0, 0, be ? 1 : -1, v); // outward: towards the camera on the near end
        this.nrm[o] = v[0]; this.nrm[o + 1] = v[1]; this.nrm[o + 2] = v[2];
        st.sent++;
        // mark it covered so this round doesn't send two to the same gap
        for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
          const ii = i0 + di, jj = j0 + dj;
          if (ii >= 0 && jj >= 0 && ii < cam.W && jj < cam.H && di * di + dj * dj <= r * r) grid[jj * cam.W + ii] = 2;
        }
      }
    }
    this.writeReport();
  }

  writeReport() {
    const lines = [];
    let touch = 0;
    for (const v of this.views) {
      if (v.carved) lines.push(`${v.label} camera: ${v.carved} smart particles outside its outline → carved back in`);
      if (v.sent && v.sent < 3) touch += v.sent;
      if (v.sent >= 3) lines.push(`${v.label} camera: ${(v.empty * 100).toFixed(1)}% of its outline empty → sent ${v.sent} to fill it`);
      if (v.disagree > 0.01) lines.push(`${v.label}: ${(v.disagree * 100).toFixed(0)}% of this outline is ruled out by the other views (they disagree)`);
    }
    if (!lines.some((l) => !l.includes("disagree"))) lines.unshift(`Every camera agrees with the swarm. Holding the shape${touch ? ` (touching up ${touch} small gap${touch > 1 ? "s" : ""})` : ""}.`);
    this.report.splice(0, this.report.length, ...lines);
  }

  // ---- the smart particles and followers ----------------------------------------------------

  /** Carry out the instruction, keep the spacing. */
  stepSmart(dt) {
    const { n, h, pos, vel, acc, tgt, dir, kind } = this;
    const h2 = h * h * 2.25;
    acc.fill(0);
    this.nb.fill(0);
    const nn = this.nn && this.nn.length === n ? this.nn : (this.nn = new Float32Array(n));
    nn.fill(h2);
    for (let i = 0; i < n; i++) {
      const xi = pos[3 * i], yi = pos[3 * i + 1], zi = pos[3 * i + 2];
      for (let j = i + 1; j < n; j++) {
        const dx = xi - pos[3 * j], dy = yi - pos[3 * j + 1], dz = zi - pos[3 * j + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= h2 || d2 < 1e-12) continue;
        const d = Math.sqrt(d2), f = ((1.5 * h - d) / (1.5 * h)) * 3.5 / d;
        acc[3 * i] += dx * f; acc[3 * i + 1] += dy * f; acc[3 * i + 2] += dz * f;
        acc[3 * j] -= dx * f; acc[3 * j + 1] -= dy * f; acc[3 * j + 2] -= dz * f;
        if (d2 < nn[i]) nn[i] = d2;
        if (d2 < nn[j]) nn[j] = d2;
        if (this.nb[i] < 255) this.nb[i]++;
        if (this.nb[j] < 255) this.nb[j]++;
      }
    }
    let nnSum = 0;
    for (let i = 0; i < n; i++) nnSum += Math.sqrt(nn[i]);
    this.gap = nnSum / n; // how far apart the smart particles actually are
    for (let i = 0; i < n; i++) {
      const o = 3 * i, x = pos[o], y = pos[o + 1], z = pos[o + 2];
      let ax = acc[o], ay = acc[o + 1], az = acc[o + 2];
      if (kind[i] === POINT) {
        // travel to the gap the orchestrator named
        const tx = tgt[o] - x, ty = tgt[o + 1] - y, tz = tgt[o + 2] - z, td = Math.hypot(tx, ty, tz);
        const pull = td > 2 * h ? 9 : td * 4.5 + 0.5;
        if (td > 1e-6) { ax += (tx / td) * pull; ay += (ty / td) * pull; az += (tz / td) * pull; }
        if (td < 0.5 * h || --this.ttl[i] <= 0) kind[i] = NONE;
      } else if (kind[i] === PLANE) {
        // move along the instructed direction until the wall is reached; sideways is free
        const dx = dir[o], dy = dir[o + 1], dz = dir[o + 2];
        const dn = (tgt[o] - x) * dx + (tgt[o + 1] - y) * dy + (tgt[o + 2] - z) * dz;
        // spacing only slides along the wall: crowding must not push anyone through it
        const an = ax * dx + ay * dy + az * dz;
        ax -= an * dx; ay -= an * dy; az -= an * dz;
        const k = Math.max(-1.2, Math.min(1.2, dn)) * 30;
        ax += dx * k; ay += dy * k; az += dz * k;
      }
      let vx = (vel[o] + ax * dt) * 0.9, vy = (vel[o + 1] + ay * dt) * 0.9, vz = (vel[o + 2] + az * dt) * 0.9;
      const sp = Math.hypot(vx, vy, vz), max = 2.2;
      if (sp > max) { vx *= max / sp; vy *= max / sp; vz *= max / sp; }
      vel[o] = vx; vel[o + 1] = vy; vel[o + 2] = vz;
      pos[o] = x + vx * dt; pos[o + 1] = y + vy * dt; pos[o + 2] = z + vz * dt;
    }
  }

  /** Followers: stay near your smart particle, flat on its surface. */
  stepFollowers(dt, t, buzz = 0.4) {
    const { n, h, pos, fPos, fOff, nrm, cams, v3: q, e2: e, m3: mv } = this;
    const r = Math.max(this.gap || 0, h) * 0.75, k = 1 - Math.exp(-dt * 9), wob = buzz * h * 0.15;
    for (let i = 0; i < this.followers; i++) {
      const j = i % n, o = 3 * i, lo = 3 * j;
      const nx = nrm[lo], ny = nrm[lo + 1], nz = nrm[lo + 2];
      let ox = fOff[o], oy = fOff[o + 1], oz = fOff[o + 2];
      const on = ox * nx + oy * ny + oz * nz;
      ox -= on * nx; oy -= on * ny; oz -= on * nz;
      let tx = pos[lo] + ox * r + Math.sin(t * 2.3 + i) * wob;
      let ty = pos[lo + 1] + oy * r + Math.sin(t * 1.7 + i * 1.3) * wob;
      let tz = pos[lo + 2] + oz * r + Math.sin(t * 2.9 + i * 0.7) * wob;
      // the cameras' walls hold for followers too (once their smart particle is back inside):
      // a spot outside an outline is moved onto it
      if (!this.out[j]) for (const cam of cams) {
        project(cam.kind, tx, ty, tz, q);
        if (judge(cam, q[0], q[1], e) <= 0) continue;
        lift(cam.kind, e[0] - q[0], e[1] - q[1], 0, mv);
        tx += mv[0]; ty += mv[1]; tz += mv[2];
      }
      fPos[o] += (tx - fPos[o]) * k; fPos[o + 1] += (ty - fPos[o + 1]) * k; fPos[o + 2] += (tz - fPos[o + 2]) * k;
    }
  }

  /**
   * How well each view matches: what the camera sees of the followers (each a small disc) against
   * the given outline, as overlap ÷ union (1 = identical), plus the share of followers it sees
   * outside its outline.
   */
  measure() {
    const { cams, fPos, followers, v3: q } = this;
    for (let c = 0; c < cams.length; c++) {
      const cam = cams[c], grid = this.fCover[c], st = this.views[c];
      // one pixel per dot, then close the pinholes between dots: grow, then shrink by the same
      // amount (the outline itself doesn't move)
      this.splat(cam, grid, fPos, followers, 0);
      const W = cam.W, tmp = this.tmp && this.tmp.length === grid.length ? this.tmp : (this.tmp = new Uint8Array(grid.length));
      const pass = (src, dst, grow) => {
        for (let j = 0; j < cam.H; j++) for (let i = 0; i < W; i++) {
          const p = j * W + i;
          const l = i > 0 ? src[p - 1] : 0, r = i < W - 1 ? src[p + 1] : 0, u = j > 0 ? src[p - W] : 0, d = j < cam.H - 1 ? src[p + W] : 0;
          dst[p] = grow ? (src[p] | l | r | u | d) : (src[p] & l & r & u & d);
        }
      };
      // close gaps up to about one dot spacing (on the surface the cameras suggest)
      const steps = Math.max(1, Math.round(Math.sqrt(this.surface / Math.max(1, followers)) / cam.s));
      for (let k = 0; k < steps; k++) { pass(grid, tmp, true); grid.set(tmp); }
      for (let k = 0; k < steps; k++) { pass(grid, tmp, false); grid.set(tmp); }
      let both = 0, either = 0;
      for (let p = 0; p < grid.length; p++) {
        if (cam.mask[p] && grid[p]) both++;
        if (cam.mask[p] || grid[p]) either++;
      }
      let out = 0;
      for (let i = 0; i < followers; i++) {
        project(cam.kind, fPos[3 * i], fPos[3 * i + 1], fPos[3 * i + 2], q);
        if (!insideCam(cam, q[0], q[1])) out++;
      }
      st.match = both / Math.max(1, either);
      st.outside = out / Math.max(1, followers);
    }
    return this.views.map((v) => v.match);
  }

  /** Damage: kick the smart particles near a point. */
  scatter(cx, cy, cz, radius, strength, rand = Math.random) {
    for (let i = 0; i < this.n; i++) {
      const dx = this.pos[3 * i] - cx, dy = this.pos[3 * i + 1] - cy, dz = this.pos[3 * i + 2] - cz;
      if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
      this.kind[i] = NONE;
      this.vel[3 * i] += (rand() * 2 - 1 + dx) * strength;
      this.vel[3 * i + 1] += (rand() * 2 - 1 + dy) * strength;
      this.vel[3 * i + 2] += (rand() * 2 - 1 + dz) * strength;
    }
  }

  /** Damage: blow everyone outwards, well past the outlines. */
  explode(rand = Math.random) {
    for (let i = 0; i < this.n; i++) {
      const o = 3 * i, x = this.pos[o], y = this.pos[o + 1], z = this.pos[o + 2], len = Math.hypot(x, y, z) || 1;
      const push = 0.3 + 0.7 * rand();
      this.kind[i] = NONE; this.out[i] = 1;
      this.pos[o] += (x / len) * push; this.pos[o + 1] += (y / len) * push; this.pos[o + 2] += (z / len) * push;
      this.vel[o] = (rand() - 0.5) * 2; this.vel[o + 1] = (rand() - 0.5) * 2; this.vel[o + 2] = (rand() - 0.5) * 2;
    }
  }

  /** Damage: throw a chunk well outside every outline, for the cameras to carve back. */
  throwOut(cx, cy, cz, radius, rand = Math.random) {
    const away = Math.hypot(cx, cy, cz) || 1;
    for (let i = 0; i < this.n; i++) {
      const o = 3 * i, dx = this.pos[o] - cx, dy = this.pos[o + 1] - cy, dz = this.pos[o + 2] - cz;
      if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
      this.kind[i] = NONE; this.out[i] = 1;
      this.pos[o] += (cx / away) * 0.9 + (rand() - 0.5) * 0.3;
      this.pos[o + 1] += (cy / away) * 0.9 + (rand() - 0.5) * 0.3;
      this.pos[o + 2] += (cz / away) * 0.9 + (rand() - 0.5) * 0.3;
    }
  }
}
