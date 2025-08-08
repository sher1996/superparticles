/* SuperParticles – Core Physics & Arrays */

export interface Options {
  color?: string;
  speed?: number;
}

const N = 100_000;
const dt = 1 / 120;                // fixed-step seconds
const rngSeed = 1337;              // repeatable look
let seed = rngSeed;
const rand = () => (seed ^= seed << 13, seed ^= seed >> 17, seed ^= seed << 5) >>> 0 / 2**32;

/* shared buffers */
const pos = new Float32Array(N * 2);   // x, y
const vel = new Float32Array(N * 2);   // vx, vy

export function initArrays(w: number, h: number, speed: number) {
  for (let i = 0; i < N; i++) {
    const ix = i << 1;
    pos[ix]     = rand() * w;
    pos[ix + 1] = rand() * h;
    // random dir, uniform speed
    const a = rand() * Math.PI * 2;
    vel[ix]     = Math.cos(a) * speed;
    vel[ix + 1] = Math.sin(a) * speed;
  }
}

export function stepPhysics(w: number, h: number) {
  const sineK = 0.002;
  const amp   = 4;
  
  for (let i = 0; i < N; i++) {
    const ix = i << 1;
    // steer by sine field
    vel[ix]     += Math.sin(pos[ix + 1] * sineK) * amp * dt;
    vel[ix + 1] += Math.cos(pos[ix]     * sineK) * amp * dt;

    pos[ix]     = (pos[ix]     + vel[ix]     * dt + w) % w;
    pos[ix + 1] = (pos[ix + 1] + vel[ix + 1] * dt + h) % h;
  }
}

export { pos, vel, N, dt }; 