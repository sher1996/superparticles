# Status

_Last updated: 24 October 2026 (branch `smart-particles`, PR #2)._

This file separates what has been **verified** (by a test in this repo, or by a measurement recorded here) from what is **not yet verified**. Update it at the end of every chapter.

## Verified

### Engine (chapters 0–5 + groundwork)
| Claim | Evidence |
|---|---|
| Canvas2D, WebGL2 draw visible particles; controls change the picture | `test/browser.test.mjs` (screenshots analysed per test) |
| WebGPU falls back cleanly when unusable | browser test + device probe; real WebGPU drawing still to be checked on hardware (see below) |
| Several engines on one page are independent | browser test "two engines on one page" |
| Exact replay: same seed + same plugin toggles at the same step → same state hash, independent of frame batching | unit test "replay"; browser test across 3 canvas sizes × Canvas2D/WebGL2 with `world` |
| Reduced motion starts paused and still draws a frame | browser test |
| Plugins can't be registered twice; switching renderers doesn't stack forces | unit + browser tests |
| Core + Canvas2D + bundled plugins ≤ 15 KB gzipped | `npm run build` gate (currently ~5.5 KB) |

### Smart Particles (chapter 6)
| Claim | Evidence |
|---|---|
| Hashed update mask identical in Python and JS | bit-for-bit unit test |
| CPU reference = PyTorch | < 1e-4 over 8 steps (`test/nca.test.mjs`) |
| WebGPU compute = PyTorch | 4.8e-7 (Dawn + SwiftShader, `npm run test:webgpu`, runs in CI) |
| WebGPU = CPU reference including damage | 1.8e-7 over 60 steps |
| WebGL2 and CPU backends = PyTorch in Chromium | < 1e-4 (browser test) |
| Demo page grows a pattern, takes damage, resets | browser test |
| Model file loads with shape/version checks; float16 decoding | unit tests |

### Beyond chapter 6
| Claim | Evidence |
|---|---|
| 3D voxel reference = PyTorch | < 1e-4 over 6 steps (unit test) |
| TF.js in-browser trainer computes the same model as PyTorch | < 1e-4 (browser test), loss falls in a 60-step run, export loads in the runtime |
| Training page: upload → train → stop → open in Smart Particles | browser test |
| One-script embed starts both kinds of canvas from data attributes | browser test |
| Video recording produces a WebM/MP4 download | browser test |
| Learned swarm (moving particles) JS runtime = PyTorch | position and state < 1e-4 over 12 steps |
| Swarm demo assembles, scatters on click, resets | browser test |

## Training results

| Model | Status | Metrics |
|---|---|---|
| `models/heart.nca.json` (2D, 64×64) | trained: 6,000 steps (3,000 + 2,000 on 64–96-step runs, then 1,000 on 96–160-step runs), about 4.9 h of compute on 4 CPU cores, 23 KB | growth IoU **0.87** (gate 0.85 ✓), at alpha > 0.5 0.95; after 1,000 steps **0.88**; recovery IoU **0.86** (gate 0.80 ✓), with 15 of 16 holes ≥ 0.80, worst 0.79, 98% of intact; NaN-free ✓. **Passes all gates.** Earlier checkpoints scored 0.77/0.73 (3,000) and 0.82/0.79 (5,000). |
| `models/planet3d.nca.json` (3D, 16³) | trained: 1,500 steps on 32–48-step runs, then 200 more on 64–128-step runs (stopped early: it already passed), 22 KB | growth IoU **0.98** (gate 0.85 ✓), at alpha > 0.5 0.99; after 600 steps **0.95** (stable; the 1,500-step model had overgrown to 0.37); recovery IoU **0.96** (gate 0.80 ✓), worst 0.94, 98% of intact; front half cut away 0.81; NaN-free ✓. **Passes all gates.** |
| `models/swarm-heart.swarm.json` (moving particles, 256) | research prototype, 6 training runs, best checkpoint at step 200, 18 KB | coverage of the target after 150 steps from a blob **0.50**; after 600 steps 0.36; after pushing a third of the swarm apart it regains **100%** of its intact coverage; NaN-free ✓. It forms a stable structured cloud and re-forms it, but **does not yet draw a recognisable heart**, colours are not learned, the shape slowly drifts, and training is unstable (coverage swings between 0.02 and 0.50 across checkpoints). |

The gates from the research plan are growth IoU ≥ 0.85, recovery IoU ≥ 0.80 and NaN-free 1,000-step rollouts. **Both grid models (heart 2D, planet 3D) now pass all of them.** They are measured by `training/evaluate.py` with the same hashed mask the browser uses.

## Not yet verified

- **Real-GPU performance.** No benchmark has been recorded on physical hardware yet. Run `playground/bench.html` and commit the JSON under `benchmarks/`. Earlier claims (1M particles at 60 FPS, comparisons with tsParticles) were never measured and have been removed.
- **WebGPU drawing on a real browser and GPU.** WebGPU *compute* is verified headless, but the sandbox's Chromium can't present WebGPU frames. Check `smart.html?backend=webgpu` and the particle playground's WebGPU button on Chrome or Edge.
- **Firefox and Safari.** Tests run in Chromium only.
- **Mobile.** Not tested.
- **npm publication.** `superparticles` is **not on npm** (checked 24 October 2026). The release workflow is ready but needs an `NPM_TOKEN` repository secret.
- **Creator demand.** Nobody outside this project has tried it yet (roadmap chapter 11).

## How to reproduce

```bash
npm ci && npm run typecheck && npm run build
npm test                          # unit + parity tests
npx playwright install chromium   # once
npm run test:browser              # end-to-end
npm run test:webgpu               # WebGPU compute via Dawn
```
