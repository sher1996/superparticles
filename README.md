# SuperParticles

Ultra-light TypeScript particle engine with Canvas2D, WebGL2 and WebGPU renderers, a plugin system for forces and shaders, and an interactive playground.

- **Tiny**: the core plus the Canvas2D renderer and the bundled plugins is about 4 KB gzipped. The GPU renderers are separate chunks that load only when you choose them.
- **Three renderers, one simulation**: physics runs on the CPU and is shared, so plugins, particle count, speed and deterministic mode behave the same whichever renderer you pick. WebGPU falls back to WebGL2, and WebGL2 falls back to Canvas2D.
- **Plugins**: forces (Fireworks, Gravity Well) and shaders (Gravity Well) can be switched on and off while it runs.
- **Deterministic mode**: a fixed seed gives the same starting layout on every machine, so shared presets look the same.
- **Live controls**: color, size, speed and particle count all update while it runs.

## Quick start

```bash
git clone https://github.com/sher1996/superparticles.git
cd superparticles
npm install
npm run build
npm start          # serves the repo at http://localhost:8000
```

Then open <http://localhost:8000/playground/>. The page uses ES modules, so it needs to be served over HTTP. Opening the file directly with `file://` won't work.

## Usage

```javascript
import { init, setOptions, setPluginEnabled } from './dist/index.js';

const canvas = document.getElementById('canvas');
const engine = await init(canvas, {
  particleCount: 2000,
  particleSize: 2,   // CSS pixels
  speed: 40,
  color: '#70c1ff',
  useWebGL: true,    // or useWebGPU: true
  deterministic: true,
});

console.log(engine.renderer); // 'webgl2', or whatever it fell back to

setPluginEnabled('force', 'gravity-well-force', true);
setPluginEnabled('shader', 'gravity-well-shader', true); // WebGL2/WebGPU only

setOptions({ speed: 60, color: '#ff4060', particleCount: 5000 });

engine.stop();
```

A canvas keeps the first context type it gets. To switch renderers, call `engine.stop()` and pass a **new** canvas element to `init`. The playground does this.

### API

| Export | Description |
|---|---|
| `init(canvas, options)` | Starts rendering and returns `{ renderer, stop, disablePlugin }`. |
| `setOptions(options)` | Updates `color`, `particleSize`, `speed`, `particleCount` and `deterministic` while running. |
| `exportState()` / `importState(state)` | Saves or restores options, e.g. for preset URLs. |
| `setPluginEnabled(type, id, enabled)` | Turns a registered plugin on or off. Calling it twice has no extra effect. |
| `registerPlugin(id, plugin)` | Adds your own plugin so it can be toggled. |
| `getPluginState()` | Lists the active force and shader plugin ids. |

### Writing a plugin

```typescript
import type { ParticlePlugin } from 'superparticles';

const wind: ParticlePlugin = {
  registerForce(add) {
    // Nudge the position; the engine turns the nudge into velocity.
    add((p, idx, { w, h }) => { p.x += 0.5; });
  },
};

registerPlugin('wind', wind);
setPluginEnabled('force', 'wind', true);
```

Shader plugins use `registerShaderPlugin` and supply a `glsl` fragment shader (WebGL2), a `wgsl` module (WebGPU), or both. `src/types/plugin.d.ts` lists the uniforms and bindings you can use, and `plugins/GravityWellShader.ts` is a working example.

## Development

| Command | What it does |
|---|---|
| `npm run build` | Bundles to `dist/` and fails if the gzipped size goes over 15 KB. |
| `npm start` | Serves the repo on port 8000. |
| `npm run typecheck` | Runs the TypeScript checker. |
| `npm test` | Runs the unit tests for the physics and plugin registry. |
| `npm run test:browser` | Runs end-to-end tests on the playground in headless Chromium (run `npm run build` first). |

## Performance

No benchmarks have been published yet. The physics runs on the CPU, so every renderer has a similar particle limit. GPU renderers mostly save drawing time, which matters most at high particle counts. Use the FPS counter in the playground to measure on your own hardware.

## License

MIT, see [LICENSE](LICENSE).
