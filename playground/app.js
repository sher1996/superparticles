import { init, setOptions, exportState, importState, setPluginEnabled, registerPlugin } from "../dist/index.js";

// Known plugins and their types (match keys in plugins/manifest.json)
const plugins = [
  { id: "fireworks-force", name: "Fireworks Force", type: "force" },
  { id: "gravity-well-force", name: "Gravity Well Force", type: "force" },
  { id: "gravity-well-shader", name: "Gravity Well Shader (WebGL2/WebGPU)", type: "shader" },
];

const defaultState = {
  color: "#70c1ff",
  speed: 40,
  useWebGL: false,
  useWebGPU: false,
  particleCount: 1000,
  particleSize: 2,
  deterministic: false,
};

const $ = (id) => document.getElementById(id);
const activePlugins = new Set();
let engineHandle = null;
let initToken = 0;

function rendererFromState(state) {
  if (state.useWebGPU) return "webgpu";
  if (state.useWebGL) return "webgl2";
  return "canvas2d";
}

function saveState() {
  try {
    localStorage.setItem("sp_state", JSON.stringify(exportState()));
    localStorage.setItem("sp_plugins", JSON.stringify([...activePlugins]));
  } catch (error) {
    console.warn("Failed to save state:", error);
  }
}

function loadSavedState() {
  try {
    const state = JSON.parse(localStorage.getItem("sp_state") || "null");
    if (state) importState(state);
    const saved = JSON.parse(localStorage.getItem("sp_plugins") || "[]");
    saved.forEach((id) => activePlugins.add(id));
  } catch (error) {
    console.warn("Failed to load saved state:", error);
  }
}

function loadPresetFromHash() {
  const hash = window.location.hash.slice(1);
  if (!hash) return false;
  try {
    const payload = JSON.parse(atob(decodeURIComponent(hash)));
    if (!payload.o || !Array.isArray(payload.p)) return false;
    importState({ ...defaultState, ...payload.o });
    activePlugins.clear();
    payload.p.forEach((id) => activePlugins.add(id));
    return true;
  } catch (error) {
    console.warn("Failed to parse preset from hash:", error);
    return false;
  }
}

function syncUI() {
  const state = exportState();
  $("speed-slider").value = state.speed;
  $("speed-value").textContent = state.speed;
  $("particle-count-slider").value = state.particleCount;
  $("particle-count-value").textContent = state.particleCount;
  $("particle-size-slider").value = state.particleSize;
  $("particle-size-value").textContent = state.particleSize;
  $("deterministic-toggle").checked = state.deterministic;
  $("color-picker").value = state.color;
  document.querySelectorAll("#plugin-list input").forEach((box) => {
    box.checked = activePlugins.has(box.dataset.id);
  });
}

function showRenderer(requested, actual) {
  document.querySelectorAll("[data-renderer]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.renderer === actual));
  });
  const note = $("renderer-note");
  note.hidden = requested === actual;
  note.textContent = `${requested} isn't available in this browser, using ${actual}.`;
}

// A canvas keeps its first context type, so each renderer gets a fresh canvas
function freshCanvas() {
  const old = $("sp");
  const canvas = document.createElement("canvas");
  canvas.id = "sp";
  old.replaceWith(canvas);
  return canvas;
}

async function initRenderer(rendererType) {
  const token = ++initToken;
  engineHandle?.stop();
  engineHandle = null;

  setOptions({ useWebGL: rendererType === "webgl2", useWebGPU: rendererType === "webgpu" });
  const canvas = freshCanvas();
  if (smartMode) canvas.className = "beside-panel";
  const handle = await init(canvas, exportState());

  // A newer click may have started another renderer while this one loaded
  if (token !== initToken) {
    handle.stop();
    return;
  }
  engineHandle = handle;

  for (const plugin of plugins) {
    setPluginEnabled(plugin.type, plugin.id, activePlugins.has(plugin.id));
  }
  setPluginEnabled("force", "smart-swarm", smartMode);

  showRenderer(rendererType, handle.renderer);
  syncPlay();
  saveState();
}

// ---- smart swarm mode ---------------------------------------------------------------
// The same engine particles as always, steered by a learned swarm that is never drawn:
// particle i follows swarm particle i % 256, at its own small fixed offset.

let smartMode = false;
let swarm = null; // SwarmCPU, loaded on first use
let swarmStepsPerStep = 1;

const SPRING = 0.03; // pull toward the target, per step (the engine's own damping and drift stay on)

function hash01(i, k) {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// world (CSS px) <-> swarm coordinates ([-1, 1], y down), shape centred in the canvas
const swarmScale = ({ w, h }) => Math.min(w, h) / 2.2;

registerPlugin("smart-swarm", {
  registerForce: (add) =>
    add((p, i, bounds) => {
      if (!swarm) return;
      if (i === 0) swarm.advance(swarmStepsPerStep); // one swarm step per engine step
      const j = i % swarm.n;
      const s = swarmScale(bounds);
      // spread each follower inside a small disc around its leader, so thousands fill the shape
      // (about one leader spacing wide, so neighbouring groups blend instead of clumping)
      const a = hash01(i, 0) * Math.PI * 2, r = Math.sqrt(hash01(i, 1)) * 0.085 * s;
      const tx = bounds.w / 2 + swarm.pos[2 * j] * s + Math.cos(a) * r;
      const ty = bounds.h / 2 + swarm.pos[2 * j + 1] * s + Math.sin(a) * r;
      p.x += (tx - p.x) * SPRING;
      p.y += (ty - p.y) * SPRING;
    }),
});

async function loadSwarmSim() {
  if (swarm) return;
  const { loadSwarm, SwarmCPU } = await import("../dist/nca.js");
  swarm = new SwarmCPU(await loadSwarm("../models/swarm-heart.swarm.json"));
}

function showMode() {
  document.querySelectorAll("[data-mode]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String((btn.dataset.mode === "swarm") === smartMode));
  });
  $("swarm-controls").hidden = !smartMode;
  try {
    localStorage.setItem("sp_mode", smartMode ? "swarm" : "engine");
  } catch {}
}

