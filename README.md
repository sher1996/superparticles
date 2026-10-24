# SuperParticles

A lightweight TypeScript particle engine that grows into **smart particles**: cells that each run the same tiny neural network, see only their neighbours, and together grow a shape from a single seed, hold it, and heal it after damage.

- **Particle engine**: Canvas2D, WebGL2 and WebGPU renderers over one shared simulation, plugins for forces and shaders, live controls. About 5 KB gzipped for the core plus Canvas2D.
- **Smart Particles** (`superparticles/nca`, optional): neural cellular automata trained with the included PyTorch scripts and run in the browser on WebGPU compute, WebGL2 or the CPU, with identical results on each.
- **Reproducible**: seeded runs replay exactly (step counter + state hash), on any screen size and renderer.
- **Polite by default**: respects `prefers-reduced-motion`, pauses in hidden tabs, cleans up GPU resources on `stop()`.

## Quick start

```bash
git clone https://github.com/sher1996/superparticles.git
cd superparticles
npm install
npm run build
npm start          # serves the repo at http://localhost:8000
```

Then open:

| Page | What it shows |
|---|---|
| <http://localhost:8000/playground/> | Particle playground: renderers, plugins, presets |
| <http://localhost:8000/playground/smart.html> | Smart Particles: a heart that grows from one cell. Click or drag to cut it, and watch it heal |
| <http://localhost:8000/playground/train.html> | Train Smart Particles on your own image, in the browser (TensorFlow.js, loaded only on this page) |
| <http://localhost:8000/playground/smart3d.html> | 3D proof of concept: a voxel planet with a ring, with PLY export for Blender |
| <http://localhost:8000/playground/bench.html> | Benchmark for your own device, with copyable JSON results |

