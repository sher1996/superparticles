import type { ParticlePlugin, ForceFn } from '../src/index.js';

const plugin: ParticlePlugin = {
  registerForce: (add: (fn: ForceFn) => void) => {
    console.log('[GravityWellForce] registering force');
    const forceFn = (p: any, idx: number) => {
      // Use the rendering canvas center to avoid layout/DPI offsets
      const canvas = document.getElementById('sp') as HTMLCanvasElement | null;
      const centerX = canvas ? canvas.width * 0.5 : (window.innerWidth * (window.devicePixelRatio || 1)) * 0.5;
      const centerY = canvas ? canvas.height * 0.5 : (window.innerHeight * (window.devicePixelRatio || 1)) * 0.5;
      const dx = centerX - p.x;
      const dy = centerY - p.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > 0) {
        // Softened gravity to avoid collapsing into a single point
        const softening = 80; // pixels
        const gravityStrength = 1.2; // base gain
        const stepX = (dx / (distance + softening)) * gravityStrength;
        const stepY = (dy / (distance + softening)) * gravityStrength;
        // Clamp per-step movement
        const maxStep = 2.0;
        const scale = Math.min(1, maxStep / Math.max(Math.abs(stepX), Math.abs(stepY)) || 1);
        p.x += stepX * scale;
        p.y += stepY * scale;
      }
    };
    forceFn.__id = 'gravity-well-force';
    add(forceFn);
  }
};

export default plugin; 