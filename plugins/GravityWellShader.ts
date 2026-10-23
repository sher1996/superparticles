import type { ParticlePlugin, ShaderPlugin } from '../src/index.js';

// Particles dim as they get closer to the center of the canvas.
// Canvas2D has no shaders, so this plugin only affects WebGL2 and WebGPU.

const wgslShader = /* wgsl */ `
struct Uniforms {
  w: f32,
  h: f32,
  dpr: f32,
  size: f32,
  color: vec4<f32>,
  view: vec4<f32>,  // world -> pixels: scale xy, offset zw
};

@group(0) @binding(0) var<storage, read> positions: array<vec2<f32>>;
@group(0) @binding(1) var<uniform> uniforms: Uniforms;

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) local: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> VSOut {
  var corners = array<vec2<f32>, 6>(
    vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
    vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
  );
  let corner = corners[v];
  let p = positions[i] * uniforms.view.xy + uniforms.view.zw + corner * uniforms.size * 0.5;
  var out: VSOut;
  out.position = vec4<f32>(p.x / uniforms.w * 2.0 - 1.0, 1.0 - p.y / uniforms.h * 2.0, 0.0, 1.0);
  out.local = corner;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  if (length(in.local) > 1.0) { discard; }
  let res = vec2<f32>(uniforms.w, uniforms.h);
  let distance = length(in.position.xy - res * 0.5);
  let darkness = 1.0 - (1.0 - distance / (length(res) * 0.5)) * 0.8;
  return vec4<f32>(uniforms.color.rgb * darkness, uniforms.color.a);
}
`;

const glslShader = /* glsl */ `#version 300 es
precision mediump float;
uniform vec4 uCol;
uniform vec2 uResolution;
out vec4 fragColor;

void main() {
  if (length(gl_PointCoord - 0.5) > 0.5) discard;
  float distance = length(gl_FragCoord.xy - uResolution * 0.5);
  float darkness = 1.0 - (1.0 - distance / (length(uResolution) * 0.5)) * 0.8;
  fragColor = vec4(uCol.rgb * darkness, uCol.a);
}
`;

const plugin: ParticlePlugin = {
  registerShaderPlugin: (add: (plugin: ShaderPlugin) => void) => {
    add({ wgsl: wgslShader, glsl: glslShader });
  }
};

export default plugin;
