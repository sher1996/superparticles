/* SuperParticles – Canvas 2D Renderer */

import type { RenderContext, Renderer } from './render.js';

export function createCanvas2D(rc: RenderContext): Renderer {
  const ctx = rc.canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable (the canvas may already use another context type)');
  }

  return {
    draw() {
      const { canvas, sim, style, view } = rc;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = style.color;
      const size = style.size * view.dpr;
      const half = size / 2;
      const pos = sim.pos;
      for (let i = 0; i < sim.count; i++) {
        const ix = i << 1;
        ctx.fillRect(pos[ix] * view.sx + view.ox - half, pos[ix + 1] * view.sy + view.oy - half, size, size);
      }
    },
    destroy() {},
  };
}
