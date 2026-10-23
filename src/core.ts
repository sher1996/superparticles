/* SuperParticles – Core Physics & Arrays */

import { getActiveForces } from './plugin.js';
import type { Vec2, Bounds } from './types/plugin.js';

export interface Options {
  color?: string;
  speed?: number;
  particleCount?: number;
  particleSize?: number;
  deterministic?: boolean;
}

export const dt = 1 / 60;
const rngSeed = 1337;
let seed = rngSeed;
let deterministicMode = false;

// Small LCG so deterministic mode gives the same layout on every machine
const seededRand = () => {
  seed = (seed * 9301 + 49297) % 233280;
  return seed / 233280;
};
const rand = () => (deterministicMode ? seededRand() : Math.random());

let N = 1000;
let speed = 40;
const bounds: Bounds = { w: 800, h: 600 };

/* shared buffers */
export let pos = new Float32Array(N * 2);   // x, y
export let vel = new Float32Array(N * 2);   // vx, vy

// Live render style; renderers read this every frame
export const style = {
  color: '#70c1ff',
  size: 2, // CSS pixels
};

function spawn(i: number) {
  const ix = i << 1;
  pos[ix]     = rand() * bounds.w;
  pos[ix + 1] = rand() * bounds.h;
  const a = rand() * Math.PI * 2;
  vel[ix]     = Math.cos(a) * speed;
  vel[ix + 1] = Math.sin(a) * speed;
}

export function initArrays(
  w: number,
  h: number,
  initialSpeed: number,
  deterministic = false,
  count = N,
) {
  bounds.w = w;
  bounds.h = h;
  speed = initialSpeed;
  deterministicMode = deterministic;
  seed = rngSeed;
  if (count !== N) {
    N = count;
    pos = new Float32Array(N * 2);
    vel = new Float32Array(N * 2);
  }
  for (let i = 0; i < N; i++) spawn(i);
}

/** Re-scatter all particles, e.g. after toggling deterministic mode. */
export function resetParticles(deterministic = deterministicMode) {
  initArrays(bounds.w, bounds.h, speed, deterministic, N);
}

export function setBounds(w: number, h: number) {
  bounds.w = w;
  bounds.h = h;
}

export function getBounds(): Readonly<Bounds> {
  return bounds;
}

export function resizeParticleBuffers(newN: number) {
  newN = Math.max(0, Math.floor(newN));
  if (newN === N) return;
  const oldN = N;
  const oldPos = pos;
  const oldVel = vel;

  N = newN;
  pos = new Float32Array(N * 2);
  vel = new Float32Array(N * 2);

  const copyCount = Math.min(oldN, newN);
  pos.set(oldPos.subarray(0, copyCount * 2));
  vel.set(oldVel.subarray(0, copyCount * 2));

  for (let i = oldN; i < newN; i++) spawn(i);
}

/** Change the base speed, rescaling current velocities to match. */
export function setSpeed(next: number) {
  if (next === speed) return;
  const k = speed > 0 ? next / speed : 0;
  speed = next;
  if (k === 0) {
    // coming from (or going to) zero speed: give everyone a fresh direction
    for (let i = 0; i < N; i++) {
      const ix = i << 1;
      const a = rand() * Math.PI * 2;
      vel[ix]     = Math.cos(a) * speed;
      vel[ix + 1] = Math.sin(a) * speed;
    }
    return;
  }
  for (let i = 0; i < N * 2; i++) vel[i] *= k;
}

export function getSpeed(): number {
  return speed;
}

export function getParticleCount(): number {
  return N;
}

const scratch: Vec2 = { x: 0, y: 0 };

export function stepPhysics(w: number, h: number) {
  bounds.w = w;
  bounds.h = h;

  const sineK = 0.002;
  const amp   = 4;
  const maxSpeed = Math.max(1, speed * 2.5);
  const damping = 0.99;
  const elasticity = 0.9;
  const activeForces = getActiveForces();

  for (let i = 0; i < N; i++) {
    const ix = i << 1;

    // Plugin forces nudge a copy of the position; the nudge becomes velocity
    if (activeForces.length) {
      scratch.x = pos[ix];
      scratch.y = pos[ix + 1];
      for (const force of activeForces) force(scratch, i, bounds);
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
}
