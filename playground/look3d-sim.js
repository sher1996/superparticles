// "Look and correct": the swarm works out a 3D form from one picture. No DOM here.
//
//   orchestrator  has only a camera. It renders where the smart particles are, seen from the
//                 front (orthographic, same framing as the picture), compares that with the
//                 picture's silhouette and sends particles from where there is too much to
//                 where something is missing. Its zones are image regions, not surface patches.
//   smart         decide their own depth from soft preferences only:
//                   - "air pressure": a depth budget h that every particle computes from its
//                     neighbours (h = their mean + a little; zero where it finds itself on the
//                     outline). That is a Poisson equation solved by gossip, the same thing a
//                     balloon's skin does: thick in the middle, thin at the edges.
//                     depth = inflate · √(4h): a disc becomes a sphere, a strip a round tube.
//                   - front/back balance: each particle belongs to the front or back skin and
//                     switches if its side is crowded locally; both skins sit symmetrically
//                     around the middle plane its neighbours agree on.
//                   - even spacing from neighbours in 3D.
//   followers     stay near their smart particle, flat on its local skin.
//
// World frame: x right, y up, z towards the camera; the picture fits about [-1.1, 1.1].

import { mulberry } from "./heart3d-sim.js";

/** The picture as the orchestrator knows it: silhouette, framing and image regions. */
export function createLook({ mask, w, h, smart = 700, regions = 0, seed = 3 }) {
  const scale = 2.2 / Math.max(w, h); // world units per pixel
  const px = []; // mask pixels (world centre coordinates)
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (mask[j * w + i]) px.push((i + 0.5 - w / 2) * scale, -(j + 0.5 - h / 2) * scale, j * w + i);
  }
  const area = px.length / 3;
  const areaW = area * scale * scale;
  // per skin N/2 particles on a hexagonal grid over the silhouette's area
  const spacing2d = Math.sqrt((2 * areaW) / (smart * 0.866));

  // image regions: k-means on the silhouette's pixels
  const K = regions || Math.max(16, Math.min(80, Math.round(smart / 10)));
  const rand = mulberry(seed);
  const rc = new Float32Array(K * 2);
  for (let k = 0; k < K; k++) {
    const p = Math.floor(rand() * area);
    rc[2 * k] = px[3 * p]; rc[2 * k + 1] = px[3 * p + 1];
  }
  const regionOf = new Int16Array(w * h).fill(-1);
  const rArea = new Int32Array(K);
  const sx = new Float64Array(K), sy = new Float64Array(K);
  for (let it = 0; it < 12; it++) {
    rArea.fill(0); sx.fill(0); sy.fill(0);
    for (let p = 0; p < area; p++) {
      const x = px[3 * p], y = px[3 * p + 1];
      let best = 0, bd = Infinity;
      for (let k = 0; k < K; k++) {
        const d = (x - rc[2 * k]) ** 2 + (y - rc[2 * k + 1]) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
      regionOf[px[3 * p + 2]] = best;
      rArea[best]++; sx[best] += x; sy[best] += y;
    }
    for (let k = 0; k < K; k++) if (rArea[k]) { rc[2 * k] = sx[k] / rArea[k]; rc[2 * k + 1] = sy[k] / rArea[k]; }
  }
  // a region's centre must lie on the picture (a bent region's mean may not): snap to its nearest pixel
  for (let k = 0; k < K; k++) {
    let bd = Infinity, bx = rc[2 * k], by = rc[2 * k + 1];
    for (let p = 0; p < area; p++) {
      if (regionOf[px[3 * p + 2]] !== k) continue;
      const d = (px[3 * p] - rc[2 * k]) ** 2 + (px[3 * p + 1] - rc[2 * k + 1]) ** 2;
      if (d < bd) { bd = d; bx = px[3 * p]; by = px[3 * p + 1]; }
    }
    rc[2 * k] = bx; rc[2 * k + 1] = by;
  }
  const quota = new Float32Array(K), rRad = new Float32Array(K);
  for (let k = 0; k < K; k++) { quota[k] = (smart * rArea[k]) / area; rRad[k] = Math.sqrt(rArea[k] / Math.PI) * scale; }

  // names, relative to the picture's bounding box
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let p = 0; p < area; p++) {
    x0 = Math.min(x0, px[3 * p]); x1 = Math.max(x1, px[3 * p]);
    y0 = Math.min(y0, px[3 * p + 1]); y1 = Math.max(y1, px[3 * p + 1]);
  }
  const names = Array.from({ length: K }, (_, k) => {
    const u = (rc[2 * k] - x0) / (x1 - x0 || 1), v = (rc[2 * k + 1] - y0) / (y1 - y0 || 1);
    const side = u < 0.33 ? "left" : u > 0.67 ? "right" : "middle";
    const height = v > 0.67 ? "top" : v < 0.33 ? "bottom" : "middle";
    return height === "middle" && side === "middle" ? "centre" : height === "middle" ? `${side} side` : `${height} ${side}`;
  });
  return { mask, w, h, scale, smart, area, spacing2d, spacing: spacing2d * 1.1, K, rc, rRad, regionOf, rArea, quota, names, bbox: [x0, x1, y0, y1] };
}

