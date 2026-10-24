# Chapter 6: Smart Particles (neural cellular automata)

This note records what was built for Chapter 6 (and the Chapter 7 3D proof of concept), why it was built that way, how it was verified, and what was measured. Anything not measured here is marked as a target, not a result.

## 1. The model in plain terms

"Every particle has its own mind" is implemented as a **neural cellular automaton (NCA)**:

- **State**: each cell holds 16 numbers. Four are visible (red, green, blue, opacity) and 12 are hidden, which the cells use to signal to each other.
- **Perception**: every step, a cell reads its 3×3 neighbourhood through three fixed filters per channel: its own value plus horizontal and vertical edge detectors (Sobel). That gives 48 inputs (64 in 3D, with a depth filter).
- **Shared rule**: one small network (48 → 128 → 16, 8,320 weights) turns those inputs into a change to the cell's own state. Every cell runs the same weights. Individuality comes only from each cell's state and its neighbours.
- **Stochastic, local updates**: each step a random half of the cells update, so cells can't rely on global synchronisation. A cell counts as alive only if it, or a neighbour, has opacity above 0.1. Everything else is reset to zero, so the pattern must grow outward from the seed.

No cell knows the target. The shape comes from all cells applying the same learned rule, which is what makes the regrowth after damage meaningful.

This follows *Growing Neural Cellular Automata* (Mordvintsev, Randazzo, Niklasson, Levin; Distill, 2020), which showed that one shared local rule can learn to grow a 2D image from a seed and regrow it after damage. The architecture and training recipe deliberately match that paper, so results are comparable.

## 2. Training recipe

| Choice | Value | Why |
|---|---|---|
| Grid | 64×64, target 40×40 with 12-cell padding | room to grow and to be damaged without hitting the border |
| Target | procedurally drawn heart with a highlight | reproducible (no image assets); the highlight forces internal structure, not just a blob |
| Rollout | 64–96 steps per training step | long enough to grow, random so the result doesn't depend on one exact step count |
| Pool | 1,024 states sampled and written back | teaches the model to *hold* the shape over long horizons, not just reach it once |
| Reseed | the worst sample in each batch is reset to the seed | keeps growth from scratch learnable |
| Damage | 3 of 8 samples per batch get a random circular hole (radius 10–40% of the grid) | teaches regeneration |
| Optimiser | Adam, learning rate 2e-3 with warmup and cosine decay, per-parameter gradient normalisation | stable training through long rollouts (as in Distill) |
| Steps | 3,000 | fits about 2 hours on 4 CPU cores |

**One bug found and fixed along the way.** Clamping colours to [0, 1] inside the loss produced zero gradients in this PyTorch version: newborn cells start at exactly 0, and the clamp's gradient is 0 at the boundary. The loss now uses the unclamped values, as in the original paper. Clamping applies only for display and metrics.

## 3. Making it reproducible everywhere

Training samples the update mask with `torch.rand`. At runtime, every implementation instead uses an **integer hash** of (x, y, step, seed): a murmur3-style finaliser, where a cell fires if the top 24 bits are below fireRate·2²⁴. The same formula is written in Python, JavaScript, GLSL and WGSL. As a result:

- the same seed plus the same actions at the same steps gives the same pattern, on every backend;
- `evaluate.py` measures exactly what the browser does with that seed.

What is guaranteed, and how it is tested:

| Claim | Evidence |
|---|---|
| Hash mask identical across Python and JS | bit-for-bit test over a 24×24 grid (`test/nca.test.mjs`) |
| CPU reference = PyTorch | 8 steps from a grown state, max abs error < 1e-4 |
| WebGPU compute = PyTorch | max abs error 4.8e-7 (Dawn + SwiftShader, `test/nca-webgpu.test.mjs`) |
| WebGPU = CPU reference with damage | 60 steps including a hole: max abs error 1.8e-7 |
| WebGL2 = PyTorch (in Chromium) | max abs error < 1e-4 (`test/browser.test.mjs`) |
| 3D CPU reference = PyTorch | 6 steps, max abs error < 1e-4 |

These are tolerance results, not bitwise claims. GPU floating-point operations may round differently (the WGSL spec allows this), so long runs on different backends can drift slightly. Exact replay is guaranteed on one backend. Across backends, "same" means within the tolerances above.

**The subtle case.** PyTorch updates every cell, including dead ones next to living cells. A dead neighbour's new opacity decides whether a living cell survives the "alive after update" check. The CPU reference skips cells far from any life for speed, but it must still update this one-cell halo. Missing that would have broken parity.

## 4. Runtime architecture

`superparticles/nca` is a separate entry point. The core engine never loads it, so the core stays at about 5 KB gzipped. The Smart Particles code (3.9 KB gzipped) plus one backend chunk (about 3.5 KB) and the model (23 KB, float16) load only when used.

| Backend | How one step runs | Notes |
|---|---|---|
| WebGPU | 2 compute passes over storage buffers: update (all cells), then the alive mask; ping-pong between buffers | weights in one storage buffer; a whole batch of steps goes in one submit |
| WebGL2 | 2 fragment passes into 4 RGBA32F textures (16 channels), multiple render targets, ping-pong | weights in std140 uniform buffers; needs `EXT_color_buffer_float` |
| CPU | the reference implementation, drawn with Canvas2D | slow but runs everywhere; it defines correctness |

