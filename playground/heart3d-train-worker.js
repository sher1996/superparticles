// Trains the orchestrator's brain in the background (evolution strategies) and reports every
// generation to the page, which shows the latest brain building the shape live.
//
// Messages in: "start" | "pause" | "reset" | { type: "shape", spec } | { type: "load", weights }

import { createWorld } from "./heart3d-sim.js";
import { createES, evaluate } from "./heart3d-es.js";

let world = createWorld({ smart: 300 });
let es = null, running = false, run = 0; // run: only the newest loop keeps going

function ensure() {
  if (!es) es = createES(world);
}

/** The bar to beat on the current shape, and how the current brain does there before more training. */
function baseline() {
  postMessage({
    type: "baseline",
    shape: world.shape.name,
    planner: evaluate(world, { mode: "planner" }),
    current: evaluate(world, { mode: "learned", brain: es.weights }),
    gen: es.gen,
    weights: es.weights.slice(),
  });
}

function start() {
  if (!es) { ensure(); baseline(); }
  running = true;
  loop(++run);
}

function loop(id) {
  if (!running || id !== run) return;
  const r = es.step();
  const test = evaluate(world, { mode: "learned", brain: es.weights });
  postMessage({ type: "generation", ...r, test, weights: es.weights.slice() });
  setTimeout(() => loop(id), 0); // let pause/reset messages in between generations
}

onmessage = (e) => {
  const m = e.data;
  if (m === "start") start();
  if (m === "pause") running = false;
  if (m === "reset") {
    running = false;
    es = createES(world);
    baseline();
    start();
  }
  if (m?.type === "shape") {
    world = createWorld({ smart: 300, shape: m.spec });
    ensure();
    es.setWorld(world); // the brain keeps what it learned; only the target changes
    baseline();
  }
  if (m?.type === "load") {
    ensure();
    es.setWeights(m.weights);
    baseline();
  }
};
