import { init, setOptions, exportState, importState, setPluginEnabled } from "../dist/index.js";

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

  // Current renderer state
  let currentRenderer = 'canvas2d';
  let engineHandle = null;

  // Known plugins and their types (match keys in plugins/manifest.json)
  const plugins = [
    { id: "fireworks-force", name: "Fireworks Force", type: "force" },
    { id: "gravity-well-force", name: "Gravity Well Force", type: "force" },
    { id: "gravity-well-shader", name: "Gravity Well Shader", type: "shader" },
  ];

  const activePlugins = new Set();

  // Load saved state from localStorage
  function loadSavedState() {
    try {
      const savedState = localStorage.getItem("sp_state");
      if (savedState) {
        const state = JSON.parse(savedState);
        importState(state);
        updateUIFromState(state);
      }
      
      const savedPlugins = localStorage.getItem("sp_plugins");
      if (savedPlugins) {
        const pluginArray = JSON.parse(savedPlugins);
        pluginArray.forEach(id => activePlugins.add(id));
      }
    } catch (error) {
      console.warn("Failed to load saved state:", error);
    }
  }

  // Save state to localStorage
  function saveState() {
    try {
      const state = exportState();
      localStorage.setItem("sp_state", JSON.stringify(state));
      localStorage.setItem("sp_plugins", JSON.stringify([...activePlugins]));
    } catch (error) {
      console.warn("Failed to save state:", error);
    }
  }

  // Update UI elements from current state
  function updateUIFromState(state) {
    document.getElementById("speed-slider").value = state.speed || 40;
    document.getElementById("speed-value").textContent = state.speed || 40;
    document.getElementById("particle-count-slider").value = state.particleCount || 1000;
    document.getElementById("particle-count-value").textContent = state.particleCount || 1000;
    document.getElementById("deterministic-toggle").checked = state.deterministic || false;
    document.getElementById("color-picker").value = state.color || "#70c1ff";
    
    // Update renderer buttons
    updateRendererButtons(state.useWebGL, state.useWebGPU);
  }

  // Update renderer button states
  function updateRendererButtons(useWebGL, useWebGPU) {
    const canvas2dBtn = document.getElementById("renderer-canvas2d");
    const webgl2Btn = document.getElementById("renderer-webgl2");
    const webgpuBtn = document.getElementById("renderer-webgpu");
    
    canvas2dBtn.className = "px-3 py-1 rounded text-xs";
    webgl2Btn.className = "px-3 py-1 rounded text-xs";
    webgpuBtn.className = "px-3 py-1 rounded text-xs";
    
    if (!useWebGL && !useWebGPU) {
      canvas2dBtn.className += " bg-blue-500 text-white";
      webgl2Btn.className += " bg-gray-300 text-gray-700";
      webgpuBtn.className += " bg-gray-300 text-gray-700";
      currentRenderer = 'canvas2d';
    } else if (useWebGL) {
      canvas2dBtn.className += " bg-gray-300 text-gray-700";
      webgl2Btn.className += " bg-blue-500 text-white";
      webgpuBtn.className += " bg-gray-300 text-gray-700";
      currentRenderer = 'webgl2';
    } else if (useWebGPU) {
      canvas2dBtn.className += " bg-gray-300 text-gray-700";
      webgl2Btn.className += " bg-gray-300 text-gray-700";
      webgpuBtn.className += " bg-blue-500 text-white";
      currentRenderer = 'webgpu';
    }
  }

  // Initialize renderer
  async function initRenderer(rendererType) {
    if (engineHandle) {
      engineHandle.stop();
    }

    let useWebGL = false;
    let useWebGPU = false;
    
    switch (rendererType) {
      case 'webgl2':
        useWebGL = true;
        break;
      case 'webgpu':
        useWebGPU = true;
        break;
      default:
        useWebGL = false;
        useWebGPU = false;
    }

    try {
      engineHandle = await init(canvas, { 
        useWebGL, 
        useWebGPU,
        ...exportState()
      });
      
      // Re-enable active plugins
      activePlugins.forEach(pluginId => {
        const plugin = plugins.find(p => p.id === pluginId);
        if (plugin) {
          setPluginEnabled(plugin.type, plugin.id, true);
        }
      });
      
      updateRendererButtons(useWebGL, useWebGPU);
      saveState();
    } catch (error) {
      console.error("Failed to initialize renderer:", error);
      // Fallback to canvas2d
      await initRenderer('canvas2d');
    }
  }

  // Initialize renderer buttons
  function initRendererButtons() {
    document.getElementById("renderer-canvas2d").onclick = () => initRenderer('canvas2d');
    document.getElementById("renderer-webgl2").onclick = () => initRenderer('webgl2');
    document.getElementById("renderer-webgpu").onclick = () => initRenderer('webgpu');
  }

  // Initialize sliders and controls
  function initControls() {
    // Speed slider
    const speedSlider = document.getElementById("speed-slider");
    const speedValue = document.getElementById("speed-value");
    
    speedSlider.oninput = (e) => {
      const speed = parseInt(e.target.value);
      speedValue.textContent = speed;
      setOptions({ speed });
      saveState();
    };

    // Particle count slider
    const particleCountSlider = document.getElementById("particle-count-slider");
    const particleCountValue = document.getElementById("particle-count-value");
    
    particleCountSlider.oninput = (e) => {
      const particleCount = parseInt(e.target.value);
      particleCountValue.textContent = particleCount;
      setOptions({ particleCount });
      saveState();
    };

    // Deterministic toggle
    const deterministicToggle = document.getElementById("deterministic-toggle");
    deterministicToggle.onchange = (e) => {
      const deterministic = e.target.checked;
      setOptions({ deterministic });
      saveState();
    };

    // Color picker
    const colorPicker = document.getElementById("color-picker");
    colorPicker.onchange = (e) => {
      const color = e.target.value;
      setOptions({ color });
      saveState();
    };
  }

  // Initialize plugin checkboxes
  function initPlugins() {
    const pluginList = document.getElementById("plugin-list");
    
    for (const plugin of plugins) {
      const row = document.createElement("label");
      row.className = "flex items-center gap-2";

      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = activePlugins.has(plugin.id);

      row.append(box, document.createTextNode(plugin.name));
      pluginList.append(row);

      box.onchange = () => {
        if (box.checked) {
          activePlugins.add(plugin.id);
          setPluginEnabled(plugin.type, plugin.id, true);
        } else {
          activePlugins.delete(plugin.id);
          setPluginEnabled(plugin.type, plugin.id, false);
        }
        saveState();
      };
    }
  }

  // Initialize preset management
  function initPresets() {
    // Copy preset URL
    document.getElementById("copy-preset").onclick = () => {
      const payload = {
        o: exportState(),
        p: [...activePlugins]
      };
      const encoded = btoa(JSON.stringify(payload));
      const url = `${window.location.origin}${window.location.pathname}#${encoded}`;
      
      navigator.clipboard.writeText(url).then(() => {
        const btn = document.getElementById("copy-preset");
        const originalText = btn.textContent;
        btn.textContent = "Copied!";
        btn.className = "px-3 py-1 bg-green-600 text-white rounded text-xs";
        setTimeout(() => {
          btn.textContent = originalText;
          btn.className = "px-3 py-1 bg-green-500 text-white rounded text-xs";
        }, 2000);
      }).catch(() => {
        // Fallback for older browsers
        prompt("Copy this URL:", url);
      });
    };

    // Reset preset
    document.getElementById("reset-preset").onclick = () => {
      const defaultState = {
        color: '#70c1ff',
        speed: 40,
        useWebGL: false,
        useWebGPU: false,
        particleCount: 1000,
        deterministic: false
      };
      
      importState(defaultState);
      activePlugins.clear();
      updateUIFromState(defaultState);
      
      // Re-enable plugins
      const checkboxes = document.querySelectorAll('#plugin-list input[type="checkbox"]');
      checkboxes.forEach(cb => cb.checked = false);
      
      saveState();
      
      // Reinitialize renderer with default settings
      initRenderer('canvas2d');
    };
  }

  // Load preset from URL hash
  function loadPresetFromHash() {
    const hash = window.location.hash.slice(1);
    if (hash) {
      try {
        const payload = JSON.parse(atob(hash));
        if (payload.o && payload.p) {
          importState(payload.o);
          activePlugins.clear();
          payload.p.forEach(id => activePlugins.add(id));
          updateUIFromState(payload.o);
          
          // Update plugin checkboxes
          const checkboxes = document.querySelectorAll('#plugin-list input[type="checkbox"]');
          checkboxes.forEach(cb => {
            const pluginId = plugins.find(p => p.name === cb.nextSibling.textContent.trim())?.id;
            if (pluginId) {
              cb.checked = activePlugins.has(pluginId);
            }
          });
          
          saveState();
          return true;
        }
      } catch (error) {
        console.warn("Failed to parse preset from hash:", error);
      }
    }
    return false;
  }

  // FPS monitoring
  function initFPS() {
    const fpsDisplay = document.getElementById("fps-display");
    let last = performance.now();
    let frames = 0;
    
    const loop = (t) => {
      frames++;
      if (t - last > 1000) {
        fpsDisplay.textContent = `FPS: ${frames}`;
        frames = 0;
        last = t;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // Load saved state first
  loadSavedState();
  
  // Try to load preset from hash
  const presetLoaded = loadPresetFromHash();
  
  // Initialize renderer (use saved state or default)
  if (!presetLoaded) {
    await initRenderer('canvas2d');
  } else {
    // Initialize with current state
    const state = exportState();
    let useWebGL = state.useWebGL || false;
    let useWebGPU = state.useWebGPU || false;
    
    if (!useWebGL && !useWebGPU) {
      await initRenderer('canvas2d');
    } else if (useWebGL) {
      await initRenderer('webgl2');
    } else if (useWebGPU) {
      await initRenderer('webgpu');
    }
  }

  // Initialize all UI components
  initRendererButtons();
  initControls();
  initPlugins();
  initPresets();
  initFPS();

  // Listen for hash changes
  window.addEventListener('hashchange', () => {
    loadPresetFromHash();
  });
}

// Initialize the app
initializeApp().catch(console.error);

export default initializeApp;
