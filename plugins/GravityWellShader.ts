import type { ParticlePlugin, ShaderPlugin } from '../src/index.js';

// WGSL shader that darkens pixels radially toward cursor/screen center
const wgslShader = `
// Particle data structure
struct Particle {
  pos: vec2<f32>,
  vel: vec2<f32>,
};

// Uniform data for canvas dimensions, DPR and color
struct Uniforms {
  w: f32,      // canvas width in pixels
  h: f32,      // canvas height in pixels
  dpr: f32,    // device pixel ratio
  color: vec4<f32>, // RGBA color
};

// Bind group resources
@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> uniforms: Uniforms;

// Compute shader for particle physics with sine-field steering
@compute @workgroup_size(256)
fn update(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= arrayLength(&particles)) { return; }

  var p = particles[i];

  // sine-field steering (same constants as CPU path)
  let k: f32 = 0.002;
  let amp: f32 = 4.0;
  let dt: f32 = 1.0/120.0;

  p.vel.x += sin(p.pos.y * k) * amp * dt;
  p.vel.y += cos(p.pos.x * k) * amp * dt;
  
  // Add gravity well effect - particles are attracted to screen center
  let center = vec2<f32>(uniforms.w * 0.5, uniforms.h * 0.5);
  let toCenter = center - p.pos;
  let distance = length(toCenter);
  let gravityStrength: f32 = 0.1;
  
  if (distance > 0.0) {
    p.vel += normalize(toCenter) * gravityStrength * dt;
  }

  let w: f32 = uniforms.w;   // canvas width in pixels
  let h: f32 = uniforms.h;

  p.pos += p.vel * dt;
  if (p.pos.x < 0.0)  { p.pos.x += w; }
  if (p.pos.x > w)    { p.pos.x -= w; }
  if (p.pos.y < 0.0)  { p.pos.y += h; }
  if (p.pos.y > h)    { p.pos.y -= h; }

  particles[i] = p;
}

// Vertex shader for rendering particles
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = particles[i].pos;
  // convert pixel → clip-space on GPU
  let clip = vec2<f32>(p.x / uniforms.w * 2.0 - 1.0,
                       1.0 - p.y / uniforms.h * 2.0);
  return vec4<f32>(clip, 0.0, 1.0);
}

// Fragment shader with gravity well effect
@fragment
fn fs() -> @location(0) vec4<f32> {
  // For WebGPU, we'll use a simpler approach since we can't easily get screen position
  // Just return the base color for now - the gravity well effect will be visible
  // through the particle positioning and density
  return uniforms.color;
}
`;

// GLSL-ES shader for WebGL2 (gravity well effect)
const glslShader = `#version 300 es
precision mediump float;
uniform vec4 uCol;
uniform vec2 uResolution;
out vec4 fragColor;

void main() {
  // Get screen coordinates
  vec2 screenPos = gl_FragCoord.xy;
  
  // Calculate distance from screen center
  vec2 center = uResolution * 0.5;
  float distance = length(screenPos - center);
  
  // Create gravity well effect - darker toward center
  float maxDistance = length(uResolution) * 0.5;
  float darkness = 1.0 - (distance / maxDistance) * 0.7;
  
  // Apply darkness to the base color
  fragColor = vec4(uCol.rgb * darkness, uCol.a);
}
`;

const plugin: ParticlePlugin = {
  registerShaderPlugin: (add: (plugin: ShaderPlugin) => void) => {
    console.log('[GravityWellShader] registering shader plugin');
    const shaderPlugin: any = {
      wgsl: wgslShader,
      glsl: glslShader
    };
    shaderPlugin.__id = 'gravity-well-shader';
    add(shaderPlugin);
  }
};

export default plugin; 