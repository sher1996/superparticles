import { init, setOptions, exportState, importState, setPluginEnabled } from "../dist/index.js";

// Known plugins and their types (match keys in plugins/manifest.json)
const plugins = [
  { id: "fireworks-force", name: "Fireworks Force", type: "force", key: "F" },
  { id: "gravity-well-force", name: "Gravity Well Force", type: "force", key: "V" },
  { id: "gravity-well-shader", name: "Gravity Well Shader (WebGL2/WebGPU)", type: "shader", key: "S" },
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
  const handle = await init(freshCanvas(), exportState());

  // A newer click may have started another renderer while this one loaded
  if (token !== initToken) {
    handle.stop();
    return;
  }
  engineHandle = handle;

  for (const plugin of plugins) {
    setPluginEnabled(plugin.type, plugin.id, activePlugins.has(plugin.id));
  }

  showRenderer(rendererType, handle.renderer);
  saveState();
}

function initControls() {
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

function flashKeyBadge(element) {
  if (!element) return;
  element.classList.add("pressed");
  setTimeout(() => element.classList.remove("pressed"), 150);
}

function toggleCheckbox(input) {
  if (!input) return;
  input.checked = !input.checked;
  input.dispatchEvent(new Event("change"));
  const kbd = input.parentElement?.querySelector("kbd");
  flashKeyBadge(kbd);
}

function initPlugins() {
  const list = $("plugin-list");
  for (const plugin of plugins) {
    const row = document.createElement("label");
    row.className = "check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.id = plugin.id;
    const kbd = document.createElement("kbd");
    kbd.className = "key-hint";
    kbd.textContent = plugin.key;
    kbd.title = `Press ${plugin.key} to toggle`;
    const labelSpan = document.createElement("span");
    labelSpan.textContent = plugin.name;
    row.append(box, kbd, labelSpan);
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
      setTimeout(() => { copyBtn.textContent = "Copy URL"; }, 2000);
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

function initKeyboardControls() {
  const colorPalette = ["#70c1ff", "#ff7070", "#70ff8b", "#ffdc70", "#d170ff", "#ffffff"];
  let colorIdx = 0;

  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // Do not interfere if user is typing in a text field or color input
    const tag = e.target.tagName;
    if (tag === "INPUT" && (e.target.type === "text" || e.target.type === "color")) return;
    if (tag === "TEXTAREA" || tag === "SELECT") return;

    const key = e.key.toLowerCase();

    // Deterministic: D (primary), A (alias)
    if (key === "d" || key === "a") {
      e.preventDefault();
      toggleCheckbox($("deterministic-toggle"));
      return;
    }

    // Fireworks Force: F (primary), Q (alias)
    if (key === "f" || key === "q") {
      e.preventDefault();
      toggleCheckbox(document.querySelector('#plugin-list input[data-id="fireworks-force"]'));
      return;
    }

    // Gravity Well Force: V (primary), G / W (alias)
    if (key === "v" || key === "g" || key === "w") {
      e.preventDefault();
      toggleCheckbox(document.querySelector('#plugin-list input[data-id="gravity-well-force"]'));
      return;
    }

    // Gravity Well Shader: S (primary), E (alias)
    if (key === "s" || key === "e") {
      e.preventDefault();
      toggleCheckbox(document.querySelector('#plugin-list input[data-id="gravity-well-shader"]'));
      return;
    }

    // Reset presets: R
    if (key === "r") {
      e.preventDefault();
      const resetBtn = $("reset-preset");
      if (resetBtn) resetBtn.click();
      return;
    }

    // Cycle color: C
    if (key === "c") {
      e.preventDefault();
      colorIdx = (colorIdx + 1) % colorPalette.length;
      const nextColor = colorPalette[colorIdx];
      const picker = $("color-picker");
      if (picker) {
        picker.value = nextColor;
        setOptions({ color: nextColor });
        saveState();
        flashKeyBadge(picker.parentElement?.querySelector("kbd"));
      }
      return;
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
initKeyboardControls();
syncUI();
initFPS();

await initRenderer(rendererFromState(exportState()));
