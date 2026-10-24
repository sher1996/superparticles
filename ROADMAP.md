# Roadmap

**Vision.** A lightweight visual-computing engine in which many small units, each with local state, sensing and a shared learned rule, collectively grow, reshape and repair 2D and 3D structures. It starts as a tiny web embed and grows into a creator-friendly workspace and, later, a desktop studio.

**Principles.**
- Optional complexity: the core embed stays small. GPU, AI, 3D and editor features load only when used.
- Honest measurement: benchmarks state the device, browser, scene and method.
- Reproducibility: seeded replay is exact on a given backend and checked with tolerances across backends. Bitwise equality is claimed only where a test shows it.
- Build for real users: the smart-particle idea is tested in demos and creator workflows, not assumed.

Status key: **done** (in `main` or the open PR, with tests), **next**, **planned**. `STATUS.md` has the detail and evidence for each item.

| # | Chapter | Outcome | Status |
|---|---|---|---|
| 0 | Bootstrap | TypeScript/ESM repo, esbuild, demo | done |
| 1 | Atom core | Seeded particle simulation, fixed timestep, Canvas2D | done |
| 2 | WebGL2 | GPU drawing, lazy-loaded | done |
| 3 | WebGPU | GPU drawing with fallback. The original GPU-physics path was replaced by shared CPU physics (see the note below) | done |
| 4 | Plugins | Force and shader plugins, per-engine registry, typed SDK | done |
| 5 | Playground and alpha | Playground, presets, state API, real tests, CI | done |
| — | Groundwork | Per-engine isolation, exact replay, fixed world, reduced motion, hidden-tab pause, device loss | done |
| 6A | Learn to grow | PyTorch NCA trainer, reference model, reproducible run | done |
| 6B | Learn to recover | Damage training, recovery metrics | done (see `STATUS.md` for the gates) |
| 6C | Model format | Versioned file (float16, sha256), parity vectors, JS reference | done |
| 6D | GPU brain | WebGPU compute and WebGL2 backends, double-buffered, exact | done |
| 6E | Creator demo | `smart.html`: grow, damage, heal, hidden channels, recovery readout | done |
| 7 | 3D proof of concept | 16³ voxel NCA, viewer, PLY export | done (proof of concept) |
| 8 | Desktop studio alpha | Offline authoring GUI reusing the web engine | planned |
| 9 | Creator workflow | 9a train from your own image in the browser; 9b one-script embed, video recording, embed code | done (timeline editing: planned) |
| 10 | SDK hardening | Stable contracts, plugin trust boundaries, adapters (Three.js, React) | planned |
| 11 | Business validation | 10–15 creators try it; measure where it helps | planned (needs people) |
| 12 | 1.0 | Stable web and/or desktop release based on that evidence | planned |

**Note on Chapter 3.** The first WebGPU version ran particle physics in a compute shader, aiming at 1 million particles. It never worked correctly: the shader loaded from a broken path, the random seed was wrong, and plugins and particle count were ignored. It was replaced by shared CPU physics, so every renderer behaves the same. GPU compute came back where it matters for the vision: the Smart Particles WebGPU backend (6D) runs the neural update in compute shaders with double buffering. A GPU-physics mode for very large decorative scenes can return as an optional backend if benchmarks show a need.

## Next steps, in order

1. **Merge Chapter 6–7** and publish `0.2.0-alpha.1` (needs an `NPM_TOKEN` repository secret, then `git tag v0.2.0-alpha.1 && git push --tags`).
2. **Run `playground/bench.html`** on real hardware (your Windows machine, plus a laptop and a phone) and commit the JSON under `benchmarks/`.
3. **Smart particles that move** (see 4) and a **timeline** for scripted scenes (grow, then damage at step N, then morph), which pairs naturally with exact replay.
4. **Smart particles that move.** Today's cells sit on a grid. Research step: let the learned rule also output motion, so cells become free particles (point-cloud NCA). Prototype in PyTorch first.
5. **Conditional models:** one network that can grow several shapes, chosen by a goal signal (Level 4 in the research doc).
6. **Creator testing (Chapter 11):** show the heal demo to 10–15 web, 3D and creative-coding users, and record what they would actually use.
7. **Desktop studio (Chapter 8)** only once 3 and 6 show what creators need. Start as a wrapper around the web engine.
