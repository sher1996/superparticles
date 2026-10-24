# Benchmarks

Measured results only. Every file here comes from `playground/bench.html` run on a real device.

## Adding a result

1. `npm run build && npm start`, then open <http://localhost:8000/playground/bench.html>.
2. Close other tabs, plug in the laptop, keep the tab visible, and press **Run benchmark** (about 1–2 minutes).
3. Press **Copy JSON** and save it as `benchmarks/<date>-<device>-<browser>.json`, for example `2026-10-24-rtx3060-chrome131.json`.
4. Commit it. The file records the browser, GPU, device pixel ratio and core count alongside the numbers.

## What is measured

- **Particles**: for each renderer (Canvas2D, WebGL2, WebGPU) and particle count (1k to 100k): median FPS and 95th-percentile frame time with the loop running, plus physics cost per step measured on its own. The FPS is capped by the display refresh rate, so compare physics milliseconds when frames hit the cap.
- **Smart Particles**: update steps per second on a 64×64 grid for each backend (WebGPU, WebGL2, CPU), measured after growing the pattern and timed until the GPU has finished.

The test stage is a 320×200 CSS-pixel canvas, so results reflect simulation and draw cost rather than fill rate at full screen.
