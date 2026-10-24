import { createSmartParticles } from "../dist/nca.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// Models shipped in /models (see training/README.md to train your own)
const MODELS = [
  { id: "heart", url: "../models/heart.nca.json", label: "Heart" },
];
if (params.get("model") === "local") {
  // handed over by train.html
  try {
    const doc = JSON.parse(localStorage.getItem("sp_custom_model"));
    if (doc) MODELS.unshift({ id: "custom", url: doc, label: "Your trained model" });
  } catch (e) {
    console.warn("No trained model found in this browser", e);
  }
} else if (params.get("model")) {
  MODELS.unshift({ id: "custom", url: params.get("model"), label: "Custom (from URL)" });
}

let sp = null;
let damageMark = null; // { step, mask } snapshot taken right before damage

for (const m of MODELS) {
  const opt = document.createElement("option");
  opt.value = m.id;
  opt.textContent = m.label;
  $("model-select").append(opt);
}

function freshCanvas() {
  const old = $("nca");
  const c = document.createElement("canvas");
  c.id = "nca";
  c.setAttribute("aria-label", old.getAttribute("aria-label"));
  old.replaceWith(c);
  return c;
}

async function start(id) {
  sp?.stop();
  const m = MODELS.find((x) => x.id === id) ?? MODELS[0];
  sp = await createSmartParticles(freshCanvas(), {
    model: m.url,
    backend: params.get("backend") || "auto",
    seed: Number(params.get("seed") || 0),
    stepsPerFrame: Number($("speed").value),
    width: params.get("size") ? Number(params.get("size")) : undefined,
    height: params.get("size") ? Number(params.get("size")) : undefined,
  });
  window.smart = sp; // handy for experiments in the console (and for tests)
  const metrics = sp.model.metrics;
  $("backend-note").textContent =
    `Running on ${sp.backend.toUpperCase()}, ${sp.width}×${sp.height} cells` +
    (metrics ? ` · trained growth IoU ${metrics.growth_iou}, recovery IoU ${metrics.recovery_iou}` : "");
  syncPlay();
  damageMark = null;
  $("recovery").textContent = "Damage it to measure recovery.";
}

function syncPlay() {
  $("play").textContent = sp.paused ? "Play" : "Pause";
  $("play").setAttribute("aria-pressed", String(!sp.paused));
}

async function aliveMask() {
  const s = await sp.readState();
  const plane = sp.width * sp.height;
  const m = new Uint8Array(plane);
  for (let i = 0; i < plane; i++) m[i] = s[3 * plane + i] > 0.1 ? 1 : 0;
  return m;
}

function iou(a, b) {
  let inter = 0, union = 0;
  for (let i = 0; i < a.length; i++) {
    inter += a[i] & b[i];
    union += a[i] | b[i];
  }
  return union ? inter / union : 1;
}

async function markDamage() {
  if (!damageMark) damageMark = { step: sp.getStep(), mask: await aliveMask(), done: false };
  else damageMark.done = false;
  $("recovery").textContent = "Healing…";
}

$("model-select").onchange = (e) => start(e.target.value);
$("play").onclick = () => { sp.paused ? sp.resume() : sp.pause(); syncPlay(); };
$("step").onclick = () => sp.advance(1);
$("reset").onclick = () => { sp.reset(); damageMark = null; $("recovery").textContent = "Damage it to measure recovery."; };
$("punch").onclick = async () => {
  await markDamage();
  const r = sp.width * 0.12;
  sp.damage(sp.width * (0.3 + Math.random() * 0.4), sp.height * (0.3 + Math.random() * 0.4), r);
};
$("halve").onclick = async () => {
  await markDamage();
  for (let y = 0; y < sp.height; y += 2) sp.damage(sp.width * 0.75, y, sp.width * 0.27);
};
$("speed").oninput = (e) => {
  $("speed-value").textContent = e.target.value;
  sp.stepsPerFrame = Number(e.target.value);
};
$("channel").oninput = (e) => {
  const c = Number(e.target.value);
  $("channel-value").textContent = c === 3 ? "colour" : `hidden ${c}`;
  sp.setView(c === 3 ? "rgba" : "hidden", c);
};

// Mark pointer damage too (the canvas cuts holes itself)
document.addEventListener("pointerdown", (e) => { if (e.target.id === "nca") markDamage(); });

// Stats + recovery tracking, a few times per second
setInterval(async () => {
  if (!sp) return;
  const snap = await sp.snapshot();
  $("stats").textContent = `step ${snap.step} · ${snap.alive} live cells · seed ${sp.seed}`;
  if (damageMark && !damageMark.done && snap.step > damageMark.step) {
    const score = iou(await aliveMask(), damageMark.mask);
    if (score >= 0.95) {
      damageMark.done = true;
      $("recovery").textContent = `Recovered (${(score * 100).toFixed(0)}% overlap with the undamaged shape) in ${snap.step - damageMark.step} steps.`;
      damageMark = null;
    } else {
      $("recovery").textContent = `Healing… ${(score * 100).toFixed(0)}% of the shape restored`;
    }
  }
}, 250);

await start(MODELS[0].id);
