# SuperParticles

Ultra‑light TypeScript canvas scaffold.

```html
<script type="module" src="superparticles.min.js"></script>
```

## Install & build

```bash
git clone <repo‑url>
cd superparticles
npm install
npm run build
```

Open `demo/index.html` in your browser and check the console for **ready**.

## Performance Benchmarks

| Mode | Max Particles | RTX 3060 FPS | Intel Iris FPS |
|------|---------------|---------------|----------------|
| Canvas2D | 20,000 | 60 | 60 |
| WebGL2 | 100,000 | 60 | 24 |
| WebGPU | 1,000,000 | 60 | n/a |

See `docs/perf-matrix.json` for detailed benchmark results and analysis. 