export class LookSwarm {
  constructor(look, { followers = 0, inflate = 0.85, seed = 1 } = {}) {
    this.L = look;
    this.inflate = inflate;
    this.rand = mulberry(seed);
    const n = look.smart;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.acc = new Float32Array(n * 3);
    this.sheet = new Int8Array(n); // +1 front skin, −1 back skin
    this.hval = new Float32Array(n); // depth budget ("air")
    this.hTmp = new Float32Array(n);
    this.edge = new Float32Array(n); // how much a particle feels it is on the outline (0..1)
    this.mid = new Float32Array(n); // middle plane its neighbours agree on
    this.depth = new Float32Array(n);
    this.normal = new Float32Array(n * 3);
    this.order = new Int32Array(n).fill(-1); // orchestrator: region to go to / hold
    this.travel = new Uint8Array(n); // 1 = on its way to a region that needs it
    this.outside = new Uint8Array(n); // camera: projects outside the silhouette
    // neighbour lists (xy disc of radius R), rebuilt every step
    this.R = look.spacing2d * 2;
    this.nStart = new Int32Array(n + 1);
    this.nIdx = new Int32Array(n * 64);
    const cells = Math.ceil(4 / this.R);
    this.G = cells;
    this.cellStart = new Int32Array(cells * cells + 1);
    this.cellOf = new Int32Array(n);
    this.cellItems = new Int32Array(n);
    // camera
    this.cam = new Uint16Array(look.w * look.h);
    this.report = [];
    this.stats = { iou: 0, excessPx: 0, missingPx: 0, outside: 0, orders: 0, front: 0, back: 0, midDepth: 0, edgeDepth: 0, thickness: 0, width: 0 };
    this.fPos = new Float32Array(0);
    this.fOff = new Float32Array(0);
    this.followers = 0;
    this.setFollowers(followers);
  }

  setFollowers(count) {
    const old = this.fPos, n = this.L.smart;
    this.followers = count;
    this.fPos = new Float32Array(count * 3);
    this.fOff = new Float32Array(count * 3);
    const r = mulberry(11);
    for (let i = 0; i < count; i++) {
      // offsets in a unit disc (projected onto the local skin later)
      this.fOff[3 * i] = r() * 2 - 1; this.fOff[3 * i + 1] = r() * 2 - 1; this.fOff[3 * i + 2] = r() * 2 - 1;
      if (3 * i + 2 < old.length) this.fPos.set(old.subarray(3 * i, 3 * i + 3), 3 * i);
      else this.fPos.set(this.pos.subarray(3 * (i % n), 3 * (i % n) + 3), 3 * i);
    }
  }