async function setMode(swarmOn) {
  smartMode = swarmOn;
  showMode();
  if (swarmOn) await loadSwarmSim();
  await initRenderer(rendererFromState(exportState()));
}

function initSwarmControls() {
  $("mode-engine").onclick = () => setMode(false);
  $("mode-swarm").onclick = () => setMode(true);
  $("swarm-scatter").onclick = () => swarm?.scatter((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8, 0.45);
  $("swarm-reset").onclick = () => swarm?.reset();
  $("swarm-speed").oninput = (e) => {
    $("swarm-speed-value").textContent = e.target.value;
    swarmStepsPerStep = Number(e.target.value);
  };
  // click or drag on the canvas scatters the swarm under the pointer, as on the swarm page
  let down = false;
  const scatterAt = (e, r) => {
    if (!smartMode || !swarm) return;
    const c = $("sp"), rect = c.getBoundingClientRect();
    const s = swarmScale({ w: rect.width, h: rect.height });
    swarm.scatter((e.clientX - rect.left - rect.width / 2) / s, (e.clientY - rect.top - rect.height / 2) / s, r);
  };
  document.addEventListener("pointerdown", (e) => {
    if (e.target.id !== "sp") return;
    down = true;
    scatterAt(e, 0.3);
  });
  document.addEventListener("pointermove", (e) => { if (down && e.target.id === "sp") scatterAt(e, 0.2); });
  addEventListener("pointerup", () => { down = false; });
  setInterval(() => {
    if (smartMode && swarm) $("swarm-stats").textContent = `swarm step ${swarm.step} · ${swarm.n} leaders · ${exportState().particleCount} particles follow them`;
  }, 250);
}

function syncPlay() {
  const btn = $("play-toggle");
  const paused = engineHandle?.engine.paused ?? false;
  btn.textContent = paused ? "Play" : "Pause";
  btn.setAttribute("aria-pressed", String(!paused));
}

function initControls() {
  // Also the way to start motion when the viewer prefers reduced motion
  $("play-toggle").onclick = () => {
    const e = engineHandle?.engine;
    if (!e) return;
    e.paused ? e.resume() : e.pause();
    syncPlay();
  };

  document.querySelectorAll("[data-renderer]").forEach((btn) => {
    btn.onclick = () => initRenderer(btn.dataset.renderer);
  });

  const slider = (id, valueId, key, parse) => {
    $(id).oninput = (e) => {
      const value = parse(e.target.value);
      $(valueId).textContent = value;
      setOptions({ [key]: value });
      saveState();
    };
  };
  slider("speed-slider", "speed-value", "speed", (v) => parseInt(v, 10));
  slider("particle-count-slider", "particle-count-value", "particleCount", (v) => parseInt(v, 10));
  slider("particle-size-slider", "particle-size-value", "particleSize", parseFloat);

  $("deterministic-toggle").onchange = (e) => {
    setOptions({ deterministic: e.target.checked });
    saveState();
  };

  $("color-picker").oninput = (e) => {
    setOptions({ color: e.target.value });
    saveState();
  };
}

function initPlugins() {
  const list = $("plugin-list");
  for (const plugin of plugins) {
    const row = document.createElement("label");
    row.className = "check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.id = plugin.id;
    row.append(box, document.createTextNode(plugin.name));
    list.append(row);

    box.onchange = () => {
      if (box.checked) activePlugins.add(plugin.id);
      else activePlugins.delete(plugin.id);
      setPluginEnabled(plugin.type, plugin.id, box.checked);
      saveState();
    };
  }
}

function initPresets() {
  const copyBtn = $("copy-preset");
  copyBtn.onclick = () => {
    const payload = { o: exportState(), p: [...activePlugins] };
    const url = `${location.origin}${location.pathname}#${encodeURIComponent(btoa(JSON.stringify(payload)))}`;
    navigator.clipboard.writeText(url).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy link"; }, 2000);
    }).catch(() => {
      prompt("Copy this URL:", url);
    });
  };

  $("reset-preset").onclick = () => {
    importState(defaultState);
    activePlugins.clear();
    history.replaceState(null, "", location.pathname);
    syncUI();
    initRenderer("canvas2d");
  };

  window.addEventListener("hashchange", () => {
    if (loadPresetFromHash()) {
      syncUI();
      initRenderer(rendererFromState(exportState()));
    }
  });
}

function initFPS() {
  const fps = $("fps-display");
  let last = performance.now();
  let frames = 0;
  const loop = (t) => {
    frames++;
    if (t - last >= 1000) {
      fps.textContent = `FPS: ${Math.round((frames * 1000) / (t - last))}`;
      frames = 0;
      last = t;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

loadSavedState();
loadPresetFromHash();

initControls();
initPlugins();
initPresets();
syncUI();
initFPS();
initSwarmControls();

let savedMode = "engine";
try {
  savedMode = localStorage.getItem("sp_mode") || "engine";
} catch {}
await setMode(savedMode === "swarm" && !location.hash);
