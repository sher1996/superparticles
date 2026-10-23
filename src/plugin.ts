// Plugin registry and management
import type { ForceFn, ShaderSource, ShaderPlugin, ParticlePlugin } from './types/plugin.js';

type Tagged<T> = T & { __id?: string };

let forces: Array<Tagged<ForceFn>> = [];
let shaders: Array<Tagged<ShaderSource>> = [];
let shaderPlugins: Array<Tagged<ShaderPlugin>> = [];

// Bumped whenever the active shader set changes so renderers can rebuild
let shaderVersion = 0;

export function getActiveForces() { return forces; }
export function getActiveShaders() { return shaders; }
export function getActiveShaderPlugins() { return shaderPlugins; }
export function getShaderVersion() { return shaderVersion; }

const pluginRegistry = new Map<string, ParticlePlugin>();
let loading: Promise<void> | null = null;

/** Load the bundled plugins. Safe to call more than once. */
export function loadPlugins(_: { deterministic?: boolean } = {}) {
  loading ??= (async () => {
    try {
      const [fireworksForce, gravityWellForce, gravityWellShader] = await Promise.all([
        import('../plugins/FireworksForce.js'),
        import('../plugins/GravityWellForce.js'),
        import('../plugins/GravityWellShader.js'),
      ]);
      pluginRegistry.set('fireworks-force', fireworksForce.default);
      pluginRegistry.set('gravity-well-force', gravityWellForce.default);
      pluginRegistry.set('gravity-well-shader', gravityWellShader.default);
    } catch (error) {
      loading = null;
      console.error('SuperParticles: failed to load plugins', error);
    }
  })();
  return loading;
}

/** Register a third-party plugin under `id` so it can be toggled like the bundled ones. */
export function registerPlugin(id: string, plugin: ParticlePlugin) {
  pluginRegistry.set(id, plugin);
}

function removeById(id: string) {
  const shaderCount = shaders.length + shaderPlugins.length;
  forces = forces.filter(f => f.__id !== id);
  shaders = shaders.filter(s => s.__id !== id);
  shaderPlugins = shaderPlugins.filter(s => s.__id !== id);
  if (shaders.length + shaderPlugins.length !== shaderCount) shaderVersion++;
}

export function setPluginEnabled(type: 'force' | 'shader', id: string, enabled: boolean) {
  // Always clear first so enabling twice never registers duplicates
  removeById(id);
  if (!enabled) return;

  const plugin = pluginRegistry.get(id);
  if (!plugin) {
    console.warn(`SuperParticles: unknown plugin "${id}"`);
    return;
  }

  if (type === 'force') {
    plugin.registerForce?.(force => {
      forces.push(Object.assign(force, { __id: id }));
    });
  } else {
    plugin.registerShader?.(shader => {
      // Strings are primitives, so wrap to carry the id
      const tagged = Object.assign(new String(shader), { __id: id }) as unknown as Tagged<ShaderSource>;
      shaders.push(tagged);
      shaderVersion++;
    });
    plugin.registerShaderPlugin?.(sp => {
      shaderPlugins.push(Object.assign({}, sp, { __id: id }));
      shaderVersion++;
    });
  }
}

export function getPluginState() {
  return {
    forces: forces.map(f => f.__id),
    shaders: [...shaders, ...shaderPlugins].map(s => s.__id),
  };
}

export function disablePlugin(id: string) {
  removeById(id);
}

/** Pick the GLSL fragment shader to use, or undefined for the default. */
export function currentGLSL(): string | undefined {
  for (let i = shaderPlugins.length - 1; i >= 0; i--) {
    if (shaderPlugins[i].glsl) return shaderPlugins[i].glsl;
  }
  if (shaders.length) return String(shaders[shaders.length - 1]);
  return undefined;
}

/** Pick the WGSL module to use, or undefined for the default. */
export function currentWGSL(): string | undefined {
  for (let i = shaderPlugins.length - 1; i >= 0; i--) {
    if (shaderPlugins[i].wgsl) return shaderPlugins[i].wgsl;
  }
  return undefined;
}