  /** Everyone back to a small ball in the middle. */
  blob() {
    const n = this.L.smart, rand = this.rand;
    for (let i = 0; i < n; i++) {
      const u = rand() * Math.PI * 2, v = Math.acos(rand() * 2 - 1), rad = 0.15 * Math.cbrt(rand());
      this.pos[3 * i] = rad * Math.sin(v) * Math.cos(u);
      this.pos[3 * i + 1] = rad * Math.cos(v);
      this.pos[3 * i + 2] = rad * Math.sin(v) * Math.sin(u);
      this.sheet[i] = rand() < 0.5 ? 1 : -1;
      this.normal[3 * i + 2] = this.sheet[i];
    }
    this.vel.fill(0); this.hval.fill(0); this.mid.fill(0); this.depth.fill(0); this.edge.fill(0.5);
    this.order.fill(-1); this.travel.fill(0);
    for (let i = 0; i < this.followers; i++) this.fPos.set(this.pos.subarray(3 * (i % n), 3 * (i % n) + 3), 3 * i);
    this.report.length = 0;
  }

  /** Neighbours of every particle within R in the picture plane (both skins). */
  neighbours() {
    const n = this.L.smart, pos = this.pos, G = this.G, R = this.R, R2 = R * R;
    const cs = this.cellStart, cellOf = this.cellOf, items = this.cellItems;
    const cx = (x) => Math.max(0, Math.min(G - 1, Math.floor((x + 2) / R)));
    cs.fill(0);
    for (let i = 0; i < n; i++) { cellOf[i] = cx(pos[3 * i + 1]) * G + cx(pos[3 * i]); cs[cellOf[i] + 1]++; }
    for (let c = 0; c < G * G; c++) cs[c + 1] += cs[c];
    const fill = cs.slice(0, G * G);
    for (let i = 0; i < n; i++) items[fill[cellOf[i]]++] = i;
    const ns = this.nStart;
    let k = 0;
    for (let i = 0; i < n; i++) {
      ns[i] = k;
      const x = pos[3 * i], y = pos[3 * i + 1], gx = cx(x), gy = cx(y);
      for (let b = Math.max(0, gy - 1); b <= Math.min(G - 1, gy + 1); b++) {
        for (let a = Math.max(0, gx - 1); a <= Math.min(G - 1, gx + 1); a++) {
          const c = b * G + a;
          for (let q = cs[c]; q < cs[c + 1]; q++) {
            const j = items[q];
            if (j === i) continue;
            const dx = pos[3 * j] - x, dy = pos[3 * j + 1] - y;
            if (dx * dx + dy * dy >= R2) continue;
            if (k >= this.nIdx.length) { const grown = new Int32Array(this.nIdx.length * 2); grown.set(this.nIdx); this.nIdx = grown; }
            this.nIdx[k++] = j;
          }
        }
      }
    }
    ns[n] = k;
  }

