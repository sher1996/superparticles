// Default WebGPU particle shader.
// Physics runs on the CPU (shared with the other renderers); this module only draws.
// Each particle is an instanced quad (6 vertices) so particle size works on every GPU.

struct Uniforms {
  w: f32,           // canvas width in pixels
  h: f32,           // canvas height in pixels
  dpr: f32,         // device pixel ratio
  size: f32,        // particle size in canvas pixels
  color: vec4<f32>, // RGBA color
};

@group(0) @binding(0) var<storage, read> positions: array<vec2<f32>>;
@group(0) @binding(1) var<uniform> uniforms: Uniforms;

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) local: vec2<f32>, // -1..1 inside the quad
};

@vertex
fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> VSOut {
  var corners = array<vec2<f32>, 6>(
    vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
    vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
  );
  let corner = corners[v];
  let p = positions[i] + corner * uniforms.size * 0.5;
  var out: VSOut;
  out.position = vec4<f32>(p.x / uniforms.w * 2.0 - 1.0, 1.0 - p.y / uniforms.h * 2.0, 0.0, 1.0);
  out.local = corner;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  if (length(in.local) > 1.0) { discard; }
  return uniforms.color;
}
