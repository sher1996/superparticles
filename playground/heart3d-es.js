// Evolution strategies for the orchestrator's brain. No gradients: try small random changes to
// the weights (in ± pairs), run an episode with each, and move the weights toward the changes that
// built and repaired the heart better. Shared by the training worker and tests.

import { BRAIN_HIDDEN, BRAIN_IN, BRAIN_PARAMS, episode, mulberry } from "./heart3d-sim.js";

export function createES(world, { pairs = 10, sigma = 0.15, lr = 0.08, seed = 1 } = {}) {
  const rand = mulberry(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
  // generation 0: a random (untrained) brain
  const w = Float32Array.from({ length: BRAIN_PARAMS }, () => gauss() * 0.3);
  const m = new Float32Array(BRAIN_PARAMS), v = new Float32Array(BRAIN_PARAMS);
  let gen = 0;

  /** One generation. Returns the score of the current brain (before the update) and the spread. */
  function step() {
    const epSeed = 1000 + gen; // every member sees the same scene this generation (fair comparison)
    const eps = [], scores = [];
    for (let p = 0; p < pairs; p++) {
      const e = Float32Array.from({ length: BRAIN_PARAMS }, gauss);
      eps.push(e);
      for (const sign of [1, -1]) {
        const trial = w.map((x, i) => x + sign * sigma * e[i]);
        scores.push(episode(world, { mode: "learned", brain: trial, seed: epSeed }));
      }
    }
    // rank-based weights in [-0.5, 0.5]: robust to the score's scale
    const order = [...scores.keys()].sort((a, b) => scores[a] - scores[b]);
    const rank = new Float32Array(scores.length);
    order.forEach((k, r) => { rank[k] = r / (scores.length - 1) - 0.5; });
    const grad = new Float32Array(BRAIN_PARAMS);
    for (let p = 0; p < pairs; p++) {
      const a = rank[2 * p] - rank[2 * p + 1];
      for (let i = 0; i < BRAIN_PARAMS; i++) grad[i] += (a * eps[p][i]) / (pairs * sigma);
    }
    // Adam step (ascent)
    gen++;
    for (let i = 0; i < BRAIN_PARAMS; i++) {
      m[i] = 0.9 * m[i] + 0.1 * grad[i];
      v[i] = 0.999 * v[i] + 0.001 * grad[i] * grad[i];
      const mh = m[i] / (1 - 0.9 ** gen), vh = v[i] / (1 - 0.999 ** gen);
      w[i] += (lr * mh) / (Math.sqrt(vh) + 1e-8);
    }
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    return { gen, mean, best: Math.max(...scores), worst: Math.min(...scores) };
  }

  return {
    step,
    weights: w,
    get gen() { return gen; },
    /** Train on another shape from here on (the brain keeps what it learned). */
    setWorld(next) { world = next; },
    /** Continue from saved weights. */
    setWeights(next) { w.set(next); m.fill(0); v.fill(0); },
  };
}

/** A brain as a small JSON file, to save, download and load again. */
export function brainFile(weights, info = {}) {
  return { format: "superparticles-orchestrator", version: 1, inputs: BRAIN_IN, hidden: BRAIN_HIDDEN, weights: Array.from(weights), ...info };
}

export function parseBrainFile(doc) {
  if (doc?.format !== "superparticles-orchestrator" || !Array.isArray(doc.weights) || doc.weights.length !== BRAIN_PARAMS) {
    throw new Error("Not a saved orchestrator brain");
  }
  return Float32Array.from(doc.weights);
}

/** Score a brain (or the planner) on fixed test scenes, the same every time. */
export function evaluate(world, { mode, brain }, seeds = [1, 2]) {
  return seeds.reduce((a, s) => a + episode(world, { mode, brain, seed: s }), 0) / seeds.length;
}