  /** Smart particles: each one decides where it should be from its neighbours (and its order). */
  stepSmart(dt) {
    this.neighbours();
    const L = this.L, n = L.smart, pos = this.pos, vel = this.vel, acc = this.acc;
    const ns = this.nStart, nIdx = this.nIdx, R = this.R;

    // 1. outline sense: lopsided neighbourhood = I am on the edge
    for (let i = 0; i < n; i++) {
      const s = ns[i], e = ns[i + 1], cnt = e - s;
      let e1 = 1;
      if (cnt >= 5) {
        let cx = 0, cy = 0;
        for (let q = s; q < e; q++) { const j = nIdx[q]; cx += pos[3 * j] - pos[3 * i]; cy += pos[3 * j + 1] - pos[3 * i + 1]; }
        e1 = Math.hypot(cx, cy) / cnt / R;
        e1 = Math.min(1, Math.max(0, (e1 - 0.2) / 0.16)); // straight edge ≈ 0.42, inside ≈ 0.05
      }
      if (this.outside[i]) e1 = 1;
      this.edge[i] += (e1 - this.edge[i]) * 0.25;
    }

    // 2. air pressure: gossip the depth budget (Jacobi steps of  ∇²h = −1,  h = 0 on the outline)
    for (let pass = 0; pass < 3; pass++) {
      const hv = this.hval, ht = this.hTmp;
      for (let i = 0; i < n; i++) {
        const s = ns[i], e = ns[i + 1];
        if (e === s) { ht[i] = 0; continue; }
        let mh = 0, mr = 0;
        for (let q = s; q < e; q++) {
          const j = nIdx[q];
          mh += hv[j];
          mr += (pos[3 * j] - pos[3 * i]) ** 2 + (pos[3 * j + 1] - pos[3 * i + 1]) ** 2;
        }
        const cnt = e - s;
        ht[i] = (1 - this.edge[i]) * (mh / cnt + mr / cnt / 4);
      }
      this.hTmp = hv; this.hval = ht;
    }
    for (let i = 0; i < n; i++) this.depth[i] = this.inflate * Math.sqrt(4 * Math.max(0, this.hval[i]));

    // 3. middle plane (what the neighbours' skins imply), front/back balance, local skin normal
    const nrm = this.normal;
    for (let i = 0; i < n; i++) {
      const s = ns[i], e = ns[i + 1], si = this.sheet[i];
      let m = pos[3 * i + 2] - si * this.depth[i], c = 1, same = 0, other = 0;
      let Sxx = 0, Sxy = 0, Syy = 0, Sxz = 0, Syz = 0, ex = 0, ey = 0;
      for (let q = s; q < e; q++) {
        const j = nIdx[q];
        m += pos[3 * j + 2] - this.sheet[j] * this.depth[j]; c++;
        const dx = pos[3 * j] - pos[3 * i], dy = pos[3 * j + 1] - pos[3 * i + 1];
        ex += dx; ey += dy;
        if (this.sheet[j] === si) {
          same++;
          const dz = pos[3 * j + 2] - pos[3 * i + 2];
          Sxx += dx * dx; Sxy += dx * dy; Syy += dy * dy; Sxz += dx * dz; Syz += dy * dz;
        } else other++;
      }
      this.mid[i] += ((m / c) * 0.98 - this.mid[i]) * 0.3;
      // crowded on my side here, room on the other: switch skins (not on the outline, where they meet)
      if (this.edge[i] < 0.5 && same - other >= 4 && this.rand() < 0.02) this.sheet[i] = -si;
      // skin normal: least-squares slope of the neighbours' depth, outward on my side; on the outline, sideways
      const det = Sxx * Syy - Sxy * Sxy;
      let gx = 0, gy = 0;
      if (same >= 3 && det > 1e-12) { gx = (Sxz * Syy - Syz * Sxy) / det; gy = (Syz * Sxx - Sxz * Sxy) / det; }
      const gl = Math.hypot(gx, gy);
      if (gl > 6) { gx *= 6 / gl; gy *= 6 / gl; }
      let nx = -gx * si, ny = -gy * si, nz = si;
      let l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const el = Math.hypot(ex, ey), wr = this.edge[i];
      if (el > 1e-9) { nx = nx * (1 - wr) - (ex / el) * wr; ny = ny * (1 - wr) - (ey / el) * wr; nz *= 1 - wr; }
      l = Math.hypot(nx, ny, nz) || 1;
      nrm[3 * i] = nx / l; nrm[3 * i + 1] = ny / l; nrm[3 * i + 2] = nz / l;
    }

    // 4. forces: spacing (along the skin), the orchestrator's order (in the picture plane), own depth
    const hs = L.spacing, reach = 1.5 * hs, reach2 = reach * reach;
    acc.fill(0);
    for (let i = 0; i < n; i++) {
      const xi = pos[3 * i], yi = pos[3 * i + 1], zi = pos[3 * i + 2];
      for (let q = ns[i]; q < ns[i + 1]; q++) {
        const j = nIdx[q];
        const dx = xi - pos[3 * j], dy = yi - pos[3 * j + 1], dz = zi - pos[3 * j + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= reach2 || d2 < 1e-12) continue;
        const d = Math.sqrt(d2), f = ((reach - d) / reach) * 3.5 / d;
        acc[3 * i] += dx * f; acc[3 * i + 1] += dy * f; acc[3 * i + 2] += dz * f;
      }
    }
    const { rc, rRad } = L;
    for (let i = 0; i < n; i++) {
      const o = 3 * i, x = pos[o], y = pos[o + 1], z = pos[o + 2];
      const nx = nrm[o], ny = nrm[o + 1], nz = nrm[o + 2];
      const an = acc[o] * nx + acc[o + 1] * ny + acc[o + 2] * nz;
      let ax = acc[o] - an * nx, ay = acc[o + 1] - an * ny, az = acc[o + 2] - an * nz;
      const k = this.order[i];
      if (k >= 0) {
        const tx = rc[2 * k] - x, ty = rc[2 * k + 1] - y, td = Math.hypot(tx, ty);
        // travel fast when far or outside the picture, hold gently when there
        const pull = this.travel[i] || this.outside[i] ? (td > rRad[k] ? 7 : td * 6) : Math.min(6, td * 6);
        if (td > 1e-6) { ax += (tx / td) * pull; ay += (ty / td) * pull; }
      }
      // own depth: my skin, around the middle plane
      const zt = this.mid[i] + this.sheet[i] * this.depth[i];
      az += Math.max(-1, Math.min(1, zt - z)) * 30;
      let vx = (vel[o] + ax * dt) * 0.9, vy = (vel[o + 1] + ay * dt) * 0.9, vz = (vel[o + 2] + az * dt) * 0.9;
      const sp = Math.hypot(vx, vy, vz), max = 2.2;
      if (sp > max) { vx *= max / sp; vy *= max / sp; vz *= max / sp; }
      vel[o] = vx; vel[o + 1] = vy; vel[o + 2] = vz;
      pos[o] = x + vx * dt; pos[o + 1] = y + vy * dt; pos[o + 2] = z + vz * dt;
    }
  }

