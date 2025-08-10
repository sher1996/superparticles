export type Vec2 = { x: number; y: number };

export type ForceFn = ((p: Vec2, idx: number) => void) & { __id?: string };
export type ShaderSource = string & { __id?: string };

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
 * 
 * Note: Plugin forces have priority and are applied before the core physics system.
 */
export interface ParticlePlugin {
  registerForce?: (add: (fn: ForceFn) => void) => void;
  registerShader?: (add: (src: ShaderSource) => void) => void;
  registerShaderPlugin?: (add: (plugin: ShaderPlugin) => void) => void;
}

export interface PluginOptions {
  deterministic?: boolean;
} 