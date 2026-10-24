/* WebGPU NCA backend: compute shaders over double-buffered storage buffers.
 *
 * State is channel-major f32 (C×H×W), identical to PyTorch. One step:
 *   update: tmp = x + mlp(perceive(x)) * fire     (every cell)
 *   mask:   out = alive(x) && alive(tmp) ? tmp : 0
 * then cur/out swap. Pass `device` to run headless (no canvas), e.g. in tests.
 */

import type { NCAModel } from './model.js';
import { blockW1, fitGrid, type DrawParams, type NCABackend } from './backend.js';

const COMMON = /* wgsl */ `
struct Params {
  w: u32, h: u32, step: u32, seed: u32,
  fire: u32, alive: f32, cx: f32, cy: f32,
  r: f32, hidden: u32, pad1: f32, pad2: f32,
};
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(3) var<uniform> P: Params;
`;

export const UPDATE = COMMON + /* wgsl */ `
// Wt (vec4): w1 blocked, 12 per hidden unit [identity g0..3 | sobel_x g0..3 | sobel_y g0..3],
// then b1 (32), then w2 transposed (4 per hidden unit, one per channel group)
@group(0) @binding(2) var<storage, read> Wt: array<vec4<f32>>;
const B1: u32 = 1536u;
const W2: u32 = 1568u;

fn hashU32(x: u32, y: u32, s: u32, seed: u32) -> u32 {
  var h = x * 0x8DA6B343u;
  h ^= y * 0xD8163841u;
  h ^= s * 0xCB1AB31Fu;
  h ^= seed;
  h ^= h >> 16u; h *= 0x85EBCA6Bu;
  h ^= h >> 13u; h *= 0xC2B2AE35u;
  h ^= h >> 16u;
  return h;
}

// Channels 4g..4g+3 at (x, y), zero outside the grid
fn g4(g: u32, x: i32, y: i32) -> vec4<f32> {
  if (x < 0 || y < 0 || x >= i32(P.w) || y >= i32(P.h)) { return vec4<f32>(0.0); }
  let pl = P.w * P.h;
  let i = u32(y) * P.w + u32(x) + 4u * g * pl;
  return vec4<f32>(src[i], src[i + pl], src[i + 2u * pl], src[i + 3u * pl]);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= P.w || id.y >= P.h) { return; }
  let x = i32(id.x);
  let y = i32(id.y);
  let pl = P.w * P.h;
  let cell = id.y * P.w + id.x;
  let fire = (hashU32(id.x, id.y, P.step, P.seed) >> 8u) < P.fire;

  var per: array<vec4<f32>, 12>;
  for (var g = 0u; g < 4u; g++) {
    let tl = g4(g, x - 1, y - 1); let t = g4(g, x, y - 1); let tr = g4(g, x + 1, y - 1);
    let l  = g4(g, x - 1, y);                              let r  = g4(g, x + 1, y);
    let bl = g4(g, x - 1, y + 1); let b = g4(g, x, y + 1); let br = g4(g, x + 1, y + 1);
    per[g] = g4(g, x, y);
    per[4u + g] = ((tr + 2.0 * r + br) - (tl + 2.0 * l + bl)) / 8.0;
    per[8u + g] = ((bl + 2.0 * b + br) - (tl + 2.0 * t + tr)) / 8.0;
  }

  var acc: array<vec4<f32>, 4>;
  if (fire) {
    // runtime bound: stops software drivers from unrolling 128 iterations
    for (var j = 0u; j < P.hidden; j++) {
      var s = Wt[B1 + j / 4u][j % 4u];
      for (var q = 0u; q < 12u; q++) { s += dot(Wt[j * 12u + q], per[q]); }
      let h = max(s, 0.0);
      for (var g = 0u; g < 4u; g++) { acc[g] += Wt[W2 + j * 4u + g] * h; }
    }
  }
  for (var g = 0u; g < 4u; g++) {
    let v = per[g] + acc[g];
    let i = cell + 4u * g * pl;
    dst[i] = v.x; dst[i + pl] = v.y; dst[i + 2u * pl] = v.z; dst[i + 3u * pl] = v.w;
  }
}
`;

// src = previous state, aux = update result, dst = masked output
export const MASK = COMMON + /* wgsl */ `
@group(0) @binding(2) var<storage, read> aux: array<f32>;
fn at(buf: u32, c: u32, x: i32, y: i32) -> f32 {
  if (x < 0 || y < 0 || x >= i32(P.w) || y >= i32(P.h)) { return 0.0; }
  let i = c * P.w * P.h + u32(y) * P.w + u32(x);
  if (buf == 0u) { return src[i]; }
  return aux[i];
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= P.w || id.y >= P.h) { return; }
  let x = i32(id.x);
  let y = i32(id.y);
  var pre = false;
  var post = false;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      pre = pre || at(0u, 3u, x + dx, y + dy) > P.alive;
      post = post || at(1u, 3u, x + dx, y + dy) > P.alive;
    }
  }
  let keep = select(0.0, 1.0, pre && post);
  let plane = P.w * P.h;
  let cell = id.y * P.w + id.x;
  for (var c = 0u; c < 16u; c++) { dst[c * plane + cell] = aux[c * plane + cell] * keep; }
}
`;

