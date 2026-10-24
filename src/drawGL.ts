/* SuperParticles – WebGL2 Renderer */

import type { RenderContext, Renderer } from './render.js';
import { hexToRgba } from './color.js';

const vertexShaderSource = `#version 300 es
in vec2 aPos;
uniform float uSize;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  gl_PointSize = uSize;
}
`;

const defaultFragmentSource = `#version 300 es
precision mediump float;
uniform vec4 uCol;
out vec4 fragColor;
void main() {
  // round particles
  if (length(gl_PointCoord - 0.5) > 0.5) discard;
  fragColor = uCol;
}
`;

export function createWebGL2(rc: RenderContext): Renderer {
  const gl = rc.canvas.getContext('webgl2');
  if (!gl) {
    throw new Error('WebGL2 unavailable (unsupported, or the canvas already uses another context type)');
  }

  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);

  let program!: WebGLProgram;
  let sizeLoc: WebGLUniformLocation | null = null;
  let colorLoc: WebGLUniformLocation | null = null;
  let resolutionLoc: WebGLUniformLocation | null = null;
  let builtVersion = -1;

  const positionBuffer = gl.createBuffer();
  const vao = gl.createVertexArray();

  function buildProgram() {
    builtVersion = rc.plugins.shaderVersion;
    let next: WebGLProgram;
    try {
      next = createProgram(gl!, vertexShader, createShader(gl!, gl!.FRAGMENT_SHADER, rc.plugins.glsl() ?? defaultFragmentSource));
    } catch (error) {
      console.error('SuperParticles: shader plugin failed, using default shader', error);
      next = createProgram(gl!, vertexShader, createShader(gl!, gl!.FRAGMENT_SHADER, defaultFragmentSource));
    }
    if (program) gl!.deleteProgram(program);
    program = next;
    sizeLoc = gl!.getUniformLocation(program, 'uSize');
    colorLoc = gl!.getUniformLocation(program, 'uCol');
    resolutionLoc = gl!.getUniformLocation(program, 'uResolution');

    const positionLoc = gl!.getAttribLocation(program, 'aPos');
    gl!.bindVertexArray(vao);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, positionBuffer);
    gl!.enableVertexAttribArray(positionLoc);
    gl!.vertexAttribPointer(positionLoc, 2, gl!.FLOAT, false, 0, 0);
  }
  buildProgram();

  let clip = new Float32Array(0);

  return {
    resize() {
      gl.viewport(0, 0, rc.canvas.width, rc.canvas.height);
    },
    draw() {
      const { canvas, sim, style, view } = rc;
      if (builtVersion !== rc.plugins.shaderVersion) buildProgram();

      const n = sim.count;
      if (clip.length !== n * 2) clip = new Float32Array(n * 2);

      // World units → device pixels → clip space (y up)
      const w = canvas.width, h = canvas.height;
      const ax = (2 * view.sx) / w, bx = (2 * view.ox) / w - 1;
      const ay = (-2 * view.sy) / h, by = 1 - (2 * view.oy) / h;
      const pos = sim.pos;
      for (let i = 0; i < n; i++) {
        const ix = i << 1;
        clip[ix]     = pos[ix] * ax + bx;
        clip[ix + 1] = pos[ix + 1] * ay + by;
      }

      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(program);
      const c = hexToRgba(style.color);
      gl.uniform1f(sizeLoc, Math.max(1, style.size * view.dpr));
      gl.uniform4f(colorLoc, c.r, c.g, c.b, c.a);
      if (resolutionLoc) gl.uniform2f(resolutionLoc, w, h);

      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, clip, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.POINTS, 0, n);
    },
    destroy() {
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteBuffer(positionBuffer);
      gl.deleteVertexArray(vao);
    },
  };
}

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('Shader compilation error: ' + log);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vertexShader: WebGLShader, fragmentShader: WebGLShader): WebGLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(fragmentShader); // stays alive while attached
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('Program linking error: ' + gl.getProgramInfoLog(program));
  }
  return program;
}
