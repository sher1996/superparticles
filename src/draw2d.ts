/* SuperParticles – Canvas 2D Renderer */

import { initArrays, stepPhysics, pos, N, dt, Options } from './core';

export function initCanvas2D(
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

  /* draw */
  ctx.fillStyle = color;
  const blur = `#0003`;
  let acc = 0, prev = performance.now(), id = 0;
  function frame(now: number) {
    acc += Math.min(now - prev, 100);
    ctx.fillStyle = blur;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    while (acc >= dt * 1000) { 
      stepPhysics(canvas.width, canvas.height); 
      acc -= dt * 1000; 
    }
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