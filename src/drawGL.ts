/* SuperParticles – WebGL2 Renderer */

import { initArrays, stepPhysics, pos, dt, Options, getParticleCount } from './core';
import { getActiveShaders, getActiveShaderPlugins } from './plugin.js';

const vertexShaderSource = `#version 300 es
in vec2 aPos;
uniform float uDPR;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  gl_PointSize = 10.0 * uDPR; // larger for visibility
}
`;

const fragmentShaderSource = `#version 300 es
precision mediump float;
uniform vec4 uCol;
out vec4 fragColor;
void main() {
  fragColor = uCol;
}
`;

export async function initWebGL2(
  canvas: HTMLCanvasElement,
  { color = '#70c1ff', speed = 40, deterministic = false }: Options = {},
) {
  const gl = canvas.getContext('webgl2')!;
  if (!gl) {
    throw new Error('WebGL2 not supported');
  }

  const dpr = devicePixelRatio || 1;
  const resize = () => {
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  addEventListener('resize', resize);
  resize();

  // Create shaders
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  
  // Wait for plugins to load if not deterministic
  if (!deterministic) {
    const { loadPlugins } = await import('./plugin.js');
    await loadPlugins({ deterministic });
  }
  
  // Use active shader plugin if available, otherwise fall back to legacy shaders or default
  let fragShader = fragmentShaderSource;
  const activeShaderPlugins = getActiveShaderPlugins();
  if (activeShaderPlugins.length > 0) {
    const plugin = activeShaderPlugins[activeShaderPlugins.length - 1];
    if (plugin.glsl) {
      fragShader = plugin.glsl;
    }
  } else {
    const activeShaders = getActiveShaders();
    if (activeShaders.length > 0) {
      fragShader = activeShaders[activeShaders.length - 1];
    }
  }
  
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragShader);
  const program = createProgram(gl, vertexShader, fragmentShader);

  // Get attribute and uniform locations
  const positionLocation = gl.getAttribLocation(program, 'aPos');
  const dprLocation = gl.getUniformLocation(program, 'uDPR');
  const colorLocation = gl.getUniformLocation(program, 'uCol');
  const resolutionLocation = gl.getUniformLocation(program, 'uResolution');

  // Create buffer and VAO (WebGL2 requires a VAO for vertex attribs)
  const positionBuffer = gl.createBuffer();
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  // Pre-allocate clip-space buffer
  const clip = new Float32Array(getParticleCount() * 2);

  // Initialize arrays
  initArrays(canvas.width, canvas.height, speed, deterministic);

  // Convert color to RGBA
  const colorRGBA = hexToRgba(color);

  let acc = 0, prev = performance.now(), id = 0;
  function frame(now: number) {
    acc += Math.min(now - prev, 100);
    
    // Clear
  gl.clearColor(0, 0, 0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Update physics
    while (acc >= dt * 1000) {
      stepPhysics(canvas.width, canvas.height);
      acc -= dt * 1000;
    }

    // Convert pixel coords to clip-space
    const w = canvas.width, h = canvas.height;
    const currentN = getParticleCount();
    for (let i = 0; i < currentN; i++) {
      const ix = i << 1;
      clip[ix] = (pos[ix] / w) * 2.0 - 1.0;
      clip[ix + 1] = (pos[ix + 1] / h) * 2.0 - 1.0;
    }

    // Use program
    gl.useProgram(program);

    // Set uniforms
    gl.uniform1f(dprLocation, dpr);
    gl.uniform4f(colorLocation, colorRGBA.r, colorRGBA.g, colorRGBA.b, colorRGBA.a);
    if (resolutionLocation) {
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
    }

    // Upload clip-space buffer
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, clip, gl.DYNAMIC_DRAW);

    // Draw points
    gl.drawArrays(gl.POINTS, 0, currentN);

    prev = now;
    id = requestAnimationFrame(frame);
  }
  id = requestAnimationFrame(frame);

  return {
    stop() { cancelAnimationFrame(id); removeEventListener('resize', resize); },
  };
}

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error('Shader compilation error: ' + gl.getShaderInfoLog(shader));
  }
  
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vertexShader: WebGLShader, fragmentShader: WebGLShader): WebGLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('Program linking error: ' + gl.getProgramInfoLog(program));
  }
  
  return program;
}

function hexToRgba(hex: string): { r: number, g: number, b: number, a: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16) / 255,
    g: parseInt(result[2], 16) / 255,
    b: parseInt(result[3], 16) / 255,
    a: 1.0
  } : { r: 0.44, g: 0.76, b: 1.0, a: 1.0 }; // Default to #70c1ff
} 