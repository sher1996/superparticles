/* SuperParticles – one-script embed.
 *
 *   <canvas data-superparticles data-count="2000" data-color="#70c1ff" data-renderer="webgl2"></canvas>
 *   <canvas data-smart-particles data-model="/models/heart.nca.json"></canvas>
 *   <script type="module" src="https://cdn.jsdelivr.net/npm/superparticles/dist/embed.js"></script>
 *
 * Every matching canvas (now, and any added later) gets its own engine. Particle
 * attributes: data-count, data-size, data-speed, data-color, data-renderer
 * (canvas2d | webgl2 | webgpu), data-deterministic, data-plugins (comma-separated ids).
 * Smart Particles attributes: data-model (required), data-backend, data-seed,
 * data-steps-per-frame, data-interactive ("false" to disable click damage).
 */

const started = new WeakSet<HTMLCanvasElement>();

function num(v: string | undefined) {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function startParticles(c: HTMLCanvasElement) {
  const { createEngine } = await import('./index.js');
  const d = c.dataset;
  const engine = await createEngine(c, {
    particleCount: num(d.count),
    particleSize: num(d.size),
    speed: num(d.speed),
    color: d.color || undefined,
    useWebGL: d.renderer === 'webgl2',
    useWebGPU: d.renderer === 'webgpu',
    deterministic: d.deterministic !== undefined && d.deterministic !== 'false',
  });
  for (const id of (d.plugins || '').split(',').map(s => s.trim()).filter(Boolean)) {
    engine.setPluginEnabled(id.endsWith('-shader') ? 'shader' : 'force', id, true);
  }
  (c as HTMLCanvasElement & { superparticles?: unknown }).superparticles = engine;
}

async function startSmart(c: HTMLCanvasElement) {
  const d = c.dataset;
  if (!d.model) {
    console.warn('SuperParticles embed: data-smart-particles needs data-model', c);
    return;
  }
  const { createSmartParticles } = await import('./nca/index.js');
  const sp = await createSmartParticles(c, {
    model: new URL(d.model, document.baseURI),
    backend: (d.backend as 'auto' | 'webgpu' | 'webgl2' | 'cpu') || 'auto',
    seed: num(d.seed),
    stepsPerFrame: num(d.stepsPerFrame),
    interactive: d.interactive !== 'false',
  });
  (c as HTMLCanvasElement & { smartParticles?: unknown }).smartParticles = sp;
}

function scan(root: ParentNode) {
  root.querySelectorAll<HTMLCanvasElement>('canvas[data-superparticles], canvas[data-smart-particles]').forEach(c => {
    if (started.has(c)) return;
    started.add(c);
    const run = 'smartParticles' in c.dataset ? startSmart : startParticles;
    run(c).catch(error => console.error('SuperParticles embed failed', error));
  });
}

function boot() {
  scan(document);
  new MutationObserver(() => scan(document)).observe(document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
