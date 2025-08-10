import { init, setPluginEnabled } from "../dist/index.js";

// Main initialization function
async function initializeApp() {
  const canvas = document.getElementById("sp");
  
  // Ensure canvas is ready
  if (!canvas) {
    throw new Error("Canvas element not found");
  }
  
  // Wait for canvas to be properly initialized
  await new Promise(resolve => {
    if (canvas.getContext('2d')) {
      resolve();
    } else {
      // Retry after a short delay
      setTimeout(() => {
        if (canvas.getContext('2d')) {
          resolve();
        } else {
          throw new Error("Canvas context not available after retry");
        }
      }, 100);
    }
  });

  // Detect best available renderer
  let useWebGPU = false;
  if ('gpu' in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      useWebGPU = !!adapter;
    } catch (_) {
      useWebGPU = false;
    }
  }
  // Force Canvas2D renderer for now – WebGL path draws only one vertex on some GPUs
  const useWebGL = false;

  console.log(`Renderer choice → WebGPU: ${useWebGPU}, WebGL2: ${useWebGL}, Canvas2D: ${!useWebGPU && !useWebGL}`);
  await init(canvas, { useWebGPU, useWebGL });

  // Known plugins and their types (match keys in plugins/manifest.json)
  const plugins = [
    { id: "fireworks-force", name: "Fireworks Force", type: "force" },
    { id: "gravity-well-force", name: "Gravity Well Force", type: "force" },
    { id: "gravity-well-shader", name: "Gravity Well Shader", type: "shader" },
  ];

  const active = new Set();
  const panel = document.getElementById("panel");

  for (const plugin of plugins) {
    const row = document.createElement("label");
    row.className = "flex items-center gap-2";

    const box = document.createElement("input");
    box.type = "checkbox";

    row.append(box, document.createTextNode(plugin.name));
    panel.append(row);

    box.onchange = () => {
      if (box.checked) {
        active.add(plugin.id);
        setPluginEnabled(plugin.type, plugin.id, true);
      } else {
        active.delete(plugin.id);
        setPluginEnabled(plugin.type, plugin.id, false);
      }
      localStorage.setItem("sp_plugins", JSON.stringify([...active]));
    };
  }

  // FPS overlay
  const hud = document.createElement("div");
  hud.className = "absolute bottom-4 left-4 px-2 py-1 bg-black/60 text-white text-xs";
  document.body.append(hud);
  let last = performance.now(), frames = 0;
  const loop = (t) => {
    frames++;
    if (t - last > 1000) {
      hud.textContent = `${frames} FPS`;
      frames = 0;
      last = t;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// Initialize the app
initializeApp().catch(console.error);

export default initializeApp;
