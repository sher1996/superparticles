// Live training view: a worker trains the orchestrator's brain; here the newest brain builds the
// shape over and over, exactly like a training episode, while the charts show the progress.
// The best brain is kept in localStorage and can be downloaded and loaded again.

import { createWorld, Swarm, brainCall, EPISODE_STEPS, EPISODE_DAMAGE } from "./heart3d-sim.js";
import { SHAPES, imageToMask } from "./heart3d-shapes.js";
import { brainFile, parseBrainFile } from "./heart3d-es.js";
import { createView, hexToRgb } from "./heart3d-view.js";

const $ = (id) => document.getElementById(id);
const SAVE_KEY = "sp_orchestrator_brain";
const view = createView($("view"));
let world = createWorld({ smart: 300 }); // the same world the worker trains in
let swarm = new Swarm(world, { mode: "learned", followers: 6000 });
const worker = new Worker(new URL("./heart3d-train-worker.js", import.meta.url), { type: "module" });

const history = [];  // { gen, mean, test }
const segments = []; // { gen, shape, planner }: where the shape changed, and the bar to beat there
let planner = null, latest = null, latestGen = 0, shownGen = -1, freshRun = false;
let best = null; // { score, gen, shape, weights } on the current shape
let training = false, showSmart = false;

// ---- talking to the trainer -------------------------------------------------------------------

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "baseline") {
    if (freshRun) { history.length = 0; segments.length = 0; freshRun = false; }
    planner = m.planner;
    latest = m.weights; latestGen = m.gen;
    segments.push({ gen: m.gen, shape: m.shape, planner: m.planner });
    while (history.length && history[history.length - 1].gen >= m.gen) history.pop();
    history.push({ gen: m.gen, mean: m.current, test: m.current });
    best = { score: m.current, gen: m.gen, shape: m.shape, weights: m.weights };
    $("planner").textContent = planner.toFixed(3);
    $("score").textContent = m.current.toFixed(3);
    $("download").disabled = false;
    restartEpisode();
  } else {
    latest = m.weights; latestGen = m.gen;
    history.push({ gen: m.gen, mean: m.mean, test: m.test });
    $("gen").textContent = m.gen;
    $("score").textContent = `${m.test.toFixed(3)}${m.test > planner ? "  (beats hand-written)" : ""}`;
    if (m.test > best.score) {
      best = { score: m.test, gen: m.gen, shape: best.shape, weights: m.weights };
      save();
    }
  }
  drawChart();
  drawRule();
};

function save() {
  const doc = brainFile(best.weights, { trainedOn: best.shape, generation: best.gen, score: +best.score.toFixed(4), handWritten: +planner.toFixed(4), savedAt: new Date().toISOString() });
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(doc)); } catch {}
  $("saved").textContent = `Saved in this browser: best brain on the ${best.shape}, generation ${best.gen}, score ${best.score.toFixed(3)} (hand-written ${planner.toFixed(3)}).`;
}

function setTraining(on) {
  training = on;
  $("train").textContent = training ? "Pause training" : "Start training";
}

$("train").onclick = () => {
  setTraining(!training);
  worker.postMessage(training ? "start" : "pause");
};
$("restart").onclick = () => {
  freshRun = true;
  worker.postMessage("reset");
  setTraining(true);
};

// ---- shapes -------------------------------------------------------------------------------------

for (const [kind, label] of Object.entries(SHAPES)) $("shape").append(new Option(label, kind));

function useShape(spec) {
  world = createWorld({ smart: 300, shape: spec });
  const followers = swarm.followers;
  swarm = new Swarm(world, { mode: "learned", followers });
  worker.postMessage({ type: "shape", spec }); // the worker answers with a fresh baseline
  if (latest) restartEpisode();
}
$("shape").onchange = (e) => useShape({ kind: e.target.value });
$("upload").onclick = () => $("image").click();
$("image").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const img = await createImageBitmap(file);
  const { mask, w, h } = imageToMask(img);
  if (mask.reduce((a, b) => a + b, 0) < 30) {
    alert("Couldn't find a clear shape in that image. Try a bold silhouette on a plain or transparent background.");
    return;
  }
  const name = file.name.replace(/\.[^.]+$/, "");
  if (![...$("shape").options].some((o) => o.value === "image")) $("shape").append(new Option("Your image", "image"));
  $("shape").value = "image";
  useShape({ kind: "image", mask, w, h, name });
};

// ---- saving and loading brains --------------------------------------------------------------------

