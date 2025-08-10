export async function drawGPU(canvas: HTMLCanvasElement, opts: any) {
  const adapter = await navigator.gpu!.requestAdapter();
  const device = await adapter!.requestDevice();
  const ctx = canvas.getContext('webgpu') as GPUCanvasContext;
  
  // Import shaders from plugin system
  const { shaders, shaderPlugins, loadPlugins } = await import('./plugin.js');
  
  // Wait for plugins to load if not deterministic
  if (!opts.deterministic) {
    await loadPlugins({ deterministic: opts.deterministic });
  }
  
  // Configure swap chain
  const canvasFormat = navigator.gpu!.getPreferredCanvasFormat();
  ctx.configure({
    device,
    format: canvasFormat,
    alphaMode: 'premultiplied',
  });

  // Load shader module
  let shaderCode = await loadShaderCode();
  if (shaderPlugins.length > 0) {
    const plugin = shaderPlugins[shaderPlugins.length - 1];
    if (plugin.wgsl) {
      shaderCode = plugin.wgsl;
    }
  } else if (shaders.length > 0) {
    shaderCode = shaders[shaders.length - 1];
  }
  
  const shaderMod = device.createShaderModule({
    code: shaderCode,
  });

  // Storage buffer for particles
  const N = opts.particleCount || 1000;
  const particleBuf = device.createBuffer({ 
    size: N * 16, 
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX 
  });

  // Uniform buffer for canvas dimensions and color
  const uniformBuf = device.createBuffer({
    size: 32, // 8 floats: w, h, dpr, padding, r, g, b, a
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Initialize particle data with deterministic seeding if requested
  const particleData = new Float32Array(N * 4);
  const deterministic = opts.deterministic || false;
  const rngSeed = 1337;
  let seed = rngSeed;
  const rand = () => (seed ^= seed << 13, seed ^= seed >> 17, seed ^= seed << 5) >>> 0 / 2**32;
  
  for (let i = 0; i < N; i++) {
    const idx = i * 4;
    particleData[idx] = (deterministic ? rand() : Math.random()) * canvas.width;     // pos.x
    particleData[idx + 1] = (deterministic ? rand() : Math.random()) * canvas.height; // pos.y
    particleData[idx + 2] = (deterministic ? rand() - 0.5 : Math.random() - 0.5) * 2;   // vel.x
    particleData[idx + 3] = (deterministic ? rand() - 0.5 : Math.random() - 0.5) * 2;   // vel.y
  }
  device.queue.writeBuffer(particleBuf, 0, particleData);

  // Create bind groups
  const bindGroup = device.createBindGroup({
    layout: null as any, // Will be set by pipeline
    entries: [
      { binding: 0, resource: { buffer: particleBuf } },
      { binding: 1, resource: { buffer: uniformBuf } },
    ],
  });

  // Compute pipeline
  const compPipeline = device.createComputePipeline({ 
    layout: 'auto',
    compute: { 
      module: shaderMod, 
      entryPoint: 'update'
    } 
  });

  // Render pipeline
  const renderPipeline = device.createRenderPipeline({ 
    layout: 'auto',
    vertex: { 
      module: shaderMod, 
      entryPoint: 'vs'
    }, 
    fragment: { 
      module: shaderMod, 
      entryPoint: 'fs',
      targets: [{ format: canvasFormat }]
    },
    primitive: {
      topology: 'point-list',
    }
  });

  // Update bind group layout after pipeline creation
  const updatedBindGroup = device.createBindGroup({
    layout: compPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: particleBuf } },
      { binding: 1, resource: { buffer: uniformBuf } },
    ],
  });

  const renderBindGroup = device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: particleBuf } },
      { binding: 1, resource: { buffer: uniformBuf } },
    ],
  });

  // Update uniform buffer with canvas dimensions and color
  function updateUniforms() {
    const uniformData = new Float32Array([
      canvas.width, canvas.height, window.devicePixelRatio, 0, // w, h, dpr, padding
      1.0, 1.0, 1.0, 0.8 // r, g, b, a
    ]);
    device.queue.writeBuffer(uniformBuf, 0, uniformData);
  }

  // Load shader code
  async function loadShaderCode(): Promise<string> {
    try {
      const response = await fetch('./src/shader.wgsl');
      return await response.text();
    } catch (error) {
      console.error('Failed to load shader:', error);
      return getDefaultShader();
    }
  }

  function getDefaultShader(): string {
    return `
      struct Particle {
        pos: vec2<f32>,
        vel: vec2<f32>,
      };

      struct Uniforms {
        w: f32,
        h: f32,
        dpr: f32,
        color: vec4<f32>,
      };

      @group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
      @group(0) @binding(1) var<uniform> uniforms: Uniforms;

      @compute @workgroup_size(256)
      fn update(@builtin(global_invocation_id) id: vec3<u32>) {
        let i = id.x;
        if (i >= arrayLength(&particles)) { return; }

        var p = particles[i];

        let k: f32 = 0.002;
        let amp: f32 = 4.0;
        let dt: f32 = 1.0/120.0;

        p.vel.x += sin(p.pos.y * k) * amp * dt;
        p.vel.y += cos(p.pos.x * k) * amp * dt;

        let w: f32 = uniforms.w;
        let h: f32 = uniforms.h;

        p.pos += p.vel * dt;
        // Bounce-and-clamp edges
        let elasticity: f32 = 0.9;
        if (p.pos.x < 0.0)  { p.pos.x = 0.0; p.vel.x = -p.vel.x * elasticity; }
        if (p.pos.x > w)    { p.pos.x = w;   p.vel.x = -p.vel.x * elasticity; }
        if (p.pos.y < 0.0)  { p.pos.y = 0.0; p.vel.y = -p.vel.y * elasticity; }
        if (p.pos.y > h)    { p.pos.y = h;   p.vel.y = -p.vel.y * elasticity; }
        
        particles[i] = p;
      }

      @vertex
      fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
        let p = particles[i].pos;
        let clip = vec2<f32>(p.x / uniforms.w * 2.0 - 1.0,
                             1.0 - p.y / uniforms.h * 2.0);
        return vec4<f32>(clip, 0.0, 1.0);
      }

      @fragment
      fn fs() -> @location(0) vec4<f32> {
        return uniforms.color;
      }
    `;
  }

  // Frame function
  function frame() {
    // Update uniforms
    updateUniforms();

    // Encode: compute pass -> render pass
    const encoder = device.createCommandEncoder();
    
    // Compute pass
    {
      let pass = encoder.beginComputePass();
      pass.setPipeline(compPipeline);
      pass.setBindGroup(0, updatedBindGroup);
      pass.dispatchWorkgroups(Math.ceil(N / 256));
      pass.end();
    }
    
    // Render pass
    {
      let rp = encoder.beginRenderPass({
        colorAttachments: [{
          view: ctx.getCurrentTexture().createView(),
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      rp.setPipeline(renderPipeline);
      rp.setBindGroup(0, renderBindGroup);
      rp.draw(N, 1, 0, 0);
      rp.end();
    }
    
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }

  // Start the animation loop
  frame();

  // Return a renderer object with stop method
  return {
    stop: () => {
      // Note: WebGPU doesn't have a built-in stop mechanism
      // The animation will continue until the page is unloaded
      // In a real implementation, you might want to add a flag to stop the frame loop
      console.log('WebGPU renderer stop called - animation continues');
    }
  };
} 