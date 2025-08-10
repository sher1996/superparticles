<<<<<<< HEAD
# superparticles
Ultra-light TypeScript particle engine with WebGPU/WebGL/Canvas fallbacks, plugin system, and interactive playground
=======
# SuperParticles

Ultra‑light TypeScript canvas scaffold with plugin system and playground.

```html
<script type="module" src="superparticles.min.js"></script>
```

## Quick Start

### Interactive Playground
Try the [live playground](https://your-domain.com/playground) to experiment with:
- Real-time parameter adjustments
- Plugin system (forces, shaders)
- Preset sharing via URLs
- Multiple renderers (Canvas2D, WebGL2, WebGPU)

### Basic Usage
```javascript
import { init, setOptions, setPluginEnabled } from 'superparticles';

const canvas = document.getElementById('canvas');
const engine = await init(canvas, { 
  particleCount: 1000, 
  speed: 40,
  deterministic: true 
});

// Enable plugins
setPluginEnabled('force', 'fireworks-force', true);
setPluginEnabled('shader', 'gravity-well-shader', true);

// Adjust settings
setOptions({ speed: 60, color: '#ff0000' });
```

## Install & build

```bash
git clone <repo‑url>
cd superparticles
npm install
npm run build
```

Open `playground/index.html` in your browser to start experimenting.

## Performance Benchmarks

| Mode | Max Particles | RTX 3060 FPS | Intel Iris FPS |
|------|---------------|---------------|----------------|
| Canvas2D | 20,000 | 60 | 60 |
| WebGL2 | 100,000 | 60 | 24 |
| WebGPU | 1,000,000 | 60 | n/a |

See `docs/perf-matrix.json` for detailed benchmark results and analysis.

## Features

- **Plugin System**: Extensible force and shader plugins
- **Multiple Renderers**: Canvas2D, WebGL2, and WebGPU support
- **Deterministic Mode**: Reproducible behavior for sharing presets
- **Real-time Controls**: Adjust parameters while running
- **Preset URLs**: Share configurations via encoded URLs
- **Performance Monitoring**: Built-in FPS counter and optimization 
>>>>>>> master
