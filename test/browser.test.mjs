// End-to-end smoke test: serves the repo, opens the playground in Chromium and
// checks that each renderer draws particles and the controls change the picture.
// Run with: npm run build && npm run test:browser
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

let server, browser, base;

before(async () => {
  server = createServer(async (req, res) => {
    const path = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!path.startsWith(root)) return res.writeHead(403).end();
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
  });
});

after(async () => {
  await browser?.close();
  server?.close();
});

async function openPlayground() {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => localStorage.clear());
  await page.goto(`${base}/playground/index.html`);
  await page.waitForSelector('[aria-pressed="true"]');
  await page.waitForTimeout(500);
  return { page, errors };
}

// Average color of the canvas area right of the control panel, from a real screenshot
async function canvasStats(page) {
  const png = await page.screenshot({ clip: { x: 340, y: 0, width: 660, height: 700 } });
  return page.evaluate(async src => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    let lit = 0, r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] + d[i + 1] + d[i + 2] > 60) { lit++; r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    }
    return { lit, r: r / (lit || 1), g: g / (lit || 1), b: b / (lit || 1) };
  }, 'data:image/png;base64,' + png.toString('base64'));
}

const pressed = page => page.getAttribute('[aria-pressed="true"]', 'data-renderer');

test('Canvas2D draws visible particles and reacts to the controls', async () => {
  const { page, errors } = await openPlayground();
  assert.equal(await pressed(page), 'canvas2d');

  const start = await canvasStats(page);
  assert.ok(start.lit > 500, `expected visible particles, got ${start.lit} lit pixels`);
  assert.ok(start.b > start.r, 'default color is blue-ish');

  await page.$eval('#color-picker', el => { el.value = '#ff0000'; el.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(200);
  const red = await canvasStats(page);
  assert.ok(red.r > 100 && red.g < 40 && red.b < 40, `color picker should recolor particles, got ${JSON.stringify(red)}`);

  await page.$eval('#particle-count-slider', el => { el.value = '5000'; el.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(200);
  const more = await canvasStats(page);
  assert.ok(more.lit > red.lit * 2, 'raising the particle count should draw more particles');

  assert.deepEqual(errors, []);
  await page.close();
});

test('WebGL2 renderer is selectable and draws particles', async () => {
  const { page, errors } = await openPlayground();
  await page.click('#renderer-webgl2');
  await page.waitForTimeout(800);
  assert.equal(await pressed(page), 'webgl2');
  assert.ok((await canvasStats(page)).lit > 500);

  // Shader plugin should compile and change the look (dimmer toward the center)
  await page.getByText('Gravity Well Shader').click();
  await page.waitForTimeout(300);
  assert.ok((await canvasStats(page)).lit > 100);
  assert.deepEqual(errors, []);
  await page.close();
});

test('WebGPU renderer draws particles or falls back cleanly', async t => {
  const { page, errors } = await openPlayground();
  await page.click('#renderer-webgpu');
  await page.waitForTimeout(1500);
  const actual = await pressed(page);
  if (actual !== 'webgpu') {
    assert.equal(await page.isVisible('#renderer-note'), true, 'fallback should be explained');
    t.diagnostic(`WebGPU unavailable here, fell back to ${actual}`);
  }
  assert.ok((await canvasStats(page)).lit > 500);
  assert.deepEqual(errors.filter(e => !/WebGPU/.test(e)), []);
  await page.close();
});

test('switching renderers repeatedly does not duplicate plugin forces', async () => {
  const { page, errors } = await openPlayground();
  await page.getByText('Gravity Well Force').click();
  for (const id of ['webgl2', 'canvas2d', 'webgl2', 'canvas2d']) {
    await page.click(`#renderer-${id}`);
    await page.waitForTimeout(300);
  }
  const state = await page.evaluate(async () => (await import('/dist/index.js')).getPluginState());
  assert.deepEqual(state.forces, ['gravity-well-force']);
  assert.deepEqual(errors, []);
  await page.close();
});

async function openFixture(opts = {}) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, ...opts });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/test/fixtures/blank.html`);
  return { page, errors };
}

test('two engines on one page are independent', async () => {
  const { page, errors } = await openFixture();
  const r = await page.evaluate(async () => {
    const { createEngine } = await import('/dist/index.js');
    const mk = (w, h) => {
      const c = document.createElement('canvas');
      c.style.width = w + 'px';
      c.style.height = h + 'px';
      document.body.append(c);
      return c;
    };
    const a = await createEngine(mk(300, 200), { particleCount: 100, autoplay: false, deterministic: true });
    const b = await createEngine(mk(300, 200), { particleCount: 400, autoplay: false, deterministic: true, useWebGL: true });
    a.setPluginEnabled('force', 'gravity-well-force', true);
    a.step(10);
    b.setOptions({ color: '#ff0000' });
    const out = {
      counts: [a.sim.count, b.sim.count],
      plugins: [a.getPluginState().forces, b.getPluginState().forces],
      steps: [a.getStep(), b.getStep()],
      colors: [a.exportState().color, b.exportState().color],
      renderers: [a.renderer, b.renderer],
    };
    a.stop(); b.stop();
    return out;
  });
  assert.deepEqual(r.counts, [100, 400]);
  assert.deepEqual(r.plugins, [['gravity-well-force'], []]);
  assert.deepEqual(r.steps, [10, 0]);
  assert.deepEqual(r.colors, ['#70c1ff', '#ff0000']);
  assert.deepEqual(r.renderers, ['canvas2d', 'webgl2']);
  assert.deepEqual(errors, []);
  await page.close();
});

test('fixed world replays identically on different canvas sizes and renderers', async () => {
  const hashes = [];
  for (const [w, h, useWebGL] of [[400, 300, false], [1000, 500, true], [250, 700, false]]) {
    const { page } = await openFixture();
    hashes.push(await page.evaluate(async ([w, h, useWebGL]) => {
      const { createEngine } = await import('/dist/index.js');
      const c = document.createElement('canvas');
      c.style.width = w + 'px';
      c.style.height = h + 'px';
      document.body.append(c);
      const e = await createEngine(c, { world: { width: 800, height: 600 }, deterministic: true, autoplay: false, useWebGL });
      e.step(120);
      e.setPluginEnabled('force', 'fireworks-force', true);
      e.step(240);
      return e.stateHash();
    }, [w, h, useWebGL]));
    await page.close();
  }
  assert.equal(new Set(hashes).size, 1, `hashes differ: ${hashes}`);
});

test('reduced motion: engine starts paused and still draws a frame', async () => {
  const { page } = await openFixture({ reducedMotion: 'reduce' });
  const r = await page.evaluate(async () => {
    const { createEngine } = await import('/dist/index.js');
    const c = document.createElement('canvas');
    c.style.width = '200px';
    c.style.height = '200px';
    document.body.append(c);
    const e = await createEngine(c, { deterministic: true });
    await new Promise(r => setTimeout(r, 300));
    const pausedStep = e.getStep();
    const lit = c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0);
    e.resume();
    await new Promise(r => setTimeout(r, 300));
    return { paused: pausedStep, after: e.getStep(), lit };
  });
  assert.equal(r.paused, 0);
  assert.ok(r.after > 0, 'resume() should start the loop');
  assert.ok(r.lit, 'a still frame should be drawn');
  await page.close();
});

test('Smart Particles: WebGL2 and CPU backends match the PyTorch vectors in the browser', async () => {
  const { page, errors } = await openFixture();
  const r = await page.evaluate(async () => {
    const { createSmartParticles } = await import('/dist/nca.js');
    const doc = await (await fetch('/test/fixtures/random.nca.json')).json();
    const vec = await (await fetch('/test/fixtures/random.vectors.json')).json();
    const f32 = b64 => new Float32Array(Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer);
    const out = {};
    for (const backend of ['webgl2', 'cpu']) {
      const c = document.createElement('canvas');
      c.style.width = '200px';
      c.style.height = '200px';
      document.body.append(c);
      const sp = await createSmartParticles(c, {
        model: doc, backend, width: vec.size, height: vec.size, seed: vec.seed, autoplay: false, interactive: false,
      });
      sp.setState(f32(vec.input), vec.startStep);
      sp.advance(vec.steps);
      const got = await sp.readState();
      const want = f32(vec.output);
      let err = 0;
      for (let i = 0; i < want.length; i++) err = Math.max(err, Math.abs(got[i] - want[i]));
      out[backend] = { kind: sp.backend, err, step: sp.getStep() };
      sp.stop();
    }
    return out;
  });
  assert.equal(r.webgl2.kind, 'webgl2');
  assert.equal(r.cpu.kind, 'cpu');
  assert.ok(r.webgl2.err < 1e-4, `webgl2 max abs error ${r.webgl2.err}`);
  assert.ok(r.cpu.err < 1e-4, `cpu max abs error ${r.cpu.err}`);
  assert.equal(r.webgl2.step, 48);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Smart Particles demo page grows the model and reacts to damage', async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/playground/smart.html?backend=webgl2`);
  await page.waitForFunction(() => window.smart && window.smart.getStep() > 120, null, { timeout: 60000 });
  await page.click('#play'); // pause so the counts below are stable
  const grown = (await page.evaluate(() => window.smart.snapshot())).alive;
  assert.ok(grown > 300, `expected a grown pattern, got ${grown} live cells`);

  await page.click('#punch');
  const damaged = (await page.evaluate(() => window.smart.snapshot())).alive;
  assert.ok(damaged < grown, 'punching a hole should remove cells');

  // Mouse damage goes through the same path
  const box = await page.locator('#nca').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  assert.ok((await page.evaluate(() => window.smart.snapshot())).alive <= damaged);

  await page.click('#reset');
  assert.equal(await page.evaluate(() => window.smart.getStep()), 0);
  assert.equal((await page.evaluate(() => window.smart.snapshot())).alive, 1, 'only the seed cell is visible after a reset');
  assert.deepEqual(errors, []);
  await page.close();
});

