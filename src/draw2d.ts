/* SuperParticles – Canvas 2D Renderer */
// Build timestamp: 2024-12-19 to force cache refresh

import { initArrays, stepPhysics, pos, dt, Options, getParticleCount } from './core';

export function initCanvas2D(
  canvas: HTMLCanvasElement,
  { color = '#70c1ff', speed = 40, deterministic = false }: Options = {},
) {
  // Safety check: ensure canvas and context are available
  if (!canvas) {
    throw new Error('Canvas element is null or undefined');
  }
  
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2D context from canvas. Canvas may not be ready yet.');
  }
  
  // At this point, ctx is guaranteed to be non-null
  const context = ctx as CanvasRenderingContext2D;
  
  const dpr = devicePixelRatio || 1;
  
  const resize = () => {
    canvas.width  = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    console.log('🖼️ Canvas resized to:', canvas.width, 'x', canvas.height);
  };
  
  // Set initial size immediately
  resize();
  addEventListener('resize', resize);

  // Initialize particles with current canvas dimensions
  console.log('🔧 Initializing particles with canvas dimensions:', canvas.width, 'x', canvas.height);
  initArrays(canvas.width, canvas.height, speed, deterministic);

  /* draw */
  context.fillStyle = color;
  let acc = 0, prev = performance.now(), id = 0;
  
  console.log('🎨 Canvas2D initialized:', { width: canvas.width, height: canvas.height, dpr, color });
  
  // Remove test rectangle - no longer needed
  
  function frame(now: number) {
    acc += Math.min(now - prev, 100);
    
    // Clear canvas completely
    context.clearRect(0, 0, canvas.width, canvas.height);
    
    while (acc >= dt * 1000) { 
      stepPhysics(canvas.width, canvas.height); 
      acc -= dt * 1000; 
    }
    
    // Draw particles as tiny dots
    context.fillStyle = '#70c1ff';
    let drawnCount = 0;
    
    // Optimized particle drawing - batch operations
    const currentN = getParticleCount();
    for (let i = 0; i < currentN; i++) {
      const ix = i << 1;
      const size = 0.5 * dpr; // Extremely small particles (0.5px)
      const x = pos[ix] - size/2;
      const y = pos[ix + 1] - size/2;
      
      // Only draw if particle is on screen
      if (x >= -size && x <= canvas.width + size && y >= -size && y <= canvas.height + size) {
        // Draw extremely tiny particles
        context.fillRect(x, y, size, size);
        drawnCount++;
      }
    }
    
    // Reduced logging frequency for better performance
    if (Math.floor(now / 1000) !== Math.floor(prev / 1000)) {
      console.log(`🎯 Drawing ${drawnCount}/${currentN} particles at ${Math.floor(now/1000)}s`);
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
