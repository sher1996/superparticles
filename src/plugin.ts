// Plugin registry (shared definitions) and per-engine plugin hosts (active state)
import type { ForceFn, ShaderSource, ShaderPlugin, ParticlePlugin } from './types/plugin.js';

type Tagged<T> = T & { __id?: string };

const registry = new Map<string, ParticlePlugin>();
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
      registry.set('fireworks-force', fireworksForce.default);
      registry.set('gravity-well-force', gravityWellForce.default);
      registry.set('gravity-well-shader', gravityWellShader.default);
    } catch (error) {
      loading = null;
      console.error('SuperParticles: failed to load plugins', error);
    }
  })();
  return loading;
}

/** Register a third-party plugin under `id` so engines can toggle it. */
export function registerPlugin(id: string, plugin: ParticlePlugin) {
  registry.set(id, plugin);
}

/** Active plugins for one engine. */
export class PluginHost {
  forces: Array<Tagged<ForceFn>> = [];
  shaders: Array<Tagged<ShaderSource>> = [];
  shaderPlugins: Array<Tagged<ShaderPlugin>> = [];
  /** Bumped whenever the active shader set changes so renderers can rebuild. */
  shaderVersion = 0;

  private removeById(id: string) {
    const shaderCount = this.shaders.length + this.shaderPlugins.length;
    this.forces = this.forces.filter(f => f.__id !== id);
    this.shaders = this.shaders.filter(s => s.__id !== id);
    this.shaderPlugins = this.shaderPlugins.filter(s => s.__id !== id);
    if (this.shaders.length + this.shaderPlugins.length !== shaderCount) this.shaderVersion++;
  }

  setEnabled(type: 'force' | 'shader', id: string, enabled: boolean) {
    // Always clear first so enabling twice never registers duplicates
    this.removeById(id);
    if (!enabled) return;

    const plugin = registry.get(id);
    if (!plugin) {
      console.warn(`SuperParticles: unknown plugin "${id}"`);
      return;
    }

    if (type === 'force') {
      plugin.registerForce?.(force => {
        // Wrap so the same plugin function can be tagged per engine
        const tagged: Tagged<ForceFn> = (p, i, b) => force(p, i, b);
        tagged.__id = id;
        this.forces.push(tagged);
      });
    } else {
      plugin.registerShader?.(shader => {
        // Strings are primitives, so wrap to carry the id
        const tagged = Object.assign(new String(shader), { __id: id }) as unknown as Tagged<ShaderSource>;
        this.shaders.push(tagged);
        this.shaderVersion++;
      });
      plugin.registerShaderPlugin?.(sp => {
        this.shaderPlugins.push(Object.assign({}, sp, { __id: id }));
        this.shaderVersion++;
      });
    }
  }

  disable(id: string) {
    this.removeById(id);
  }

  state() {
    return {
      forces: this.forces.map(f => f.__id),
      shaders: [...this.shaders, ...this.shaderPlugins].map(s => s.__id),
    };
  }

  /** The GLSL fragment shader to use, or undefined for the default. */
  glsl(): string | undefined {
    for (let i = this.shaderPlugins.length - 1; i >= 0; i--) {
      if (this.shaderPlugins[i].glsl) return this.shaderPlugins[i].glsl;
    }
    if (this.shaders.length) return String(this.shaders[this.shaders.length - 1]);
    return undefined;
  }

  /** The WGSL module to use, or undefined for the default. */
  wgsl(): string | undefined {
    for (let i = this.shaderPlugins.length - 1; i >= 0; i--) {
      if (this.shaderPlugins[i].wgsl) return this.shaderPlugins[i].wgsl;
    }
    return undefined;
  }
}
