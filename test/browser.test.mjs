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
