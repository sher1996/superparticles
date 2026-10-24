/* WebGL2 NCA backend.
 *
 * State lives in 4 RGBA32F textures (channels 4g..4g+3 in texture g), double
 * buffered. One step is two passes, matching training/nca.py exactly:
 *   1. update: next = x + mlp(perceive(x)) * fire   (every cell, written to a temp set)
 *   2. mask:   out = alive(x) && alive(next) ? next : 0
 * Weights are uniform buffers (std140 vec4 arrays). Requires 16 channels and
 * 128 hidden units (the v1 model shape).
 */

import type { NCAModel } from './model.js';
import { blockW1, fitGrid, type DrawParams, type NCABackend } from './backend.js';

const HEADER = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uS0, uS1, uS2, uS3;
uniform ivec2 uSize;
vec4 S(int g, ivec2 p) {
  if (p.x < 0 || p.y < 0 || p.x >= uSize.x || p.y >= uSize.y) return vec4(0.0);
  if (g == 0) return texelFetch(uS0, p, 0);
  if (g == 1) return texelFetch(uS1, p, 0);
  if (g == 2) return texelFetch(uS2, p, 0);
  return texelFetch(uS3, p, 0);
}
`;

const QUAD_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const UPDATE_FS = HEADER + `
uniform uint uStep, uSeed, uFire;
layout(std140) uniform W1a { vec4 w1a[768]; };   // hidden rows 0..63, 12 vec4 per row
layout(std140) uniform W1b { vec4 w1b[768]; };   // hidden rows 64..127
layout(std140) uniform W2 { vec4 w2[512]; };     // 16 rows, 32 vec4 per row
layout(std140) uniform B1 { vec4 b1[32]; };
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;

