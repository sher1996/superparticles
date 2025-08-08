/* SuperParticles – Public Façade */

export interface Options {
  color?: string;
  speed?: number;
  useWebGL?: boolean;
  useWebGPU?: boolean;
  particleCount?: number;
}

export async function init(
  canvas: HTMLCanvasElement,
  { color = '#70c1ff', speed = 40, useWebGL = false, useWebGPU = false, particleCount = 1000 }: Options = {},
) {
  let renderer: { stop: () => void };

  if (useWebGPU && 'gpu' in navigator) {
    const { drawGPU } = await import('./drawGPU.js');
    renderer = await drawGPU(canvas, { color, speed, particleCount });
  } else if (useWebGL && !!canvas.getContext('webgl2')) {
    const { initWebGL2 } = await import('./drawGL.js');
    renderer = initWebGL2(canvas, { color, speed });
  } else {
    const { initCanvas2D } = await import('./draw2d.js');
    renderer = initCanvas2D(canvas, { color, speed });
  }

  return renderer;
} 