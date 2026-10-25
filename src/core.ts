/* SuperParticles – Core Physics & Arrays */

import type { Vec2, Bounds, ForceFn } from './types/plugin.js';

/** Fixed simulation timestep in seconds. Replays count steps, never wall-clock time. */
export const dt = 1 / 60;
const RNG_SEED = 1337;

/**
 * One particle simulation. All state lives on the instance, so several engines
 * can run on a page without sharing particles, plugins or random state.
 */
export class Simulation {
  count = 0;
  pos = new Float32Array(0);   // x, y in world units
  vel = new Float32Array(0);   // vx, vy in world units / second
  readonly bounds: Bounds = { w: 800, h: 600 };
  speed = 40;
  deterministic = false;
  /** Number of physics steps taken since the last (re)seed. */
  step = 0;
  forces: ForceFn[] = [];

  private seed = RNG_SEED;
  private readonly scratch: Vec2 = { x: 0, y: 0 };

  // Small LCG so deterministic mode gives the same layout on every machine
  private rand(): number {
    if (!this.deterministic) return Math.random();
    this.seed = (this.seed * 9301 + 49297) % 233280;
    return this.seed / 233280;
  }

  private spawn(i: number) {
    const ix = i << 1;
    this.pos[ix]     = this.rand() * this.bounds.w;
    this.pos[ix + 1] = this.rand() * this.bounds.h;
    const a = this.rand() * Math.PI * 2;
    this.vel[ix]     = Math.cos(a) * this.speed;
    this.vel[ix + 1] = Math.sin(a) * this.speed;
  }

  /** (Re)scatter every particle. Resets the step counter and the seeded RNG. */
  reset(opts: { w?: number; h?: number; speed?: number; deterministic?: boolean; count?: number } = {}) {
    if (opts.w !== undefined) this.bounds.w = opts.w;
    if (opts.h !== undefined) this.bounds.h = opts.h;
    if (opts.speed !== undefined) this.speed = opts.speed;
    if (opts.deterministic !== undefined) this.deterministic = opts.deterministic;
    const count = Math.max(0, Math.floor(opts.count ?? this.count));
    if (count !== this.count || this.pos.length !== count * 2) {
      this.count = count;
      this.pos = new Float32Array(count * 2);
      this.vel = new Float32Array(count * 2);
    }
    this.seed = RNG_SEED;
    this.step = 0;
    for (let i = 0; i < this.count; i++) this.spawn(i);
  }

  setBounds(w: number, h: number) {
    this.bounds.w = w;
    this.bounds.h = h;
  }

  resize(newN: number) {
    newN = Math.max(0, Math.floor(newN));
    if (newN === this.count) return;
    const oldN = this.count;
    const oldPos = this.pos;
    const oldVel = this.vel;

    this.count = newN;
    this.pos = new Float32Array(newN * 2);
    this.vel = new Float32Array(newN * 2);

    const keep = Math.min(oldN, newN) * 2;
    this.pos.set(oldPos.subarray(0, keep));
    this.vel.set(oldVel.subarray(0, keep));

    for (let i = oldN; i < newN; i++) this.spawn(i);
  }

  /** Change the base speed, rescaling current velocities to match. */
  setSpeed(next: number) {
    if (next === this.speed) return;
    const k = this.speed > 0 ? next / this.speed : 0;
    this.speed = next;
    if (k === 0) {
      // coming from (or going to) zero speed: give everyone a fresh direction
      for (let i = 0; i < this.count; i++) {
        const ix = i << 1;
        const a = this.rand() * Math.PI * 2;
        this.vel[ix]     = Math.cos(a) * next;
        this.vel[ix + 1] = Math.sin(a) * next;
      }
      return;
    }
    for (let i = 0; i < this.count * 2; i++) this.vel[i] *= k;
  }

  /** Advance the simulation by `n` fixed steps. */
  advance(n = 1) {
    for (let s = 0; s < n; s++) this.stepOnce();
  }

  private stepOnce() {
    const { pos, vel, bounds, speed, scratch } = this;
    const w = bounds.w, h = bounds.h;
    const sineK = 0.002;
    const amp   = 4;
    const maxSpeed = Math.max(1, speed * 2.5);
    const damping = 0.99;
    const elasticity = 0.9;
    const forces = this.forces;

    for (let i = 0; i < this.count; i++) {
      const ix = i << 1;

      // Plugin forces nudge a copy of the position; the nudge becomes velocity
      if (forces.length) {
        scratch.x = pos[ix];
        scratch.y = pos[ix + 1];
        for (const force of forces) force(scratch, i, bounds);
        vel[ix]     += scratch.x - pos[ix];
        vel[ix + 1] += scratch.y - pos[ix + 1];
      }

      // steer by sine field
      vel[ix]     += Math.sin(pos[ix + 1] * sineK) * amp * dt;
      vel[ix + 1] += Math.cos(pos[ix]     * sineK) * amp * dt;

      vel[ix]     *= damping;
      vel[ix + 1] *= damping;

      // Keep particles moving at roughly the configured speed
      const s = Math.sqrt(vel[ix] * vel[ix] + vel[ix + 1] * vel[ix + 1]);
      if (s > maxSpeed) {
        const k = maxSpeed / s;
        vel[ix]     *= k;
        vel[ix + 1] *= k;
      } else if (s < speed * 0.5 && s > 1e-6) {
        const k = 1.01; // gently counter damping so motion never dies out
        vel[ix]     *= k;
        vel[ix + 1] *= k;
      }

      // Integrate position with edge-respecting bounce
      let nextX = pos[ix]     + vel[ix]     * dt;
      let nextY = pos[ix + 1] + vel[ix + 1] * dt;

      if (nextX < 0) {
        nextX = 0;
        vel[ix] = -vel[ix] * elasticity;
      } else if (nextX > w) {
        nextX = w;
        vel[ix] = -vel[ix] * elasticity;
      }

      if (nextY < 0) {
        nextY = 0;
        vel[ix + 1] = -vel[ix + 1] * elasticity;
      } else if (nextY > h) {
        nextY = h;
        vel[ix + 1] = -vel[ix + 1] * elasticity;
      }

      pos[ix]     = nextX;
      pos[ix + 1] = nextY;
    }
    this.step++;
  }

  /**
   * FNV-1a hash of the exact particle state (positions + velocities).
   * Two runs with the same seed, world size, options and plugin toggles at the
   * same steps produce the same hash.
   */
  stateHash(): string {
    let h = 0x811c9dc5;
    const bytes = new Uint8Array(this.pos.buffer, this.pos.byteOffset, this.pos.byteLength);
    const vbytes = new Uint8Array(this.vel.buffer, this.vel.byteOffset, this.vel.byteLength);
    for (const arr of [bytes, vbytes]) {
      for (let i = 0; i < arr.length; i++) {
        h ^= arr[i];
        h = Math.imul(h, 0x01000193);
      }
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}