  /** Followers: stay near your smart particle, flat on its local skin. */
  stepFollowers(dt, t, buzz = 0.4) {
    const n = this.L.smart, sp = this.L.spacing, pos = this.pos, fPos = this.fPos, fOff = this.fOff, nrm = this.normal;
    const r = sp * 0.75, k = 1 - Math.exp(-dt * 9), wob = buzz * sp * 0.15;
    for (let i = 0; i < this.followers; i++) {
      const j = i % n, o = 3 * i;
      const nx = nrm[3 * j], ny = nrm[3 * j + 1], nz = nrm[3 * j + 2];
      let ox = fOff[o], oy = fOff[o + 1], oz = fOff[o + 2];
      const on = ox * nx + oy * ny + oz * nz;
      ox -= on * nx; oy -= on * ny; oz -= on * nz;
      const tx = pos[3 * j] + ox * r + Math.sin(t * 2.3 + i) * wob;
      const ty = pos[3 * j + 1] + oy * r + Math.sin(t * 1.7 + i * 1.3) * wob;
      const tz = pos[3 * j + 2] + oz * r + Math.sin(t * 2.9 + i * 0.7) * wob;
      fPos[o] += (tx - fPos[o]) * k; fPos[o + 1] += (ty - fPos[o + 1]) * k; fPos[o + 2] += (tz - fPos[o + 2]) * k;
    }
  }

  /** Camera pixel of a world point, or −1 outside the frame. */
  pixel(x, y) {
    const { w, h, scale } = this.L;
    const i = Math.floor(x / scale + w / 2), j = Math.floor(-y / scale + h / 2);
    return i < 0 || j < 0 || i >= w || j >= h ? -1 : j * w + i;
  }