uint hashU32(uint x, uint y, uint s, uint seed) {
  uint h = x * 0x8DA6B343u;
  h ^= y * 0xD8163841u;
  h ^= s * 0xCB1AB31Fu;
  h ^= seed;
  h ^= h >> 16; h *= 0x85EBCA6Bu;
  h ^= h >> 13; h *= 0xC2B2AE35u;
  h ^= h >> 16;
  return h;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 cur[4];
  for (int g = 0; g < 4; g++) cur[g] = S(g, p);
  bool fire = (hashU32(uint(p.x), uint(p.y), uStep, uSeed) >> 8) < uFire;
  if (!fire) { o0 = cur[0]; o1 = cur[1]; o2 = cur[2]; o3 = cur[3]; return; }

  // Perception, blocked layout: [identity g0..g3 | sobel_x g0..g3 | sobel_y g0..g3]
  vec4 P[12];
  for (int g = 0; g < 4; g++) {
    vec4 tl = S(g, p + ivec2(-1, -1)), t = S(g, p + ivec2(0, -1)), tr = S(g, p + ivec2(1, -1));
    vec4 l  = S(g, p + ivec2(-1,  0)),                             r  = S(g, p + ivec2(1,  0));
    vec4 bl = S(g, p + ivec2(-1,  1)), b = S(g, p + ivec2(0,  1)), br = S(g, p + ivec2(1,  1));
    P[g] = cur[g];
    P[4 + g] = ((tr + 2.0 * r + br) - (tl + 2.0 * l + bl)) / 8.0;
    P[8 + g] = ((bl + 2.0 * b + br) - (tl + 2.0 * t + tr)) / 8.0;
  }

  vec4 hv[32];
  for (int j4 = 0; j4 < 32; j4++) {
    vec4 hs = b1[j4];
    for (int lane = 0; lane < 4; lane++) {
      int j = j4 * 4 + lane;
      float s = 0.0;
      for (int q = 0; q < 12; q++) {
        vec4 w = j < 64 ? w1a[j * 12 + q] : w1b[(j - 64) * 12 + q];
        s += dot(w, P[q]);
      }
      hs[lane] += s;
    }
    hv[j4] = max(hs, 0.0);
  }

  vec4 dx[4];
  for (int g = 0; g < 4; g++) {
    vec4 d;
    for (int lane = 0; lane < 4; lane++) {
      int c = g * 4 + lane;
      float s = 0.0;
      for (int j4 = 0; j4 < 32; j4++) s += dot(w2[c * 32 + j4], hv[j4]);
      d[lane] = s;
    }
    dx[g] = d;
  }
  o0 = cur[0] + dx[0]; o1 = cur[1] + dx[1]; o2 = cur[2] + dx[2]; o3 = cur[3] + dx[3];
}
`;

// Mask pass: uS* = previous state (pre), uT0 = alpha texture of the update result (post)
const MASK_FS = HEADER + `
uniform highp sampler2D uT0, uT1, uT2, uT3;
uniform float uAlive;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
float TA(ivec2 p) {
  if (p.x < 0 || p.y < 0 || p.x >= uSize.x || p.y >= uSize.y) return 0.0;
  return texelFetch(uT0, p, 0).a;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  bool pre = false, post = false;
  for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
    ivec2 q = p + ivec2(dx, dy);
    pre = pre || S(0, q).a > uAlive;
    post = post || TA(q) > uAlive;
  }
  float keep = pre && post ? 1.0 : 0.0;
  o0 = texelFetch(uT0, p, 0) * keep;
  o1 = texelFetch(uT1, p, 0) * keep;
  o2 = texelFetch(uT2, p, 0) * keep;
  o3 = texelFetch(uT3, p, 0) * keep;
}
`;

const DAMAGE_FS = HEADER + `
uniform vec3 uDisc; // cx, cy, r in cells
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 d = vec2(p) - uDisc.xy;
  float keep = dot(d, d) < uDisc.z * uDisc.z ? 0.0 : 1.0;
  o0 = S(0, p) * keep; o1 = S(1, p) * keep; o2 = S(2, p) * keep; o3 = S(3, p) * keep;
}
`;

const DRAW_VS = HEADER + `
uniform vec2 uCanvas;   // device px
uniform vec3 uFit;      // cell size, origin x, origin y (device px)
uniform float uDot;
uniform int uView, uChannel;
uniform float uAlive;
out vec4 vColor;
void main() {
  ivec2 p = ivec2(gl_VertexID % uSize.x, gl_VertexID / uSize.x);
  vec4 rgba = S(0, p);
  float a = clamp(rgba.a, 0.0, 1.0);
  vec2 px = uFit.yz + (vec2(p) + 0.5) * uFit.x;
  gl_Position = vec4(px.x / uCanvas.x * 2.0 - 1.0, 1.0 - px.y / uCanvas.y * 2.0, 0.0, 1.0);
  if (a <= uAlive) { gl_PointSize = 0.0; gl_Position = vec4(2.0, 2.0, 0.0, 1.0); vColor = vec4(0.0); return; }
  gl_PointSize = max(1.0, uFit.x * uDot * (0.55 + 0.45 * a));
  if (uView == 0) {
    vec3 rgb = clamp(rgba.rgb / max(a, 1e-3), 0.0, 1.0);   // un-premultiply
    vColor = vec4(rgb, a);
  } else {
    vec4 grp = S(uChannel / 4, p);
    float v = grp[uChannel % 4];
    float t = clamp(0.5 + 0.5 * tanh(v), 0.0, 1.0);        // diverging map
    vColor = vec4(mix(vec3(0.15, 0.35, 1.0), vec3(1.0, 0.35, 0.15), t) * (0.4 + 0.6 * abs(t * 2.0 - 1.0)), 1.0);
  }
}
`;

const DRAW_FS = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 frag;
void main() {
  if (length(gl_PointCoord - 0.5) > 0.5) discard;
  frag = vColor;
}
`;

type StateSet = { tex: WebGLTexture[]; fbo: WebGLFramebuffer };

