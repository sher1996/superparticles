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
| Learned swarm (moving particles) JS runtime = PyTorch | position < 1e-4, state < 1e-5 relative, over 12 steps |

## Training results

| Model | Status | Metrics |
|---|---|---|
| `models/heart.nca.json` (2D, 64×64) | trained: 5,000 steps (3,000, then continued), about 3.4 h of compute on 4 CPU cores, 23 KB | growth IoU **0.82** (gate 0.85, **missed**), at alpha > 0.5 **0.93**; after 1,000 steps 0.79; recovery IoU **0.79** (gate 0.80, **missed** by 0.01), with 9 of 16 holes ≥ 0.80, worst 0.73, **96%** of its own undamaged shape; NaN-free ✓. The 3,000-step model scored 0.77 / 0.73. The remaining gap is the faint edge fringe and the unlearned highlight. |
| `models/planet3d.nca.json` (3D, 16³) | trained: 1,500 steps, 26 min of compute on 4 CPU cores, 22 KB | growth IoU **0.92** (gate 0.85, **passed**), at alpha > 0.5 0.97; recovery IoU **0.75** (gate 0.80, **missed**) = 81% of its intact shape; front-half cut 0.66; NaN-free ✓. **Not stable long-term:** the IoU falls to 0.37 by step 600 because it keeps growing (989 voxels vs 412), since it only ever trained on 32–48-step runs. Continued training with 64–128-step runs is queued. |
| `models/swarm-heart.swarm.json` (moving particles) | queued after the 3D run | _pending_ |

The gates from the research plan are growth IoU ≥ 0.85, recovery IoU ≥ 0.80 and NaN-free 1,000-step rollouts. They are measured by `training/evaluate.py` with the same hashed mask the browser uses.

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
