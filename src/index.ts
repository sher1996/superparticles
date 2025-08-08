/* SuperParticles – Atom Core */

export interface Options {
  color?: string;
  speed?: number;
}

const N = 20_000;
const dt = 1 / 120;                // fixed-step seconds
const rngSeed = 1337;              // repeatable look
let seed = rngSeed;
const rand = () => (seed ^= seed << 13, seed ^= seed >> 17, seed ^= seed << 5) >>> 0 / 2**32;

/* shared buffers */
const pos = new Float32Array(N * 2);   // x, y
const vel = new Float32Array(N * 2);   // vx, vy

function initArrays(w: number, h: number, speed: number) {
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

export function init(
  canvas: HTMLCanvasElement,
  { color = '#70c1ff', speed = 40 }: Options = {},
) {
  const ctx = canvas.getContext('2d')!;
  const dpr = devicePixelRatio || 1;
  const resize = () => {
    canvas.width  = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
  };
  addEventListener('resize', resize);
  resize();

  initArrays(canvas.width, canvas.height, speed);

  /* physics */
  const sineK = 0.002;
  const amp   = 4;
  function step() {
    const w = canvas.width, h = canvas.height;
    for (let i = 0; i < N; i++) {
      const ix = i << 1;
      // steer by sine field
      vel[ix]     += Math.sin(pos[ix + 1] * sineK) * amp * dt;
      vel[ix + 1] += Math.cos(pos[ix]     * sineK) * amp * dt;

      pos[ix]     = (pos[ix]     + vel[ix]     * dt + w) % w;
      pos[ix + 1] = (pos[ix + 1] + vel[ix + 1] * dt + h) % h;
    }
  }

  /* draw */
  ctx.fillStyle = color;
  const blur = `#0003`;
  let acc = 0, prev = performance.now(), id = 0;
  function frame(now: number) {
    acc += Math.min(now - prev, 100);
    ctx.fillStyle = blur;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    while (acc >= dt * 1000) { step(); acc -= dt * 1000; }
    ctx.fillStyle = color;
    for (let i = 0; i < N; i++) {
      const ix = i << 1;
      ctx.fillRect(pos[ix], pos[ix + 1], dpr, dpr);
    }
    prev = now;
    id = requestAnimationFrame(frame);
  }
  id = requestAnimationFrame(frame);

  /* return handle */
  return {
    stop() { cancelAnimationFrame(id); removeEventListener('resize', resize); },
  };
} 