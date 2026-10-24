// Parity tests: the JS NCA reference must reproduce training/nca.py exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const { outputFiles } = await build({
  stdin: {
    contents: `export * from './src/nca/model.ts'; export * from './src/nca/cpu.ts'; export * from './src/nca/cpu3d.ts';`,
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

test('3D voxel reference reproduces the PyTorch rollout', () => {
  const doc3 = JSON.parse(readFileSync('test/fixtures/random3d.nca.json', 'utf8'));
  const vec3 = JSON.parse(readFileSync('test/fixtures/random3d.vectors.json', 'utf8'));
  const m = nca.parseModel(doc3);
  assert.equal(m.dims, 3);
  assert.equal(m.w1.length, m.hidden * 64);
  assert.throws(() => new nca.NCAGridCPU(m), /3D/);
  const grid = new nca.NCAGrid3DCPU(m, { size: vec3.size, seed: vec3.seed });
  grid.state.set(f32(vec3.input));
  grid.step = vec3.startStep;
  grid.advance(vec3.steps);
  const want = f32(vec3.output);
  let maxErr = 0, live = 0;
  for (let i = 0; i < want.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(grid.state[i] - want[i]));
    if (want[i] !== 0) live++;
  }
  assert.ok(live > 50, `vector should exercise live voxels (${live})`);
  assert.ok(maxErr < 1e-4, `max abs error ${maxErr}`);
  assert.ok(grid.points().length % 7 === 0);
});

test('learned swarm: JS runtime reproduces the PyTorch rollout', async () => {
  const { outputFiles } = await build({
    stdin: { contents: `export * from './src/nca/swarm.ts';`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, format: 'esm', platform: 'neutral', write: false,
  });
  const sw = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
  const doc = JSON.parse(readFileSync('test/fixtures/random.swarm.json', 'utf8'));
  const v = JSON.parse(readFileSync('test/fixtures/random.swarm-vectors.json', 'utf8'));
  const m = sw.parseSwarm(doc);
  assert.equal(m.w1.length, m.hidden * (4 * m.channels + 1));
  const sim = new sw.SwarmCPU(m, { particles: v.particles, seed: v.seed });
  sim.pos.set(f32(v.pos));
  sim.state.set(f32(v.state));
  const start = Array.from(sim.pos);
  sim.advance(v.steps);
  const wantPos = f32(v.outPos), wantState = f32(v.outState);
  let errP = 0, errS = 0, moved = 0;
  for (let i = 0; i < wantPos.length; i++) {
    errP = Math.max(errP, Math.abs(sim.pos[i] - wantPos[i]));
    moved = Math.max(moved, Math.abs(wantPos[i] - start[i]));
  }
  // states grow large with these random weights, so compare relative to magnitude (float32 precision)
  for (let i = 0; i < wantState.length; i++) errS = Math.max(errS, Math.abs(sim.state[i] - wantState[i]) / Math.max(1, Math.abs(wantState[i])));
  assert.ok(moved > 0.01, 'particles should actually move in the vector');
  assert.ok(errP < 1e-4, `position error ${errP}`);
  assert.ok(errS < 1e-5, `relative state error ${errS}`);
  // reset() is deterministic per seed
  const a = new sw.SwarmCPU(m, { seed: 9 }), b = new sw.SwarmCPU(m, { seed: 9 });
  assert.deepEqual(Array.from(a.pos), Array.from(b.pos));
});
