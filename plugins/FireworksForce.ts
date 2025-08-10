import type { ParticlePlugin, ForceFn } from '../src/index.js';

const plugin: ParticlePlugin = {
  registerForce: (add: (fn: ForceFn) => void) => {
    console.log('[FireworksForce] registering force');
    const forceFn = (p: any, idx: number) => {
      const canvas = document.getElementById('sp') as HTMLCanvasElement | null;
      const centerX = canvas ? canvas.width * 0.5 : (window.innerWidth * (window.devicePixelRatio || 1)) * 0.5;
      const centerY = canvas ? canvas.height * 0.5 : (window.innerHeight * (window.devicePixelRatio || 1)) * 0.5;
      const dx = p.x - centerX;
      const dy = p.y - centerY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > 0) {
        const softening = 80; // pixels
        const base = 1.0;
        const stepX = (dx / (distance + softening)) * base;
        const stepY = (dy / (distance + softening)) * base;
        const maxStep = 2.0;
        const scale = Math.min(1, maxStep / Math.max(Math.abs(stepX), Math.abs(stepY)) || 1);
        p.x += stepX * scale;
        p.y += stepY * scale;
      }
    };
    forceFn.__id = 'fireworks-force';
    add(forceFn);
  }
};

export default plugin; 