export const DAMAGE = COMMON + /* wgsl */ `
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= P.w || id.y >= P.h) { return; }
  let d = vec2<f32>(f32(id.x) - P.cx, f32(id.y) - P.cy);
  let keep = select(1.0, 0.0, dot(d, d) < P.r * P.r);
  let plane = P.w * P.h;
  let cell = id.y * P.w + id.x;
  for (var c = 0u; c < 16u; c++) { dst[c * plane + cell] = src[c * plane + cell] * keep; }
}
`;

const DRAW = /* wgsl */ `
struct View {
  canvas: vec2<f32>, cell: f32, dotScale: f32,
  origin: vec2<f32>, grid: vec2<f32>,
  alive: f32, mode: f32, channel: f32, pad: f32,
};
@group(0) @binding(0) var<storage, read> state: array<f32>;
@group(0) @binding(1) var<uniform> V: View;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) color: vec4<f32>,
};

@vertex
fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> VSOut {
  var corners = array<vec2<f32>, 6>(
    vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
    vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
  );
  let w = u32(V.grid.x);
  let plane = w * u32(V.grid.y);
  let gx = f32(i % w);
  let gy = f32(i / w);
  let a = clamp(state[3u * plane + i], 0.0, 1.0);
  var out: VSOut;
  out.local = corners[v];
  if (a <= V.alive) {
    out.pos = vec4<f32>(2.0, 2.0, 0.0, 1.0);
    out.color = vec4<f32>(0.0);
    return out;
  }
  let radius = 0.5 * V.cell * V.dotScale * (0.55 + 0.45 * a);
  let px = V.origin + (vec2<f32>(gx, gy) + 0.5) * V.cell + corners[v] * radius;
  out.pos = vec4<f32>(px.x / V.canvas.x * 2.0 - 1.0, 1.0 - px.y / V.canvas.y * 2.0, 0.0, 1.0);
  if (V.mode < 0.5) {
    let rgb = clamp(vec3<f32>(state[i], state[plane + i], state[2u * plane + i]) / max(a, 1e-3), vec3(0.0), vec3(1.0));
    out.color = vec4<f32>(rgb, a);
  } else {
    let val = state[u32(V.channel) * plane + i];
    let t = clamp(0.5 + 0.5 * tanh(val), 0.0, 1.0);
    let c = mix(vec3(0.15, 0.35, 1.0), vec3(1.0, 0.35, 0.15), t) * (0.4 + 0.6 * abs(t * 2.0 - 1.0));
    out.color = vec4<f32>(c, 1.0);
  }
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  if (length(in.local) > 1.0) { discard; }
  return vec4<f32>(in.color.rgb * in.color.a, in.color.a);
}
`;

export interface WebGPUNCAOptions {
  /** Use this device instead of requesting one (headless use / tests). */
  device?: GPUDevice;
  /** Destroy `device` in destroy() (default: only if we created it). */
  ownsDevice?: boolean;
}

