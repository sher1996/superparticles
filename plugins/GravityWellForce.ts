import type { ParticlePlugin, ForceFn } from '../src/index.js';

// Pulls particles toward the center of the canvas
const plugin: ParticlePlugin = {
  registerForce: (add: (fn: ForceFn) => void) => {
    // Softened gravity so particles don't collapse into a single point
    const softening = 80; // pixels
    const strength = 1.2;
    const forceFn: ForceFn = (p, _idx, { w, h }) => {
      const dx = w * 0.5 - p.x;
      const dy = h * 0.5 - p.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > 0) {
        p.x += (dx / (distance + softening)) * strength;
        p.y += (dy / (distance + softening)) * strength;
      }
    };
    add(forceFn);
  }
};

export default plugin;
