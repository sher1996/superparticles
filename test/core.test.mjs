// Unit tests for the physics core and plugin registry.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Bundle the TypeScript sources into one module we can import directly
const { outputFiles } = await build({
  stdin: {
    contents: `
      export * from './src/core.ts';
      export * from './src/plugin.ts';
      export { hexToRgba } from './src/color.ts';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
const sp = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const W = 800, H = 600;
const snapshot = () => Array.from(sp.pos.subarray(0, sp.getParticleCount() * 2));
const speeds = () => {
  const out = [];
  for (let i = 0; i < sp.getParticleCount(); i++) out.push(Math.hypot(sp.vel[2 * i], sp.vel[2 * i + 1]));
  return out;
};
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const meanDistToCenter = () => {
  let d = 0;
  const n = sp.getParticleCount();
  for (let i = 0; i < n; i++) d += Math.hypot(sp.pos[2 * i] - W / 2, sp.pos[2 * i + 1] - H / 2);
  return d / n;
};

test('initArrays honours particleCount', () => {
  sp.initArrays(W, H, 40, false, 1234);
  assert.equal(sp.getParticleCount(), 1234);
  assert.equal(sp.pos.length, 1234 * 2);
});

test('deterministic mode gives identical layouts, random mode does not', () => {
  sp.initArrays(W, H, 40, true, 500);
  const a = snapshot();
  sp.initArrays(W, H, 40, true, 500);
  assert.deepEqual(snapshot(), a);

  sp.initArrays(W, H, 40, false, 500);
  assert.notDeepEqual(snapshot(), a);
});

test('particles spawn inside the bounds at the configured speed', () => {
  sp.initArrays(W, H, 30, false, 1000);
  const p = snapshot();
  for (let i = 0; i < p.length; i += 2) {
    assert.ok(p[i] >= 0 && p[i] <= W && p[i + 1] >= 0 && p[i + 1] <= H);
  }
  for (const s of speeds()) assert.ok(Math.abs(s - 30) < 1e-3);
});

test('resizeParticleBuffers keeps existing particles and spawns new ones in the current bounds', () => {
  sp.initArrays(1600, 900, 40, false, 100);
  const before = snapshot();
  sp.resizeParticleBuffers(300);
  assert.equal(sp.getParticleCount(), 300);
  assert.deepEqual(snapshot().slice(0, 200), before);
  const p = snapshot();
  const xs = p.filter((_, i) => i % 2 === 0).slice(100);
  assert.ok(Math.max(...xs) > 800, 'new particles should use the real width, not 800px');

  sp.resizeParticleBuffers(50);
  assert.equal(sp.getParticleCount(), 50);
  assert.deepEqual(snapshot(), before.slice(0, 100));
});

test('setSpeed rescales velocities', () => {
  sp.initArrays(W, H, 40, true, 200);
  sp.setSpeed(80);
  for (const s of speeds()) assert.ok(Math.abs(s - 80) < 1e-3);
  assert.equal(sp.getSpeed(), 80);
});

test('stepPhysics keeps particles in bounds with bounded speed', () => {
  sp.initArrays(W, H, 40, true, 1000);
  for (let i = 0; i < 600; i++) sp.stepPhysics(W, H);
  const p = snapshot();
  for (let i = 0; i < p.length; i += 2) {
    assert.ok(p[i] >= 0 && p[i] <= W && p[i + 1] >= 0 && p[i + 1] <= H);
  }
  const s = speeds();
  assert.ok(Math.max(...s) <= 40 * 2.5 + 1e-3);
  assert.ok(mean(s) > 10, 'particles should keep moving');
});

test('enabling a plugin twice registers it once', async () => {
  await sp.loadPlugins();
  sp.setPluginEnabled('force', 'gravity-well-force', true);
  sp.setPluginEnabled('force', 'gravity-well-force', true);
  assert.equal(sp.getActiveForces().length, 1);
  sp.setPluginEnabled('force', 'gravity-well-force', false);
  assert.equal(sp.getActiveForces().length, 0);
});

test('gravity well pulls particles in, fireworks pushes them out', async () => {
  await sp.loadPlugins();
  const run = id => {
    sp.initArrays(W, H, 40, true, 1000);
    const start = meanDistToCenter();
    sp.setPluginEnabled('force', id, true);
    for (let i = 0; i < 300; i++) sp.stepPhysics(W, H);
    sp.setPluginEnabled('force', id, false);
    return meanDistToCenter() - start;
  };
  assert.ok(run('gravity-well-force') < -50);
  assert.ok(run('fireworks-force') > 50);
});

test('shader plugin is registered and bumps the shader version', async () => {
  await sp.loadPlugins();
  const v = sp.getShaderVersion();
  assert.equal(sp.currentGLSL(), undefined);
  sp.setPluginEnabled('shader', 'gravity-well-shader', true);
  assert.ok(sp.getShaderVersion() > v);
  assert.match(sp.currentGLSL(), /#version 300 es/);
  assert.match(sp.currentWGSL(), /fn fs/);
  assert.deepEqual(sp.getPluginState().shaders, ['gravity-well-shader']);
  sp.disablePlugin('gravity-well-shader');
  assert.equal(sp.currentGLSL(), undefined);
});

test('hexToRgba parses short and long hex', () => {
  assert.deepEqual(sp.hexToRgba('#ff0000'), { r: 1, g: 0, b: 0, a: 1 });
  assert.deepEqual(sp.hexToRgba('#0f0'), { r: 0, g: 1, b: 0, a: 1 });
  assert.equal(sp.hexToRgba('nope').r.toFixed(2), '0.44');
});