  /**
   * The camera: where the smart particles are, seen from the front. Each particle covers a small
   * disc (about the gap to its neighbours). Returns the coverage image; sets IoU, excess, missing.
   */
  look() {
    const { w, h, scale, mask, smart, spacing2d } = this.L, cam = this.cam, pos = this.pos;
    cam.fill(0);
    const r = (0.62 * spacing2d) / scale, ri = Math.ceil(r), r2 = r * r;
    for (let p = 0; p < smart; p++) {
      const fx = pos[3 * p] / scale + w / 2, fy = -pos[3 * p + 1] / scale + h / 2;
      for (let j = Math.max(0, Math.floor(fy - ri)); j <= Math.min(h - 1, Math.floor(fy + ri)); j++) {
        for (let i = Math.max(0, Math.floor(fx - ri)); i <= Math.min(w - 1, Math.floor(fx + ri)); i++) {
          if ((i + 0.5 - fx) ** 2 + (j + 0.5 - fy) ** 2 <= r2) cam[j * w + i]++;
        }
      }
    }
    let inter = 0, uni = 0, excess = 0, missing = 0;
    for (let p = 0; p < w * h; p++) {
      const a = cam[p] > 0, b = mask[p] > 0;
      if (a && b) inter++;
      if (a || b) uni++;
      if (a && !b) excess++;
      if (b && !a) missing++;
    }
    Object.assign(this.stats, { iou: uni ? inter / uni : 0, excessPx: excess, missingPx: missing });
    return cam;
  }

  /** The orchestrator: look, compare with the picture, send particles from excess to missing. */
  orchestrate() {
    const L = this.L, { K, rc, quota, names, regionOf, mask, smart, scale, spacing2d } = L, pos = this.pos;
    const cam = this.look();
    // what the camera sees, per image region
    const count = new Int32Array(K), missPx = new Int32Array(K), members = Array.from({ length: K }, () => []);
    const out = [];
    for (let i = 0; i < smart; i++) {
      const p = this.pixel(pos[3 * i], pos[3 * i + 1]);
      if (p < 0 || !mask[p]) { this.outside[i] = 1; out.push(i); continue; }
      this.outside[i] = 0;
      const k = regionOf[p];
      count[k]++; members[k].push(i);
      if (this.travel[i] && this.order[i] === k) this.travel[i] = 0; // arrived
    }
    for (let p = 0; p < mask.length; p++) if (mask[p] && !cam[p]) missPx[regionOf[p]]++;
    // how many particles a hole needs: both skins, one per hexagonal cell
    const cellPx = (0.866 * spacing2d * spacing2d) / (scale * scale);
    const need = [], problems = [];
    let spare = [];
    for (let k = 0; k < K; k++) {
      const holes = Math.round((2 * missPx[k]) / cellPx);
      const incoming = this.travelling(k);
      const short = Math.max(holes, Math.ceil(quota[k] * 0.85 - count[k])) - incoming;
      if (short > 0) { for (let q = 0; q < short; q++) need.push(k); }
      if (missPx[k] >= cellPx && short > 0) problems.push([missPx[k], `${names[k]}: hole of ${missPx[k]} px, sending ${short}`]);
      const over = count[k] - Math.ceil(quota[k] * 1.25);
      if (over > 0 && missPx[k] === 0) {
        const cx = rc[2 * k], cy = rc[2 * k + 1];
        members[k].sort((a, b) => (pos[3 * b] - cx) ** 2 + (pos[3 * b + 1] - cy) ** 2 - (pos[3 * a] - cx) ** 2 - (pos[3 * a + 1] - cy) ** 2);
        spare = spare.concat(members[k].slice(0, over));
        if (over >= 3) problems.push([over * cellPx * 0.5, `${names[k]}: ${over} too many`]);
      }
    }
    // outside first, then spares: each to the nearest region that still needs someone
    let orders = 0;
    for (const i of [...out, ...spare]) {
      const x = pos[3 * i], y = pos[3 * i + 1];
      let bq = -1, bd = Infinity;
      for (let q = 0; q < need.length; q++) {
        const d = (x - rc[2 * need[q]]) ** 2 + (y - rc[2 * need[q] + 1]) ** 2;
        if (d < bd) { bd = d; bq = q; }
      }
      if (bq >= 0) {
        if (this.order[i] !== need[bq]) orders++;
        this.order[i] = need[bq]; this.travel[i] = 1;
        need.splice(bq, 1);
      } else if (this.outside[i]) {
        // nobody needs help: just come back to the nearest region
        let bk = 0; bd = Infinity;
        for (let k = 0; k < K; k++) { const d = (x - rc[2 * k]) ** 2 + (y - rc[2 * k + 1]) ** 2; if (d < bd) { bd = d; bk = k; } }
        this.order[i] = bk; this.travel[i] = 1;
      }
    }
    // everyone else on the picture: hold the region you are in
    for (let k = 0; k < K; k++) for (const i of members[k]) if (!this.travel[i]) this.order[i] = k;

    this.stats.orders = orders;
    this.stats.outside = out.length;
    problems.sort((a, b) => b[0] - a[0]);
    const lines = [];
    if (out.length) lines.push(`${out.length} smart particles outside the picture: sent back in`);
    for (const [, text] of problems.slice(0, 4)) lines.push(text);
    if (orders) lines.push(`${orders} new instructions sent`);
    if (!lines.length) lines.push("Camera matches the picture. Holding.");
    this.report.splice(0, this.report.length, ...lines);
  }