Double buffering matters: each cell must read the previous generation. Updating in place would make the result depend on thread order.

## 5. Results

**Heart, 64×64, 3,000 steps** (about 1.9 h of compute on 4 CPU cores; seed 0; `training/evaluate.py`, hashed mask seed 7):

| Metric | Value | Gate |
|---|---|---|
| Growth IoU after 200 steps (alpha > 0.1) | 0.766 | ≥ 0.85, missed |
| Growth IoU at alpha > 0.5 (diagnostic) | 0.929 | — |
| IoU after 1,000 steps (persistence) | 0.729 | — |
| Recovery IoU, 128 steps after one of 16 random holes | 0.731 (worst 0.685) | ≥ 0.80, missed |
| Recovery relative to its own undamaged shape (diagnostic) | 95.4% | — |
| NaN/inf in any rollout | none | required ✓ |

**Reading these numbers honestly.** The model does what the chapter set out to show: a single seed grows into the heart, the shape stays stable for 1,000+ steps, and every tested hole regrows to about 95% of the undamaged shape. In the browser, a hole that removed 30% of the cells refilled completely within 150 steps. It misses the IoU gates for two reasons that are visible in `evaluation.png`: (1) a faint fringe of low-opacity cells just outside the edge counts as "alive" at the 0.1 threshold, and (2) the small pink highlight in the target is not reproduced. Both are known effects of a short training run (the original paper trains 8,000 steps on a GPU). The gates stay as they are; they were not relaxed to make this pass.

**Continued to 5,000 steps** (same recipe, a further 1.5 h): growth IoU 0.766 → **0.821**, persistence 0.729 → **0.791**, recovery 0.731 → **0.790** (worst 0.731), holes recovered to ≥ 0.80: 0/16 → **9/16**, and recovery relative to its intact shape 95.4% → **96.3%**. It is now just short of both gates. More training is the obvious next step: the loss was still falling, and the original paper used 8,000 steps. A small loss term that discourages low-alpha fringe cells is another option, still to be tested.

## 6. Moving smart particles (research prototype)

Grid NCAs only recolour cells that stay in place. To get closer to "particles that can form anything", `training/swarm.py` gives each particle a **position** and a 12-channel **state**:

- **Sensing**: neighbours within radius R = 0.22 (in a [-1, 1]² world), each weighted by (1 - d/R)². From those, a particle computes its own state, the weighted mean of neighbour states, the weighted mean of (offset/R)·state in x and y (where which state is, analogous to the Sobel filters on a grid), and the log local density. That gives 49 inputs.
- **Acting**: one shared network (49 → 96 → 14, 6,144 weights) outputs a state change and a velocity. The move per step is bounded by 0.03·tanh(v), so long rollouts stay stable.
- **Training**: start from a shapeless blob. The loss is the Chamfer distance to points sampled from the target, plus a colour term (each particle should match its nearest target point). Pool training as on the grid, with "throw a region's particles to random places" as the damage.
- **Runtime**: `SwarmCPU` (O(N²), fine for the 256 particles it is trained with) matches PyTorch to 1e-4 in position. `playground/swarm.html` lets you scatter particles by clicking.

What the prototype tests is whether one local rule can steer freely moving units into a shape and back after disruption. It does not yet handle collisions, particle birth and death, or 3D.

## 7. What this is, and what it isn't

- It **is** a working, reproducible instance of learned local behaviour: growth, persistence and repair of one specific target, from one shared rule.
- It is **not** general "form anything" intelligence. A model grows the target it was trained on. Growing a new shape means training a new model (minutes to hours), or the conditional models planned in the roadmap.
- It is **not** consciousness. "Each particle has a mind" means each cell runs a small learned rule on its own private state.
- The grid models' cells don't move. The moving swarm (section 6) is an early prototype, not a finished feature.

## 8. Open questions for the next chapters

1. Smallest model that still heals visibly (fewer hidden units, or 8-bit weights) for an even lighter embed.
2. Training directly in the browser with WebGPU, so creators can teach their own image without Python.
3. Scaling the swarm beyond a few hundred particles: spatial hashing instead of O(N²) neighbour search, and a GPU implementation.
4. One model for several goals (conditional NCA), and what that costs in size and accuracy.
5. A first 3D export format beyond PLY point clouds, such as a glTF animation or a VDB volume sequence.

## References

1. A. Mordvintsev, E. Randazzo, E. Niklasson, M. Levin. *Growing Neural Cellular Automata.* Distill, 2020. <https://distill.pub/2020/growing-ca/>
2. *Neural cellular automata: Applications to biology and beyond classical AI.* Physics of Life Reviews, 2026. <https://www.sciencedirect.com/science/article/pii/S1571064525001757>
3. W3C, *WebGPU Shading Language* (precision and rounding rules). <https://www.w3.org/TR/WGSL/>
4. MDN, *HTMLCanvasElement.getContext()* (one context type per canvas). <https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/getContext>
