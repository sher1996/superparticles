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

// Fragment shader for rendering particles
@fragment
fn fs() -> @location(0) vec4<f32> {
  return uniforms.color;
} 