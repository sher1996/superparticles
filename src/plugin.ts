// Plugin registry and management
import type { ForceFn, ShaderSource, ShaderPlugin } from './types/plugin.js';

export let forces: Array<ForceFn & { __id?: string }> = [];
export let shaders: Array<ShaderSource & { __id?: string }> = [];
export let shaderPlugins: Array<ShaderPlugin & { __id?: string }> = [];

export function getActiveForces() { return forces; }
export function getActiveShaders() { return shaders; }
export function getActiveShaderPlugins() { return shaderPlugins; }

// Plugin registry
const pluginRegistry = new Map<string, any>();

// Load plugins from the plugins directory
export async function loadPlugins(_: { deterministic?: boolean } = {}) {
  try {
    console.log('🔌 Loading plugins...');
    
    // Load force plugins
    const fireworksForce = await import('../plugins/FireworksForce.js');
    const gravityWellForce = await import('../plugins/GravityWellForce.js');
    
    // Load shader plugins
    const gravityWellShader = await import('../plugins/GravityWellShader.js');
    
    // Register plugins
    pluginRegistry.set('fireworks-force', fireworksForce.default);
    pluginRegistry.set('gravity-well-force', gravityWellForce.default);
    pluginRegistry.set('gravity-well-shader', gravityWellShader.default);
    
    console.log('🔌 Plugins loaded:', Array.from(pluginRegistry.keys()));
  } catch (error) {
    console.error('❌ Error loading plugins:', error);
  }
}

export function setPluginEnabled(type: 'force' | 'shader', id: string, enabled: boolean) {
  console.log(`🔌 Setting plugin ${id} (${type}) to ${enabled ? 'enabled' : 'disabled'}`);
  
  if (type === 'force') {
    if (enabled) {
      const plugin = pluginRegistry.get(id);
      if (plugin && plugin.registerForce) {
        plugin.registerForce((force: ForceFn) => {
          const forceWithId = Object.assign(force, { __id: id });
          forces.push(forceWithId);
        });
      }
    } else {
      forces = forces.filter(f => f.__id !== id);
    }
  } else if (type === 'shader') {
    if (enabled) {
      const plugin = pluginRegistry.get(id);
      if (plugin && plugin.registerShader) {
        plugin.registerShader((shader: ShaderSource) => {
          const shaderWithId = Object.assign(shader, { __id: id });
          shaders.push(shaderWithId);
        });
      }
    } else {
      shaders = shaders.filter(s => s.__id !== id);
    }
  }
  
  console.log(`🔌 Active forces: ${forces.length}, Active shaders: ${shaders.length}`);
}

export function getPluginState() { 
  return {
    forces: forces.map(f => f.__id),
    shaders: shaders.map(s => s.__id)
  };
}

export function disablePlugin(id: string) {
  forces = forces.filter((f: any) => f.__id !== id);
  shaders = shaders.filter((s: any) => s.__id !== id);
}

