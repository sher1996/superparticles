import type { ParticlePlugin, ForceFn } from '../src/index.js';

// Pushes particles outward from the center of the canvas
const plugin: ParticlePlugin = {
  registerForce: (add: (fn: ForceFn) => void) => {
    const softening = 80; // pixels
    const strength = 1.0;
    const forceFn: ForceFn = (p, _idx, { w, h }) => {
      const dx = p.x - w * 0.5;
      const dy = p.y - h * 0.5;
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