  travelling(k) {
    let c = 0;
    for (let i = 0; i < this.L.smart; i++) if (this.travel[i] && this.order[i] === k) c++;
    return c;
  }

  /** How the form came out in depth (nothing here feeds back into the swarm). */
  shapeStats() {
    const n = this.L.smart, pos = this.pos;
    let front = 0, back = 0, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    let mD = 0, mC = 0, eD = 0, eC = 0, hMax = 0;
    for (let i = 0; i < n; i++) if (this.hval[i] > hMax) hMax = this.hval[i];
    for (let i = 0; i < n; i++) {
      if (this.outside[i]) continue;
      if (this.sheet[i] > 0) front++; else back++;
      x0 = Math.min(x0, pos[3 * i]); x1 = Math.max(x1, pos[3 * i]);
      z0 = Math.min(z0, pos[3 * i + 2]); z1 = Math.max(z1, pos[3 * i + 2]);
      const d = Math.abs(pos[3 * i + 2] - this.mid[i]);
      if (this.edge[i] > 0.6) { eD += d; eC++; } else if (this.hval[i] > hMax * 0.7) { mD += d; mC++; }
    }
    Object.assign(this.stats, { front, back, midDepth: mC ? mD / mC : 0, edgeDepth: eC ? eD / eC : 0, thickness: z1 - z0, width: x1 - x0 });
    return this.stats;
  }

  /**
   * Damage: throw the smart particles near a point away from it, `throwDist` world units
   * (randomised), in random directions biased outward. Their instructions are forgotten.
   */
  scatter(cx, cy, cz, radius, throwDist) {
    const rand = this.rand;
    for (let i = 0; i < this.L.smart; i++) {
      const o = 3 * i;
      const dx = this.pos[o] - cx, dy = this.pos[o + 1] - cy, dz = this.pos[o + 2] - cz;
      if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
      let ux = rand() * 2 - 1 + dx * 2, uy = rand() * 2 - 1 + dy * 2, uz = rand() * 2 - 1 + dz * 2;
      const l = Math.hypot(ux, uy, uz) || 1, d = throwDist * (0.4 + rand() * 0.8);
      this.pos[o] += (ux / l) * d; this.pos[o + 1] += (uy / l) * d; this.pos[o + 2] += (uz / l) * d;
      this.vel[o] = this.vel[o + 1] = this.vel[o + 2] = 0;
      this.order[i] = -1; this.travel[i] = 0;
    }
  }

  /** Damage: squash everything flat (and let the air out) — it has to re-inflate on its own. */
  squash() {
    for (let i = 0; i < this.L.smart; i++) { this.pos[3 * i + 2] *= 0.05; this.vel[3 * i + 2] = 0; }
    this.hval.fill(0); this.mid.fill(0);
  }
}
