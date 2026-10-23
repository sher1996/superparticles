/* SuperParticles – Canvas 2D Renderer */

import { initArrays, stepPhysics, pos, dt, style, setBounds, getParticleCount } from './core.js';

export function initCanvas2D(
  canvas: HTMLCanvasElement,
  { speed = 40, deterministic = false, particleCount = 1000 } = {},
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable (the canvas may already use another context type)');
  }

  const dpr = devicePixelRatio || 1;
  const resize = () => {
    canvas.width  = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    setBounds(canvas.width, canvas.height);
  };
  resize();
  addEventListener('resize', resize);

  initArrays(canvas.width, canvas.height, speed, deterministic, particleCount);

  let acc = 0, prev = performance.now(), id = 0;

  function frame(now: number) {
    acc += Math.min(now - prev, 100);
    prev = now;

    while (acc >= dt * 1000) {
      stepPhysics(canvas.width, canvas.height);
      acc -= dt * 1000;
    }

    ctx!.clearRect(0, 0, canvas.width, canvas.height);
    ctx!.fillStyle = style.color;

    const size = style.size * dpr;
    const half = size / 2;
    const n = getParticleCount();
    for (let i = 0; i < n; i++) {
      const ix = i << 1;
      ctx!.fillRect(pos[ix] - half, pos[ix + 1] - half, size, size);
    }

    id = requestAnimationFrame(frame);
  }
  id = requestAnimationFrame(frame);

  return {
    stop() { cancelAnimationFrame(id); removeEventListener('resize', resize); },
  };
}