export function createWebGL2NCA(canvas: HTMLCanvasElement, model: NCAModel, width: number, height: number): NCABackend {
  if (model.channels !== 16 || model.hidden !== 128) throw new Error('WebGL2 NCA backend needs a 16-channel, 128-hidden model');
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false });
  if (!gl) throw new Error('WebGL2 unavailable');
  if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('WebGL2 float render targets unavailable');

  const programs = {
    update: link(gl, QUAD_VS, UPDATE_FS),
    mask: link(gl, QUAD_VS, MASK_FS),
    damage: link(gl, QUAD_VS, DAMAGE_FS),
    draw: link(gl, DRAW_VS, DRAW_FS),
  };
  const vao = gl.createVertexArray();

  const makeSet = (): StateSet => {
    const tex: WebGLTexture[] = [];
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    for (let g = 0; g < 4; g++) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + g, gl.TEXTURE_2D, t, 0);
      tex.push(t);
    }
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('NCA framebuffer incomplete');
    return { tex, fbo };
  };
  let cur = makeSet();
  let tmp = makeSet();
  let out = makeSet();

  // Uniform buffers
  const w1 = blockW1(model);
  const ubo = (binding: number, data: Float32Array) => {
    const b = gl.createBuffer()!;
    gl.bindBuffer(gl.UNIFORM_BUFFER, b);
    gl.bufferData(gl.UNIFORM_BUFFER, data, gl.STATIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, binding, b);
    return b;
  };
  const buffers = [
    ubo(0, w1.subarray(0, 64 * 48)),
    ubo(1, w1.subarray(64 * 48)),
    ubo(2, model.w2),
    ubo(3, model.b1),
  ];
  const up = programs.update;
  ['W1a', 'W1b', 'W2', 'B1'].forEach((name, i) => gl.uniformBlockBinding(up, gl.getUniformBlockIndex(up, name), i));

  const loc = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);
  const bindState = (p: WebGLProgram, set: StateSet, prefix = 'uS', unit0 = 0) => {
    for (let g = 0; g < 4; g++) {
      gl.activeTexture(gl.TEXTURE0 + unit0 + g);
      gl.bindTexture(gl.TEXTURE_2D, set.tex[g]);
      gl.uniform1i(loc(p, prefix + g), unit0 + g);
    }
    gl.uniform2i(loc(p, 'uSize'), width, height);
  };
  const runPass = (p: WebGLProgram, target: StateSet, setup: () => void) => {
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    setup();
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const fireThreshold = Math.floor(model.fireRate * (1 << 24));

  const backend: NCABackend = {
    kind: 'webgl2',
    width,
    height,
    advance(n, step, seed) {
      for (let i = 0; i < n; i++) {
        runPass(programs.update, tmp, () => {
          bindState(programs.update, cur);
          gl.uniform1ui(loc(programs.update, 'uStep'), (step + i) >>> 0);
          gl.uniform1ui(loc(programs.update, 'uSeed'), seed >>> 0);
          gl.uniform1ui(loc(programs.update, 'uFire'), fireThreshold);
        });
        runPass(programs.mask, out, () => {
          bindState(programs.mask, cur);
          bindState(programs.mask, tmp, 'uT', 4);
          gl.uniform1f(loc(programs.mask, 'uAlive'), model.aliveThreshold);
        });
        [cur, out] = [out, cur];
      }
    },
    setState(state) {
      const plane = width * height;
      const px = new Float32Array(plane * 4);
      for (let g = 0; g < 4; g++) {
        for (let i = 0; i < plane; i++) {
          for (let k = 0; k < 4; k++) px[i * 4 + k] = state[(g * 4 + k) * plane + i];
        }
        gl.bindTexture(gl.TEXTURE_2D, cur.tex[g]);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, px);
      }
    },
    async readState() {
      const plane = width * height;
      const state = new Float32Array(16 * plane);
      const px = new Float32Array(plane * 4);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, cur.fbo);
      for (let g = 0; g < 4; g++) {
        gl.readBuffer(gl.COLOR_ATTACHMENT0 + g);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, px);
        for (let i = 0; i < plane; i++) {
          for (let k = 0; k < 4; k++) state[(g * 4 + k) * plane + i] = px[i * 4 + k];
        }
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      return state;
    },
    damage(cx, cy, r) {
      runPass(programs.damage, out, () => {
        bindState(programs.damage, cur);
        gl.uniform3f(loc(programs.damage, 'uDisc'), cx, cy, r);
      });
      [cur, out] = [out, cur];
    },
    draw(p: DrawParams) {
      const d = programs.draw;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(d);
      bindState(d, cur);
      const fit = fitGrid(canvas, width, height);
      gl.uniform2f(loc(d, 'uCanvas'), canvas.width, canvas.height);
      gl.uniform3f(loc(d, 'uFit'), fit.cell, fit.ox, fit.oy);
      gl.uniform1f(loc(d, 'uDot'), p.dotScale);
      gl.uniform1i(loc(d, 'uView'), p.view === 'rgba' ? 0 : 1);
      gl.uniform1i(loc(d, 'uChannel'), Math.max(0, Math.min(15, p.channel | 0)));
      gl.uniform1f(loc(d, 'uAlive'), model.aliveThreshold);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.POINTS, 0, width * height);
    },
    destroy() {
      for (const set of [cur, tmp, out]) {
        set.tex.forEach(t => gl.deleteTexture(t));
        gl.deleteFramebuffer(set.fbo);
      }
      buffers.forEach(b => gl.deleteBuffer(b));
      Object.values(programs).forEach(p => gl.deleteProgram(p));
      gl.deleteVertexArray(vao);
    },
  };
  return backend;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('NCA shader error: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram()!;
  const v = compile(gl.VERTEX_SHADER, vs), f = compile(gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('NCA program error: ' + gl.getProgramInfoLog(p));
  return p;
}
