import * as tf from "@tensorflow/tfjs-core"; // the full TF.js bundle, see the import map
import { createTrainer, imageToTarget } from "./nca-train.js";

const $ = (id) => document.getElementById(id);
let SIZE = 48, PAD = 8;
const detail = () => {
  const size = Number($("detail").value);
  return { size, pad: size === 32 ? 5 : 8, rollout: size === 32 ? [32, 48] : [48, 64] };
};

let target = null, trainer = null, running = false, model = null;
const losses = [];

// Prefer WebGPU, then WebGL
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

function drawRGBA(canvas, data, stride = 4) {
  // premultiplied RGBA (stride 4 or 16 channels) over a dark background
  const g = canvas.getContext("2d");
  const img = g.createImageData(SIZE, SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const a = Math.min(1, Math.max(0, data[i * stride + 3]));
    for (let k = 0; k < 3; k++) {
      const v = Math.min(1, Math.max(0, data[i * stride + k])) + (1 - a) * 0.07;
      img.data[i * 4 + k] = v * 255;
    }
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

function drawLoss() {
  const c = $("loss"), g = c.getContext("2d");
  g.clearRect(0, 0, c.width, c.height);
  if (losses.length < 2) return;
  const logs = losses.map((l) => Math.log10(Math.max(l, 1e-6)));
  const lo = Math.min(...logs), hi = Math.max(...logs);
  g.strokeStyle = "#2563eb";
  g.lineWidth = 3;
  g.beginPath();
  logs.forEach((v, i) => {
    const x = (i / (logs.length - 1)) * c.width;
    const y = c.height - 8 - ((v - lo) / Math.max(1e-6, hi - lo)) * (c.height - 16);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.stroke();
}

$("file").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  window.__lastImage = await createImageBitmap(file);
  makeTarget();
  $("start").disabled = running;
  $("status").textContent = "Ready. Press Start training.";
};
function makeTarget() {
  if (!window.__lastImage) return;
  ({ size: SIZE, pad: PAD } = detail());
  for (const id of ["target-view", "sample-view"]) $(id).width = $(id).height = SIZE;
  target = imageToTarget(window.__lastImage, SIZE, PAD, { removeBackground: $("nobg").checked });
  drawRGBA($("target-view"), target);
}
$("nobg").onchange = makeTarget;
$("detail").onchange = makeTarget;
$("steps").oninput = (e) => { $("steps-value").textContent = e.target.value; };

$("start").onclick = async () => {
  if (!target) return;
  trainer?.dispose();
  losses.length = 0;
  const total = Number($("steps").value);
  trainer = createTrainer(tf, target, { size: SIZE, steps: total, rollout: detail().rollout });
  running = true;
  $("start").disabled = true;
  $("detail").disabled = true; // the grid size is fixed for a run
  $("stop").disabled = false;
  const t0 = performance.now();
  while (running && trainer.step < total) {
    const r = await trainer.trainStep();
    losses.push(r.loss);
    if (r.step < 5 || r.step % 5 === 0 || r.step === total) {
      const first = tf.slice(r.preview, [0, 0, 0, 0], [1, -1, -1, -1]);
      const sample = await first.data();
      first.dispose();
      drawRGBA($("sample-view"), sample, 16);
      drawLoss();
      const per = (performance.now() - t0) / r.step;
      const left = Math.round(((total - r.step) * per) / 1000);
      $("status").textContent = `Step ${r.step} of ${total} · loss ${r.loss.toFixed(4)} · about ${Math.floor(left / 60)}m ${left % 60}s left`;
    }
    r.preview.dispose();
    if (r.step % 50 === 0) await finish(false); // keep a usable model as we go
  }
  await finish(true);
};

async function finish(final) {
  model = await trainer.toModelFile("custom");
  $("open").disabled = false;
  $("download").disabled = false;
  if (final) {
    running = false;
    $("start").disabled = false;
    $("detail").disabled = false;
    $("stop").disabled = true;
    $("status").textContent = `Done after ${trainer.step} steps. Open it in Smart Particles, then cut holes to test the healing.`;
  }
}

$("stop").onclick = () => { running = false; };
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

const backend = await pickBackend();
window.__tfBackend = backend;
$("status").textContent = `TensorFlow.js ready on ${backend.toUpperCase()}. Choose an image to begin.`;