export async function createWebGPUNCA(
  canvas: HTMLCanvasElement | null,
  model: NCAModel,
  width: number,
  height: number,
  opts: WebGPUNCAOptions = {},
): Promise<NCABackend> {
  if (model.channels !== 16 || model.hidden !== 128) throw new Error('WebGPU NCA backend needs a 16-channel, 128-hidden model');
  let device = opts.device;
  if (!device) {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('WebGPU adapter unavailable');
    device = await adapter.requestDevice();
  }
  const dev = device;
  const format = typeof navigator !== 'undefined' && navigator.gpu ? navigator.gpu.getPreferredCanvasFormat() : 'bgra8unorm';

  const plane = width * height;
  const stateBytes = 16 * plane * 4;
  const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
  let cur = dev.createBuffer({ size: stateBytes, usage });
  const tmp = dev.createBuffer({ size: stateBytes, usage });
  let out = dev.createBuffer({ size: stateBytes, usage });

  const weights = new Float32Array(6144 + 128 + 2048);
  weights.set(blockW1(model), 0);
  weights.set(model.b1, 6144);
  for (let j = 0; j < 128; j++) {
    for (let c = 0; c < 16; c++) weights[6272 + j * 16 + c] = model.w2[c * 128 + j]; // transpose
  }
  const weightBuf = dev.createBuffer({ size: weights.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(weightBuf, 0, weights);

  // One uniform buffer per step in a batch, so a whole batch can go in one submit
  const PARAM_BYTES = 256; // minUniformBufferOffsetAlignment-safe stride
  let paramCap = 0;
  let paramBuf: GPUBuffer | null = null;
  const ensureParams = (n: number) => {
    if (n <= paramCap) return;
    paramBuf?.destroy();
    paramCap = Math.max(n, 16);
    paramBuf = dev.createBuffer({ size: paramCap * PARAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  };

  const pipe = (code: string) => dev.createComputePipeline({
    layout: 'auto',
    compute: { module: dev.createShaderModule({ code }), entryPoint: 'main' },
  });
  const update = pipe(UPDATE);
  const mask = pipe(MASK);
  const damagePipe = pipe(DAMAGE);

  // aux = null for shaders that don't read it ('auto' layouts drop unused bindings)
  const group = (p: GPUComputePipeline, src: GPUBuffer, dst: GPUBuffer, aux: GPUBuffer | null, offset: number) =>
    dev.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: src } },
        { binding: 1, resource: { buffer: dst } },
        ...(aux ? [{ binding: 2, resource: { buffer: aux } }] : []),
        { binding: 3, resource: { buffer: paramBuf!, offset, size: 48 } },
      ],
    });

  const params = (step: number, seed: number, disc = [0, 0, 0]) => {
    const b = new ArrayBuffer(48);
    const u = new Uint32Array(b), f = new Float32Array(b);
    u[0] = width; u[1] = height; u[2] = step >>> 0; u[3] = seed >>> 0;
    u[4] = Math.floor(model.fireRate * (1 << 24)); f[5] = model.aliveThreshold;
    f[6] = disc[0]; f[7] = disc[1]; f[8] = disc[2]; u[9] = model.hidden;
    return b;
  };
  const wg = [Math.ceil(width / 8), Math.ceil(height / 8)] as const;

  // ---- drawing (only with a canvas) ----
  let ctx: GPUCanvasContext | null = null;
  let drawPipe: GPURenderPipeline | null = null;
  let viewBuf: GPUBuffer | null = null;
  if (canvas) {
    ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('WebGPU context unavailable');
    ctx.configure({ device: dev, format, alphaMode: 'premultiplied' });
    const module = dev.createShaderModule({ code: DRAW });
    drawPipe = dev.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
    viewBuf = dev.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  const backend: NCABackend = {
    kind: 'webgpu',
    width,
    height,
    advance(n, step, seed) {
      if (n <= 0) return;
      ensureParams(n);
      const enc = dev.createCommandEncoder();
      for (let i = 0; i < n; i++) {
        dev.queue.writeBuffer(paramBuf!, i * PARAM_BYTES, params(step + i, seed));
        let pass = enc.beginComputePass();
        pass.setPipeline(update);
        pass.setBindGroup(0, group(update, cur, tmp, weightBuf, i * PARAM_BYTES));
        pass.dispatchWorkgroups(wg[0], wg[1]);
        pass.end();
        pass = enc.beginComputePass();
        pass.setPipeline(mask);
        pass.setBindGroup(0, group(mask, cur, out, tmp, i * PARAM_BYTES));
        pass.dispatchWorkgroups(wg[0], wg[1]);
        pass.end();
        [cur, out] = [out, cur];
      }
      dev.queue.submit([enc.finish()]);
    },
    setState(state) {
      dev.queue.writeBuffer(cur, 0, state as Float32Array<ArrayBuffer>);
    },
    async readState() {
      const staging = dev.createBuffer({ size: stateBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = dev.createCommandEncoder();
      enc.copyBufferToBuffer(cur, 0, staging, 0, stateBytes);
      dev.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const copy = new Float32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      staging.destroy();
      return copy;
    },
    damage(cx, cy, r) {
      ensureParams(1);
      dev.queue.writeBuffer(paramBuf!, 0, params(0, 0, [cx, cy, r]));
      const enc = dev.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(damagePipe);
      pass.setBindGroup(0, group(damagePipe, cur, out, null, 0));
      pass.dispatchWorkgroups(wg[0], wg[1]);
      pass.end();
      dev.queue.submit([enc.finish()]);
      [cur, out] = [out, cur];
    },
    draw(p: DrawParams) {
      if (!ctx || !drawPipe || !canvas) return;
      const fit = fitGrid(canvas, width, height);
      dev.queue.writeBuffer(viewBuf!, 0, new Float32Array([
        canvas.width, canvas.height, fit.cell, p.dotScale,
        fit.ox, fit.oy, width, height,
        model.aliveThreshold, p.view === 'rgba' ? 0 : 1, p.channel, 0,
      ]));
      const enc = dev.createCommandEncoder();
      const rp = enc.beginRenderPass({
        colorAttachments: [{
          view: ctx.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      rp.setPipeline(drawPipe);
      rp.setBindGroup(0, dev.createBindGroup({
        layout: drawPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: cur } },
          { binding: 1, resource: { buffer: viewBuf! } },
        ],
      }));
      rp.draw(6, plane, 0, 0);
      rp.end();
      dev.queue.submit([enc.finish()]);
    },
    destroy() {
      for (const b of [cur, tmp, out, weightBuf, paramBuf, viewBuf]) b?.destroy();
      ctx?.unconfigure();
      if (opts.ownsDevice ?? !opts.device) dev.destroy();
    },
  };
  return backend;
}