The pages use ES modules, so they must be served over HTTP (opening them as `file://` won't work).

## Embed on any website

```html
<canvas data-superparticles data-count="2000" data-renderer="webgl2" style="width:100%;height:300px"></canvas>
<canvas data-smart-particles data-model="/models/heart.nca.json" style="width:400px;height:400px"></canvas>
<script type="module" src="https://cdn.jsdelivr.net/npm/superparticles@0.2.0-alpha.1/dist/embed.js"></script>
```

The embed script is 0.7 KB. It loads the engine or Smart Particles only for canvases that ask for them, and also picks up canvases added later. Attributes: `data-count`, `data-size`, `data-speed`, `data-color`, `data-renderer`, `data-deterministic`, `data-plugins`. For Smart Particles: `data-model`, `data-backend`, `data-seed`, `data-steps-per-frame`, `data-interactive`. The CDN link works once the package is published to npm. Until then, serve `dist/embed.js` yourself. The Smart Particles page can also record an 8-second video and copy embed code.

## Particle engine

```javascript
import { createEngine } from 'superparticles';

const engine = await createEngine(document.querySelector('canvas'), {
  particleCount: 2000,
  particleSize: 2,     // CSS pixels
  speed: 40,
  color: '#70c1ff',
  useWebGL: true,      // or useWebGPU: true; falls back automatically
  deterministic: true,
  world: { width: 800, height: 600 }, // optional: fixed world units for identical replays
});

console.log(engine.renderer);        // 'webgl2', or whatever it fell back to
engine.setPluginEnabled('force', 'gravity-well-force', true);
engine.setOptions({ speed: 60, color: '#ff4060', particleCount: 5000 });

engine.pause(); engine.step(10); engine.resume();
console.log(engine.getStep(), engine.stateHash());
engine.stop();
```

Each engine is independent, so several can run on one page. A canvas keeps the first context type it gets, so to switch renderers, stop the engine and give the new one a fresh canvas. The playground does this.

`init()`, `setOptions()`, `setPluginEnabled()`, `exportState()` and `importState()` are still available as module-level functions that act on the most recent engine.

### Options

| Option | Default | Notes |
|---|---|---|
| `particleCount`, `particleSize`, `speed`, `color` | 1000, 2, 40, `#70c1ff` | update live with `setOptions` |
| `useWebGL` / `useWebGPU` | false | WebGPU → WebGL2 → Canvas2D fallback |
| `deterministic` | false | seeded layout; with `world`, exact replay everywhere |
| `world` | follows the canvas (CSS px) | fixed simulation size, letterboxed into the canvas |
| `autoplay` | true | start the frame loop immediately |
| `reducedMotion` | `'pause'` | `'pause'` draws one frame and waits for `resume()`; `'ignore'` animates anyway |
| `pauseWhenHidden` | true | stop simulating in background tabs |
| `onRendererLost` | — | called if the GPU device is lost |

### Writing a plugin

```typescript
import { registerPlugin, type ParticlePlugin } from 'superparticles';

const wind: ParticlePlugin = {
  registerForce(add) {
    // Nudge the position; the engine turns the nudge into velocity.
    add((p, idx, { w, h }) => { p.x += 0.5; });
  },
};

registerPlugin('wind', wind);
engine.setPluginEnabled('force', 'wind', true);
```

Shader plugins use `registerShaderPlugin` and supply a `glsl` fragment shader (WebGL2), a `wgsl` module (WebGPU), or both. `src/types/plugin.ts` documents the uniforms and bindings, and `plugins/GravityWellShader.ts` is a working example. Plugins are ordinary JavaScript with full access to the page, so only load plugins you trust.

## Smart Particles (neural cellular automata)

```javascript
import { createSmartParticles } from 'superparticles/nca';

const sp = await createSmartParticles(canvas, {
  model: '/models/heart.nca.json', // trained with training/, 23 KB
  backend: 'auto',                 // webgpu → webgl2 → cpu
  seed: 0,                         // same seed + same actions = same result
});

sp.damage(32, 32, 8);       // cut a hole (grid units); clicking the canvas does too
sp.setView('hidden', 5);    // look at a hidden channel the cells use to communicate
const { alive } = await sp.snapshot();
sp.reset();                 // back to a single seed cell
```

Each cell holds 16 numbers (colour, opacity, and 12 hidden channels). Every step it looks at its 3×3 neighbourhood through fixed edge-detection filters and feeds what it sees into one small shared network (8,320 weights), which outputs a change to its own state. No cell knows the target shape. The shape comes from all of them running the same learned rule. During training the pattern is repeatedly damaged, so the rule also learns to repair it.

- **Backends**: WebGPU compute shaders, WebGL2 float textures, or a CPU reference. All three reproduce the PyTorch definition exactly: the GPU paths match it within 1e-4, and the random update mask matches bit for bit.
- **Train your own**: in the browser with `playground/train.html` (no Python, nothing uploaded), or with the PyTorch scripts in [`training/README.md`](training/README.md). The shipped 64×64 heart trained in a few hours on 4 CPU cores. Both trainers produce the same model format.
- **3D**: `NCAGrid3DCPU` runs voxel models (16×16×16) and exports coloured point clouds.
- **Research notes and measured results**: [`docs/research/chapter-6-nca.md`](docs/research/chapter-6-nca.md).

## Development

| Command | What it does |
|---|---|
| `npm run build` | Bundles to `dist/` and fails if the core goes over 15 KB gzipped |
| `npm start` | Serves the repo on port 8000 |
| `npm run typecheck` | TypeScript checker |
| `npm test` | Unit tests: physics, replay, plugins, NCA parity with PyTorch (2D and 3D) |
| `npm run test:browser` | End-to-end tests in headless Chromium (run `npm run build` first) |
| `npm run test:webgpu` | Runs the WebGPU compute shaders headless (Dawn + SwiftShader) against PyTorch |

Project status and plans: [`STATUS.md`](STATUS.md) and [`ROADMAP.md`](ROADMAP.md).

## Performance

Run `playground/bench.html` on your own device. It measures frame rate and physics cost per particle count and renderer, plus Smart Particles steps per second for each backend, and records the browser and GPU details with the results. Numbers that haven't been measured this way aren't claimed here.

## License

MIT, see [LICENSE](LICENSE).
