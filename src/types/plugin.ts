export type Vec2 = { x: number; y: number };

/** Simulation area in canvas pixels. */
export type Bounds = { w: number; h: number };

/**
 * A force nudges the particle position `p` in place. The engine turns the
 * nudge into velocity, so small values (a pixel or two per step) go a long way.
 */
export type ForceFn = ((p: Vec2, idx: number, bounds: Readonly<Bounds>) => void) & { __id?: string };
export type ShaderSource = string & { __id?: string };

/**
 * Shader replacement for the GPU renderers.
 *
 * - `glsl`: a complete WebGL2 (`#version 300 es`) fragment shader. Available
 *   uniforms: `vec4 uCol`, `vec2 uResolution`. Use `gl_PointCoord` for the
 *   position inside the particle.
 * - `wgsl`: a complete WebGPU module exposing `vs` and `fs`, using the same
 *   bindings as `src/shader.wgsl` (positions at binding 0, uniforms at binding 1).
 */
export interface ShaderPlugin {
  wgsl?: string;
  glsl?: string;
}

/**
 * Particle plugin interface for registering forces and shaders.
 *
 * Force Application Order:
 * 1. Plugin forces (registered via registerForce) - applied first
 * 2. Built-in sine field forces - applied after plugin forces
 * 3. Position updates using accumulated velocity
 */
export interface ParticlePlugin {
  registerForce?: (add: (fn: ForceFn) => void) => void;
  /** Legacy: a raw GLSL fragment shader string. Prefer registerShaderPlugin. */
  registerShader?: (add: (src: ShaderSource) => void) => void;
  registerShaderPlugin?: (add: (plugin: ShaderPlugin) => void) => void;
}

export interface PluginOptions {
  deterministic?: boolean;
}