// TF.js is loaded from jsDelivr by the training page; serve it from node_modules in tests
async function routeTFJS(page) {
  await page.route('https://cdn.jsdelivr.net/npm/@tensorflow/**', async route => {
    const m = new URL(route.request().url()).pathname.match(/@tensorflow\/([^@]+)@[^/]+\/(.*)$/);
    try {
      const body = await readFile(join(root, 'node_modules', '@tensorflow', m[1], m[2]));
      await route.fulfill({ status: 200, contentType: 'text/javascript', body });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
}

test('in-browser training: TF.js model matches PyTorch, learns, and exports a working model', async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await routeTFJS(page);
  await page.goto(`${base}/test/fixtures/blank.html`);
  await page.addScriptTag({ type: 'importmap', content: JSON.stringify({ imports: {
    '@tensorflow/tfjs-core': 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.fesm.min.js',
  } }) });
  const r = await page.evaluate(async () => {
    const tf = await import('@tensorflow/tfjs-core');
    await tf.setBackend('webgl');
    const { createNCA, createTrainer, modelFile, CHANNELS } = await import('/playground/nca-train.js');
    const nca = await import('/dist/nca.js');
    const f32 = b64 => new Float32Array(Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer);

    // 1. Parity with the PyTorch vectors (same weights, same hashed fire mask)
    const doc = await (await fetch('/test/fixtures/random.nca.json')).json();
    const vec = await (await fetch('/test/fixtures/random.vectors.json')).json();
    const model = nca.parseModel(doc);
    const net = createNCA(tf, model);
    const S = vec.size, plane = S * S;
    const chw = f32(vec.input), nhwc = new Float32Array(chw.length);
    for (let c = 0; c < CHANNELS; c++) for (let i = 0; i < plane; i++) nhwc[i * CHANNELS + c] = chw[c * plane + i];
    let x = tf.tensor4d(nhwc, [1, S, S, CHANNELS]);
    for (let s = 0; s < vec.steps; s++) {
      const m = new Float32Array(plane);
      // same hash as the runtimes (model.ts); NCAGridCPU exposes it indirectly, so recompute here
      for (let y = 0; y < S; y++) for (let xx = 0; xx < S; xx++) {
        let h = Math.imul(xx, 0x8da6b343); h ^= Math.imul(y, 0xd8163841); h ^= Math.imul(vec.startStep + s, 0xcb1ab31f); h ^= vec.seed;
        h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
        m[y * S + xx] = ((h >>> 0) >>> 8) < Math.floor(0.5 * (1 << 24)) ? 1 : 0;
      }
      const next = net.step(x, tf.tensor4d(m, [1, S, S, 1]));
      x.dispose();
      x = next;
    }
    const got = await x.data();
    const want = f32(vec.output);
    let parity = 0;
    for (let c = 0; c < CHANNELS; c++) for (let i = 0; i < plane; i++) parity = Math.max(parity, Math.abs(got[i * CHANNELS + c] - want[c * plane + i]));

    // 2. A short training run lowers the loss
    const size = 24;
    const target = new Float32Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let xx = 0; xx < size; xx++) {
      if ((xx - 12) ** 2 + (y - 12) ** 2 < 36) { const i = (y * size + xx) * 4; target[i] = 0.9; target[i + 1] = 0.2; target[i + 2] = 0.3; target[i + 3] = 1; }
    }
    const trainer = createTrainer(tf, target, { size, batch: 2, pool: 16, rollout: [10, 14], damage: 0, steps: 60 });
    const losses = [];
    for (let i = 0; i < 60; i++) { const s = await trainer.trainStep(); losses.push(s.loss); s.preview.dispose(); }

    // 3. Export -> load in the runtime -> same numbers as TF.js (float16 rounding aside)
    const file = await trainer.toModelFile('test');
    const loaded = nca.parseModel(file);
    const grid = new nca.NCAGridCPU(loaded, { width: size, height: size });
    grid.advance(10);
    trainer.dispose();
    return {
      parity,
      first: losses.slice(0, 5).reduce((a, b) => a + b) / 5,
      last: losses.slice(-5).reduce((a, b) => a + b) / 5,
      sha: file.sha256.length,
      gridFinite: grid.state.every(Number.isFinite),
      backend: tf.getBackend(),
    };
  });
  assert.ok(r.parity < 1e-4, `TF.js vs PyTorch max abs error ${r.parity}`);
  assert.ok(r.last < r.first * 0.8, `loss should fall (first ${r.first}, last ${r.last})`);
  assert.equal(r.sha, 64);
  assert.ok(r.gridFinite);
  assert.deepEqual(errors, []);
  await page.close();
});

test('training page: upload an image, train, stop, and hand the model to Smart Particles', { timeout: 900000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await routeTFJS(page);
  await page.goto(`${base}/playground/train.html`);
  await page.waitForFunction(() => window.__tfBackend, null, { timeout: 60000 });
  // a 32x32 PNG made in the page itself
  const png = await page.evaluate(async () => {
    const c = new OffscreenCanvas(32, 32);
    const g = c.getContext('2d');
    g.fillStyle = '#e02850';
    g.beginPath(); g.arc(16, 16, 12, 0, Math.PI * 2); g.fill();
    const b = await c.convertToBlob({ type: 'image/png' });
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  });
  await page.selectOption('#detail', '32');
  await page.setInputFiles('#file', { name: 'dot.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await page.waitForFunction(() => !document.getElementById('start').disabled);
  await page.click('#start');
  // software GPUs (CI) need a minute or more for one full-size step
  await page.waitForFunction(() => /Step [1-9]/.test(document.getElementById('status').textContent), null, { timeout: 400000 });
  await page.click('#stop');
  await page.waitForFunction(() => !document.getElementById('open').disabled, null, { timeout: 400000 });
  const stored = await page.evaluate(() => { document.getElementById('open').click(); return JSON.parse(localStorage.getItem('sp_custom_model')); });
  assert.equal(stored.format, 'superparticles-nca');
  assert.equal(stored.grid.width, 32);
  assert.deepEqual(errors, []);
  await page.close();
});

test('one-script embed starts particles and Smart Particles from data attributes', async () => {
  const { page, errors } = await openFixture();
  await page.evaluate(() => {
    document.body.innerHTML = `
      <canvas id="a" data-superparticles data-count="300" data-color="#ff0000" data-renderer="webgl2" data-plugins="gravity-well-force" style="width:300px;height:200px"></canvas>`;
    const s = document.createElement('script');
    s.type = 'module';
    s.src = '/dist/embed.js';
    document.body.append(s);
  });
  await page.waitForFunction(() => document.getElementById('a').superparticles);
  // canvases added later are picked up too
  await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.id = 'b';
    c.dataset.smartParticles = '';
    c.dataset.model = '/models/heart.nca.json';
    c.dataset.backend = 'cpu';
    c.style.cssText = 'width:200px;height:200px';
    document.body.append(c);
  });
  await page.waitForFunction(() => document.getElementById('b').smartParticles, null, { timeout: 30000 });
  const r = await page.evaluate(() => {
    const a = document.getElementById('a').superparticles, b = document.getElementById('b').smartParticles;
    return { count: a.sim.count, color: a.exportState().color, renderer: a.renderer, forces: a.getPluginState().forces, backend: b.backend };
  });
  assert.deepEqual(r, { count: 300, color: '#ff0000', renderer: 'webgl2', forces: ['gravity-well-force'], backend: 'cpu' });
  assert.deepEqual(errors, []);
  await page.close();
});

test('Smart Particles page records a video and produces embed code', async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/playground/smart.html?backend=webgl2`);
  await page.waitForFunction(() => window.smart && window.smart.getStep() > 5, null, { timeout: 60000 });
  const download = page.waitForEvent('download', { timeout: 30000 });
  await page.click('#record');
  const file = await download;
  assert.match(file.suggestedFilename(), /^smart-particles-.*\.(webm|mp4)$/);
  page.on('dialog', d => d.dismiss()); // clipboard fallback prompt, if the clipboard is unavailable
  await page.click('#embed');
  const code = await (await page.waitForFunction(() => window.__embedCode, null, { timeout: 10000 })).jsonValue();
  assert.match(code, /data-smart-particles data-model="http[^"]+heart\.nca\.json"/);
  assert.match(code, /dist\/embed\.js/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('3D viewer grows the planet, takes damage and exports a PLY', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/playground/smart3d.html`);
  await page.waitForFunction(() => window.smart3d);
  await page.click('#play'); // pause; drive steps directly
  const grown = await page.evaluate(() => { const g = window.smart3d; g.plant(); g.advance(120); return g.points().length / 7; });
  assert.ok(grown > 250 && grown < 700, `expected a planet-sized shape, got ${grown} voxels`);
  await page.click('#slice');
  const cut = await page.evaluate(() => window.smart3d.points().length / 7);
  assert.ok(cut < grown * 0.75, 'cutting the front half removes voxels');
  const download = page.waitForEvent('download');
  await page.click('#ply');
  assert.match((await download).suggestedFilename(), /\.ply$/);
  assert.deepEqual(errors, []);
  await page.close();
});
