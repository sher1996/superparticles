import manifest from '../plugins/manifest.json' assert { type: 'json' };
import { init } from '../dist/superparticles.min.js';
import type { Options as InitOptions } from '../src/index';

const canvas = document.getElementById('sp') as HTMLCanvasElement;
const initOptions: InitOptions = { useWebGPU: true };
const engine = await init(canvas, initOptions);

const active = new Set<string>();
const panel  = document.getElementById('panel')!;

for (const [key, path] of Object.entries(manifest)) {
  const row  = document.createElement('label');
  row.className = 'flex items-center gap-2';

  const box = document.createElement('input');
  box.type  = 'checkbox';

  row.append(box, document.createTextNode(key));
  panel.append(row);

  box.onchange = async () => {
    if (box.checked) {
      const mod = await import('..' + path);
      active.add(key);
      mod.default.registerForce?.(engine.registerForce);
      mod.default.registerShader?.(engine.registerShader);
    } else {
      active.delete(key);
      engine.disablePlugin(key);
    }
    localStorage.setItem('sp_plugins', JSON.stringify([...active]));
  };
}

// FPS overlay
const hud = document.createElement('div');
hud.className = 'absolute bottom-4 left-4 px-2 py-1 bg-black/60 text-white text-xs';
document.body.append(hud);

let last = performance.now(), frames = 0;
const loop = (t: number) => {
  frames++;
  if (t - last > 1000) {
    hud.textContent = `${frames} FPS`;
    frames = 0; last = t;
  }
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);