$("download").onclick = () => {
  if (!best) return;
  const doc = brainFile(best.weights, { trainedOn: best.shape, generation: best.gen, score: +best.score.toFixed(4), handWritten: +planner.toFixed(4) });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 1)], { type: "application/json" }));
  a.download = `orchestrator-${best.shape.replace(/\W+/g, "-")}-gen${best.gen}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
function loadBrain(doc) {
  const weights = parseBrainFile(doc);
  worker.postMessage({ type: "load", weights });
}
$("load").onclick = () => $("brain-file").click();
$("brain-file").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try { loadBrain(JSON.parse(await file.text())); } catch (err) { alert(err.message); }
};
$("continue").onclick = () => {
  try { loadBrain(JSON.parse(localStorage.getItem(SAVE_KEY))); } catch (err) { alert(err.message); }
};
try {
  const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
  if (saved) {
    $("saved").textContent = `Saved in this browser: best brain on the ${saved.trainedOn}, generation ${saved.generation}, score ${saved.score} (hand-written ${saved.handWritten}).`;
    $("continue").hidden = false;
  }
} catch {}

// ---- the live episode: build from a blob, knock a patch off halfway, repair ----------------

let step = 0, t = 0, tick = 0;
function restartEpisode() {
  swarm.brain = latest;
  shownGen = latestGen;
  swarm.blob();
  step = 0;
  $("shown").textContent = `brain from generation ${shownGen}`;
}

function frame() {
  if (latest) {
    for (let k = 0; k < 2; k++) { // real time at 60 frames per second, like a training episode
      if (step % 10 === 0) swarm.orchestrate();
      if (step === EPISODE_DAMAGE) {
        const i = Math.floor(Math.random() * world.smart);
        swarm.scatter(swarm.pos[3 * i], swarm.pos[3 * i + 1], swarm.pos[3 * i + 2], 0.6, 3);
      }
      swarm.stepSmart(1 / 120);
      step++;
    }
    t += 1 / 60;
    swarm.stepFollowers(1 / 60, t);
    if (step >= EPISODE_STEPS) restartEpisode(); // next round with the newest brain
    $("phase").textContent = step < EPISODE_DAMAGE
      ? `Generation ${shownGen}: building the ${world.shape.name} from a blob`
      : `Generation ${shownGen}: a patch was knocked off, repairing`;
    if (tick++ % 20 === 0) {
      swarm.measure();
      $("cover").textContent = `${(swarm.stats.coverage * 100).toFixed(1)}%`;
    }
  }
  const layers = [{ points: swarm.fPos, count: swarm.followers }];
  if (showSmart) layers.push({ points: swarm.pos, count: world.smart, size: view.size * 2.2, color: [1, 1, 1] });
  view.draw(layers);
  requestAnimationFrame(frame);
}

// ---- charts ----------------------------------------------------------------------------------

function drawChart() {
  const c = $("chart"), g = c.getContext("2d"), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  if (!history.length) return;
  const lo = 0.6, hi = 1.0, last = history[history.length - 1].gen, n = Math.max(10, last);
  const X = (gen) => 40 + (gen / n) * (W - 50), Y = (v) => H - 20 - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (H - 30);
  g.font = "18px system-ui";
  g.fillStyle = "#64748b";
  for (const v of [0.6, 0.7, 0.8, 0.9, 1.0]) { g.fillText(v.toFixed(1), 2, Y(v) + 6); g.fillRect(40, Y(v), W - 50, 1); }
  g.fillText(`generation ${last}`, W - 170, H - 2);
  // the hand-written bar, per shape, and where the shape changed
  segments.forEach((s, i) => {
    const x0 = X(s.gen), x1 = i + 1 < segments.length ? X(segments[i + 1].gen) : W - 10;
    g.strokeStyle = "#f87171"; g.setLineDash([8, 6]); g.lineWidth = 2;
    g.beginPath(); g.moveTo(x0, Y(s.planner)); g.lineTo(x1, Y(s.planner)); g.stroke(); g.setLineDash([]);
    if (i > 0 || segments.length > 1) {
      g.fillStyle = "#94a3b8"; g.fillRect(x0, 4, 1, H - 24); g.fillText(s.shape, x0 + 4, 20);
    }
  });
  const line = (key, color, width) => {
    g.strokeStyle = color; g.lineWidth = width; g.beginPath();
    history.forEach((h, i) => (i ? g.lineTo(X(h.gen), Y(h[key])) : g.moveTo(X(h.gen), Y(h[key]))));
    g.stroke();
  };
  line("mean", "#334155", 3);
  line("test", "#60a5fa", 4);
}

function drawRule() {
  if (!latest) return;
  const c = $("rule"), g = c.getContext("2d"), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const curves = [[0, "#fbbf24"], [1, "#a3e635"], [2, "#c084fc"]].map(([around, col]) => {
    const ys = [];
    for (let k = 0; k <= 60; k++) ys.push(brainCall(latest, (k / 60) * 2, around, 0));
    return [ys, col];
  });
  const all = curves.flatMap(([ys]) => ys);
  const lo = Math.min(...all), hi = Math.max(...all, lo + 1e-3);
  const X = (k) => 30 + (k / 60) * (W - 40), Y = (v) => H - 24 - ((v - lo) / (hi - lo)) * (H - 40);
  g.fillStyle = "#64748b"; g.font = "18px system-ui";
  g.fillRect(X(30), 8, 1, H - 32); // fullness 1 = exactly its share
  g.fillText("empty", 30, H - 2); g.fillText("its share", X(30) - 34, H - 2); g.fillText("2×", W - 30, H - 2);
  for (const [ys, col] of curves) {
    g.strokeStyle = col; g.lineWidth = 3; g.beginPath();
    ys.forEach((v, k) => (k ? g.lineTo(X(k), Y(v)) : g.moveTo(X(k), Y(v))));
    g.stroke();
  }
}

// ---- controls ---------------------------------------------------------------------------------

$("followers").oninput = (e) => { $("followers-value").textContent = e.target.value; swarm.setFollowers(Number(e.target.value)); };
$("size").oninput = (e) => { $("size-value").textContent = e.target.value; view.size = Number(e.target.value); };
$("color").oninput = (e) => { view.color = hexToRgb(e.target.value); };
$("show-smart").onchange = (e) => { showSmart = e.target.checked; };
$("rotate").onchange = (e) => { view.autoRotate = e.target.checked; };

window.heartTrain = { history, segments, get swarm() { return swarm; }, get planner() { return planner; }, get best() { return best; }, useShape };
requestAnimationFrame(frame);
