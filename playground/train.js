import * as tf from "@tensorflow/tfjs-core"; // the full TF.js bundle, see the import map
import { createTrainer, imageToTarget } from "./nca-train.js";

const $ = (id) => document.getElementById(id);
const pad = $("pad");
const pg = pad.getContext("2d");

let SIZE = 32, PAD = 5;
let target = null, trainer = null, running = false, paused = false, model = null;
const losses = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const detail = () => {
  const size = Number($("detail").value);
  return { size, pad: size === 32 ? 5 : 8, rollout: size === 32 ? [32, 48] : [48, 64] };
};

// ---- drawing pad -------------------------------------------------------------

const COLOURS = ["#e8284e", "#ff8a1f", "#ffd23f", "#2ecc71", "#22b3e6", "#4f6bff", "#a855f7", "#ffffff", "#1f2937"];
let colour = COLOURS[0], erasing = false, drawing = false, last = null;

for (const c of COLOURS) {
  const b = document.createElement("button");
  b.className = "swatch";
  b.style.background = c;
  b.setAttribute("aria-label", `Colour ${c}`);
  b.setAttribute("aria-pressed", String(c === colour));
  b.onclick = () => selectColour(c);
  $("swatches").append(b);
}
const picker = document.createElement("input");
picker.type = "color";
picker.value = colour;
picker.setAttribute("aria-label", "Custom colour");
picker.oninput = () => selectColour(picker.value);
$("swatches").append(picker);

function selectColour(c) {
  colour = c;
  erasing = false;
  $("eraser").setAttribute("aria-pressed", "false");
  document.querySelectorAll(".swatch").forEach((b) => b.setAttribute("aria-pressed", String(b.style.background && rgbToHex(b.style.background) === c)));
}
function rgbToHex(rgb) {
  const m = rgb.match(/\d+/g);
  return m ? "#" + m.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, "0")).join("") : rgb;
}

$("eraser").onclick = () => {
  erasing = !erasing;
  $("eraser").setAttribute("aria-pressed", String(erasing));
};
$("clear").onclick = () => { pg.clearRect(0, 0, pad.width, pad.height); updateTarget(); };
// PNG with transparency: reusable as a target for the PyTorch trainer (training/train.py --target my.png)
$("save-drawing").onclick = () => {
  pad.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "my-shape.png";
    a.click();
    URL.revokeObjectURL(a.href);
  }, "image/png");
};

function padPoint(e) {
  const r = pad.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * pad.width, y: ((e.clientY - r.top) / r.height) * pad.height };
}
function stroke(a, b) {
  pg.save();
  pg.globalCompositeOperation = erasing ? "destination-out" : "source-over";
  pg.strokeStyle = colour;
  pg.lineWidth = Number($("brush").value);
  pg.lineCap = pg.lineJoin = "round";
  pg.beginPath();
  pg.moveTo(a.x, a.y);
  pg.lineTo(b.x, b.y);
  pg.stroke();
  pg.restore();
}
pad.addEventListener("pointerdown", (e) => {
  if (running) return;
  drawing = true;
  pad.setPointerCapture(e.pointerId);
  last = padPoint(e);
  stroke(last, last);
});
pad.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  const p = padPoint(e);
  stroke(last, p);
  last = p;
});
pad.addEventListener("pointerup", () => { if (drawing) { drawing = false; updateTarget(); } });

