/* SuperParticles – WebGPU Renderer */

import type { RenderContext, Renderer } from './render.js';
import { hexToRgba } from './color.js';
import defaultShader from './shader.wgsl';

export async function createWebGPU(rc: RenderContext, onLost?: (reason: string) => void): Promise<Renderer> {
  // Acquire the device and check it can present before touching the canvas,
  // so a failure here leaves the canvas free for a fallback renderer
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  const format = navigator.gpu!.getPreferredCanvasFormat();
  try {
    await probe(device, format);
  } catch (error) {
    device.destroy();
    throw error;
  }

  const ctx = rc.canvas.getContext('webgpu');
  if (!ctx) {
    device.destroy();
    throw new Error('WebGPU context unavailable (the canvas may already use another context type)');
  }
  ctx.configure({ device, format, alphaMode: 'premultiplied' });

  let destroyed = false;
  device.lost.then(info => {
    if (!destroyed) onLost?.(info.message || info.reason || 'device lost');
  });

  const uniformBuf = device.createBuffer({
    size: 48, // w, h, dpr, size | r, g, b, a | sx, sy, ox, oy
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const uniforms = new Float32Array(12);

  let pipeline!: GPURenderPipeline;
  let builtVersion = -1;
  let posBuf: GPUBuffer | null = null;
  let posCapacity = 0;
  let bindGroup: GPUBindGroup | null = null;
  let rebuilding = false;

  function createPipeline(code: string) {
    const module = device.createShaderModule({ code });
    return device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  async function buildPipeline() {
    builtVersion = rc.plugins.shaderVersion;
    const custom = rc.plugins.wgsl();
    let next: GPURenderPipeline | null = null;
    if (custom) {
      device.pushErrorScope('validation');
      const candidate = createPipeline(custom);
      const err = await device.popErrorScope();
      if (err) console.error('SuperParticles: WGSL shader plugin failed, using default shader', err.message);
      else next = candidate;
    }
    pipeline = next ?? createPipeline(defaultShader);
    bindGroup = null;
  }
  await buildPipeline();

  function ensureBuffers(n: number) {
    if (posBuf && posCapacity >= n && bindGroup) return;
    if (!posBuf || posCapacity < n) {
      posBuf?.destroy();
      posCapacity = Math.max(n, 1);
      posBuf = device.createBuffer({
        size: posCapacity * 8,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: posBuf } },
        { binding: 1, resource: { buffer: uniformBuf } },
      ],
    });
  }

  return {
    draw() {
      if (destroyed) return;
      const { canvas, sim, style, view } = rc;
      if (builtVersion !== rc.plugins.shaderVersion && !rebuilding) {
        rebuilding = true;
        buildPipeline().finally(() => { rebuilding = false; });
      }

      const n = sim.count;
      ensureBuffers(n);
      if (n > 0) device.queue.writeBuffer(posBuf!, 0, sim.pos, 0, n * 2);

      const c = hexToRgba(style.color);
      uniforms.set([
        canvas.width, canvas.height, view.dpr, Math.max(1, style.size * view.dpr),
        c.r, c.g, c.b, c.a,
        view.sx, view.sy, view.ox, view.oy,
      ]);
      device.queue.writeBuffer(uniformBuf, 0, uniforms);

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: ctx.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup!);
      if (n > 0) pass.draw(6, n, 0, 0);
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
    destroy() {
      destroyed = true;
      posBuf?.destroy();
      uniformBuf.destroy();
      ctx.unconfigure();
      device.destroy();
    },
  };
}

// Some setups hand out a device whose canvas presentation is broken. Present
// one frame to a throwaway canvas first so we can still fall back cleanly.
async function probe(device: GPUDevice, format: GPUTextureFormat) {
  if (typeof OffscreenCanvas === 'undefined') return;
  const ctx = new OffscreenCanvas(1, 1).getContext('webgpu');
  if (!ctx) throw new Error('WebGPU canvas context unavailable');
  ctx.configure({ device, format, alphaMode: 'premultiplied' });
  const encoder = device.createCommandEncoder();
  encoder.beginRenderPass({
    colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }],
  }).end();
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  ctx.unconfigure();
}
