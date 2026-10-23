// Parity tests: the JS NCA reference must reproduce training/nca.py exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const { outputFiles } = await build({
  stdin: {
    contents: `export * from './src/nca/model.ts'; export * from './src/nca/cpu.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'neutral', write: false,
});
const nca = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const doc = JSON.parse(readFileSync('test/fixtures/random.nca.json', 'utf8'));
const vec = JSON.parse(readFileSync('test/fixtures/random.vectors.json', 'utf8'));
const f32 = b64 => { const b = Buffer.from(b64, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const u8 = b64 => new Uint8Array(Buffer.from(b64, 'base64'));

test('model file parses and has the documented shapes', () => {
  const m = nca.parseModel(doc);
  assert.equal(m.channels, 16);
  assert.equal(m.hidden, 128);
  assert.equal(m.w1.length, 128 * 48);
  assert.equal(m.b1.length, 128);
  assert.equal(m.w2.length, 16 * 128);
  assert.throws(() => nca.parseModel({ ...doc, version: 2 }), /version/);
});

test('fire-mask hash matches Python bit for bit', () => {
  const mask = u8(vec.maskStep40);
  let ones = 0;
  for (let y = 0; y < vec.size; y++) {
    for (let x = 0; x < vec.size; x++) {
      const js = nca.fires(x, y, vec.startStep, vec.seed, doc.fireRate) ? 1 : 0;
      assert.equal(js, mask[y * vec.size + x], `cell ${x},${y}`);
      ones += js;
    }
  }
  const frac = ones / (vec.size * vec.size);
  assert.ok(frac > 0.35 && frac < 0.65, `fire rate ${frac} should be near 0.5`);
});

test('CPU reference reproduces the PyTorch rollout', () => {
  const m = nca.parseModel(doc);
  const grid = new nca.NCAGridCPU(m, { width: vec.size, height: vec.size, seed: vec.seed });
  grid.state.set(f32(vec.input));
  grid.step = vec.startStep;
  grid.advance(vec.steps);
  const want = f32(vec.output);
  let maxErr = 0, live = 0;
  for (let i = 0; i < want.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(grid.state[i] - want[i]));
    if (want[i] !== 0) live++;
  }
  assert.ok(live > 50, 'vector should exercise live cells');
  assert.ok(maxErr < 1e-4, `max abs error ${maxErr}`);
});

test('float16 decoding', () => {
  assert.equal(nca.halfToFloat(0x3c00), 1);
  assert.equal(nca.halfToFloat(0xc000), -2);
  assert.equal(nca.halfToFloat(0x0001), 2 ** -24);
  assert.equal(nca.halfToFloat(0x7c00), Infinity);
});

test('damage clears a disc and plant resets the step counter', () => {
  const m = nca.parseModel(doc);
  const g = new nca.NCAGridCPU(m, { width: 16, height: 16 });
  g.state.fill(1);
  g.damage(8, 8, 3);
  const plane = 256;
  assert.equal(g.state[3 * plane + 8 * 16 + 8], 0);
  assert.equal(g.state[3 * plane + 0], 1);
  g.step = 5;
  g.plant();
  assert.equal(g.step, 0);
  assert.equal(g.state[3 * plane + 8 * 16 + 8], 1);
});