// Presets are drawn with ordinary canvas paths, so you can keep drawing on top
const PRESETS = {
  heart(g, s) {
    g.fillStyle = "#e8284e";
    g.beginPath();
    g.moveTo(s * 0.5, s * 0.85);
    g.bezierCurveTo(s * 0.1, s * 0.6, s * 0.05, s * 0.3, s * 0.28, s * 0.2);
    g.bezierCurveTo(s * 0.4, s * 0.15, s * 0.48, s * 0.25, s * 0.5, s * 0.32);
    g.bezierCurveTo(s * 0.52, s * 0.25, s * 0.6, s * 0.15, s * 0.72, s * 0.2);
    g.bezierCurveTo(s * 0.95, s * 0.3, s * 0.9, s * 0.6, s * 0.5, s * 0.85);
    g.fill();
  },
  star(g, s) {
    g.fillStyle = "#ffd23f";
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? s * 0.19 : s * 0.44, a = -Math.PI / 2 + (i * Math.PI) / 5;
      g.lineTo(s / 2 + Math.cos(a) * r, s * 0.53 + Math.sin(a) * r);
    }
    g.fill();
    g.fillStyle = "#ff8a1f";
    g.beginPath();
    g.arc(s / 2, s * 0.53, s * 0.1, 0, Math.PI * 2);
    g.fill();
  },
  smiley(g, s) {
    g.fillStyle = "#ffd23f";
    g.beginPath(); g.arc(s / 2, s / 2, s * 0.4, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#1f2937";
    g.beginPath(); g.arc(s * 0.36, s * 0.4, s * 0.06, 0, Math.PI * 2); g.arc(s * 0.64, s * 0.4, s * 0.06, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#1f2937"; g.lineWidth = s * 0.06; g.lineCap = "round";
    g.beginPath(); g.arc(s / 2, s * 0.52, s * 0.2, 0.25 * Math.PI, 0.75 * Math.PI); g.stroke();
  },
  leaf(g, s) {
    g.fillStyle = "#2ecc71";
    g.beginPath();
    g.moveTo(s * 0.2, s * 0.8);
    g.quadraticCurveTo(s * 0.15, s * 0.2, s * 0.8, s * 0.18);
    g.quadraticCurveTo(s * 0.82, s * 0.8, s * 0.2, s * 0.8);
    g.fill();
    g.strokeStyle = "#14833f"; g.lineWidth = s * 0.03;
    g.beginPath(); g.moveTo(s * 0.22, s * 0.78); g.lineTo(s * 0.72, s * 0.26); g.stroke();
  },
  bolt(g, s) {
    g.fillStyle = "#22b3e6";
    g.beginPath();
    [[0.58, 0.08], [0.24, 0.55], [0.47, 0.55], [0.38, 0.92], [0.76, 0.42], [0.53, 0.42], [0.66, 0.08]].forEach(([x, y]) => g.lineTo(x * s, y * s));
    g.fill();
  },
};
$("preset").onchange = (e) => {
  const fn = PRESETS[e.target.value];
  if (!fn || running) return;
  pg.clearRect(0, 0, pad.width, pad.height);
  fn(pg, pad.width);
  window.__lastImage = null;
  updateTarget();
  e.target.value = "";
};

$("file").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file || running) return;
  const img = await createImageBitmap(file);
  pg.clearRect(0, 0, pad.width, pad.height);
  const s = Math.min(pad.width / img.width, pad.height / img.height);
  pg.drawImage(img, (pad.width - img.width * s) / 2, (pad.height - img.height * s) / 2, img.width * s, img.height * s);
  updateTarget();
};

function updateTarget() {
  ({ size: SIZE, pad: PAD } = detail());
  target = imageToTarget(pad, SIZE, PAD, { removeBackground: $("nobg").checked });
  let alive = 0;
  for (let i = 0; i < SIZE * SIZE; i++) if (target[i * 4 + 3] > 0.1) alive++;
  $("target-view").width = $("target-view").height = SIZE;
  drawRGBA($("target-view"), target, 4);
  $("start").disabled = running || alive < 4;
  if (!running) {
    $("status").textContent = alive < 4 ? "Draw something (or pick a preset) to begin." : `Ready: ${alive} cells to grow. Press Start training.`;
  }
}
$("nobg").onchange = updateTarget;
$("detail").onchange = updateTarget;
$("steps").oninput = (e) => { $("steps-value").textContent = e.target.value; };

// ---- views -----------------------------------------------------------------------

function drawRGBA(canvas, data, stride, offset = 0) {
  // premultiplied RGBA (stride 4 = target, 16 = full cell state) over a dark background
  const g = canvas.getContext("2d");
  const img = g.createImageData(SIZE, SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const o = offset + i * stride;
    const a = Math.min(1, Math.max(0, data[o + 3]));
    for (let k = 0; k < 3; k++) img.data[i * 4 + k] = (Math.min(1, Math.max(0, data[o + k])) + (1 - a) * 0.03) * 255;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

function pixCanvas() {
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  c.className = "pix";
  return c;
}

const ROLE_TEXT = {
  seed: ["seed", "Fresh seed"],
  pool: ["pool", "From the pool"],
  damaged: ["damaged", "Damaged"],
};
let batchViews = [];
function buildBatch(n) {
  $("batch").replaceChildren();
  batchViews = [];
  for (let i = 0; i < n; i++) {
    const card = document.createElement("div");
    card.className = "sample";
    const badge = document.createElement("span");
    badge.className = "badge pool";
    const pair = document.createElement("div");
    pair.className = "pair";
    const before = pixCanvas(), after = pixCanvas();
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "→";
    pair.append(before, arrow, after);
    const cap = document.createElement("div");
    cap.className = "cap";
    cap.textContent = "before · after";
    card.append(badge, pair, cap);
    $("batch").append(card);
    batchViews.push({ badge, before, after, cap });
  }
}

const STRIP_STEPS = [0, 15, 30, 60, 100, 150];
let stripViews = [];
function buildStrip() {
  $("strip").replaceChildren();
  stripViews = STRIP_STEPS.map((k) => {
    const f = document.createElement("figure");
    f.style.margin = "0";
    const c = pixCanvas();
    const cap = document.createElement("figcaption");
    cap.className = "cap";
    cap.textContent = k === 0 ? "seed" : `${k} updates`;
    f.append(c, cap);
    $("strip").append(f);
    return c;
  });
  $("history").replaceChildren();
}

function drawLoss() {
  const c = $("loss"), g = c.getContext("2d");
  g.clearRect(0, 0, c.width, c.height);
  if (losses.length < 2) return;
  const logs = losses.map((l) => Math.log10(Math.max(l, 1e-6)));
  const lo = Math.min(...logs), hi = Math.max(...logs);
  const X = (i) => 40 + (i / Math.max(1, losses.length - 1)) * (c.width - 50);
  const Y = (v) => c.height - 24 - ((v - lo) / Math.max(1e-6, hi - lo)) * (c.height - 44);
  // axis labels
  g.fillStyle = "#93a0b8";
  g.font = "20px system-ui";
  g.fillText(Math.pow(10, hi).toFixed(3), 2, 22);
  g.fillText(Math.pow(10, lo).toFixed(3), 2, c.height - 28);
  g.fillText(`step ${losses.length}`, c.width - 120, c.height - 2);
  // damage marker
  if (losses.length > 100) {
    g.strokeStyle = "#f87171";
    g.setLineDash([6, 6]);
    g.beginPath(); g.moveTo(X(100), 10); g.lineTo(X(100), c.height - 24); g.stroke();
    g.setLineDash([]);
    g.fillStyle = "#f87171";
    g.fillText("damage on", X(100) + 6, 26);
  }
  // raw (faint) + smoothed
  g.strokeStyle = "rgba(96,165,250,0.3)";
  g.lineWidth = 2;
  g.beginPath();
  logs.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
  g.stroke();
  g.strokeStyle = "#60a5fa";
  g.lineWidth = 4;
  g.beginPath();
  let sm = logs[0];
  logs.forEach((v, i) => { sm = sm * 0.9 + v * 0.1; i ? g.lineTo(X(i), Y(sm)) : g.moveTo(X(i), Y(sm)); });
  g.stroke();
}

function drawError(after) {
  // per-cell squared error of the first sample, as a heat map
  const c = $("error-view");
  c.width = c.height = SIZE;
  const g = c.getContext("2d");
  const img = g.createImageData(SIZE, SIZE);
  let max = 1e-6;
  const err = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    let e = 0;
    for (let k = 0; k < 4; k++) e += (after[i * 16 + k] - target[i * 4 + k]) ** 2;
    err[i] = e;
    max = Math.max(max, e);
  }
  for (let i = 0; i < SIZE * SIZE; i++) {
    const t = Math.sqrt(err[i] / max);
    img.data[i * 4] = 255 * Math.min(1, t * 1.6);
    img.data[i * 4 + 1] = 255 * Math.max(0, t - 0.4) * 1.4;
    img.data[i * 4 + 2] = 40 + 120 * (1 - t) * (t > 0.02 ? 0 : 1);
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

function setPhase(name, text) {
  document.querySelectorAll(".phase").forEach((p) => p.classList.toggle("active", p.dataset.phase === name));
  if (text) $("explain").innerHTML = text;
}
const slow = () => $("slow").checked;
async function pace(ms) {
  if (slow()) await sleep(ms);
  while (paused && running) await sleep(100);
}

// ---- training --------------------------------------------------------------------

async function testGrowth(step) {
  const shots = await trainer.grow(STRIP_STEPS);
  shots.forEach((s, i) => drawRGBA(stripViews[i], s.rgba, 4));
  const f = document.createElement("figure");
  const c = pixCanvas();
  drawRGBA(c, shots[STRIP_STEPS.indexOf(100)].rgba, 4);
  const cap = document.createElement("figcaption");
  cap.className = "cap";
  cap.textContent = `step ${step}`;
  f.append(c, cap);
  $("history").append(f);
  $("history").scrollLeft = $("history").scrollWidth;
}

$("start").onclick = async () => {
  if (!target) return;
  trainer?.dispose();
  losses.length = 0;
  const total = Number($("steps").value);
  const d = detail();
  trainer = createTrainer(tf, target, { size: SIZE, steps: total, rollout: d.rollout });
  buildBatch(trainer.batch);
  buildStrip();
  running = true;
  paused = false;
  for (const id of ["start", "detail", "preset", "file", "clear"]) $(id).disabled = true;
  $("pause").disabled = $("stop").disabled = false;
  $("learn").scrollIntoView({ behavior: "smooth", block: "start" });
  await testGrowth(0);
  const t0 = performance.now();

  while (running && trainer.step < total) {
    const stepNo = trainer.step + 1;
    const damaging = stepNo > 100;
    setPhase("sample", `<strong>Step ${stepNo}.</strong> Picking ${trainer.batch} examples from the pool of 256 earlier attempts.`);
    await pace(500);
    setPhase("prepare", damaging
      ? "The worst example is replaced by a fresh seed, and a hole is cut in the best one, so the rule must learn to <strong>grow</strong>, <strong>keep</strong> and <strong>heal</strong>."
      : "The worst example is replaced by a fresh seed. Damage starts at step 100, once the cells can grow something.");
    await pace(500);
    setPhase("run", `All ${SIZE * SIZE} cells run the same rule, updating ${d.rollout[0]}–${d.rollout[1]} times. Each only sees its neighbours.`);

    const r = await trainer.trainStep({ inspect: true });
    losses.push(r.loss);

    // show the batch: before -> after, with roles
    const before = await r.inputs.data();
    const after = await r.preview.data();
    const plane = SIZE * SIZE * 16;
    batchViews.forEach((v, i) => {
      const [cls, text] = ROLE_TEXT[r.roles[i]];
      v.badge.className = `badge ${cls}`;
      v.badge.textContent = text;
      drawRGBA(v.before, before, 16, i * plane);
      drawRGBA(v.after, after, 16, i * plane);
      v.cap.textContent = `before · after ${r.iters} updates`;
    });
    r.inputs.dispose();
    r.preview.dispose();

    setPhase("compare", `Compared with your drawing: loss <strong>${r.loss.toFixed(4)}</strong>. The error map shows where the first example is still wrong.`);
    drawError(after);
    drawLoss();
    await pace(600);
    setPhase("learn", "The 8,320 weights were nudged so this step's results would have been closer to your drawing.");
    await pace(500);
    setPhase("store", "Results go back into the pool. The next step continues from them, which is how the rule learns to hold a finished shape.");

    $("s-step").textContent = `${r.step} / ${total}`;
    $("s-loss").textContent = r.loss.toFixed(4);
    $("s-iters").textContent = r.iters;
    $("s-lr").textContent = r.lr.toExponential(1);
    const per = (performance.now() - t0) / r.step;
    const left = Math.round(((total - r.step) * per) / 1000);
    $("status").textContent = `Step ${r.step} of ${total} · about ${Math.floor(left / 60)}m ${left % 60}s left`;

    if (r.step % 25 === 0) await testGrowth(r.step);
    if (r.step % 50 === 0) await saveModel();
    await pace(300);
  }
  await finish();
};

async function saveModel() {
  model = await trainer.toModelFile("custom");
  $("open").disabled = $("download").disabled = false;
}

async function finish() {
  await saveModel();
  await testGrowth(trainer.step);
  running = false;
  paused = false;
  for (const id of ["start", "detail", "preset", "file", "clear"]) $(id).disabled = false;
  $("pause").disabled = $("stop").disabled = true;
  $("pause").textContent = "Pause";
  setPhase(null, `<strong>Done after ${trainer.step} steps.</strong> Open it in Smart Particles and cut holes with the mouse to test the healing. More steps give sharper shapes and better repair.`);
  $("status").textContent = `Done after ${trainer.step} steps.`;
}

$("pause").onclick = () => {
  paused = !paused;
  $("pause").textContent = paused ? "Resume" : "Pause";
  if (paused) $("status").textContent += " · paused";
};
$("stop").onclick = () => { running = false; paused = false; };
$("open").onclick = () => {
  localStorage.setItem("sp_custom_model", JSON.stringify(model));
  window.open("./smart.html?model=local", "_blank");
};
$("download").onclick = () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(model)], { type: "application/json" }));
  a.download = "custom.nca.json";
  a.click();
  URL.revokeObjectURL(a.href);
};

// ---- start up ----------------------------------------------------------------------

async function pickBackend() {
  try {
    if (navigator.gpu && (await navigator.gpu.requestAdapter())) {
      await import("@tensorflow/tfjs-backend-webgpu");
      if (await tf.setBackend("webgpu")) return "webgpu";
    }
  } catch (e) {
    console.warn("TF.js WebGPU backend unavailable", e);
  }
  if (await tf.setBackend("webgl")) return "webgl";
  await tf.setBackend("cpu");
  return "cpu";
}

PRESETS.heart(pg, pad.width); // something to start from
updateTarget();
const backend = await pickBackend();
window.__tfBackend = backend;
$("s-backend").textContent = backend.toUpperCase();
if (!running) $("status").textContent = `TensorFlow.js ready on ${backend.toUpperCase()}. Draw your shape, or keep the heart, and press Start training.`;
