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
const make = (opts = {}) => {
  const sim = new sp.Simulation();
  sim.reset({ w: W, h: H, speed: 40, deterministic: true, count: 1000, ...opts });
  return sim;
};
const snapshot = sim => Array.from(sim.pos);
const speeds = sim => {
  const out = [];
  for (let i = 0; i < sim.count; i++) out.push(Math.hypot(sim.vel[2 * i], sim.vel[2 * i + 1]));
  return out;
};
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const meanDistToCenter = sim => {
  let d = 0;
  for (let i = 0; i < sim.count; i++) d += Math.hypot(sim.pos[2 * i] - W / 2, sim.pos[2 * i + 1] - H / 2);
  return d / sim.count;
};

test('reset honours particleCount', () => {
  const sim = make({ count: 1234, deterministic: false });
  assert.equal(sim.count, 1234);
  assert.equal(sim.pos.length, 1234 * 2);
});

test('deterministic mode gives identical layouts, random mode does not', () => {
  const a = snapshot(make({ count: 500 }));
  assert.deepEqual(snapshot(make({ count: 500 })), a);
  assert.notDeepEqual(snapshot(make({ count: 500, deterministic: false })), a);
});

test('particles spawn inside the bounds at the configured speed', () => {
  const sim = make({ speed: 30, deterministic: false });
  const p = snapshot(sim);
  for (let i = 0; i < p.length; i += 2) {
    assert.ok(p[i] >= 0 && p[i] <= W && p[i + 1] >= 0 && p[i + 1] <= H);
  }
  for (const s of speeds(sim)) assert.ok(Math.abs(s - 30) < 1e-3);
});

test('resize keeps existing particles and spawns new ones in the current bounds', () => {
  const sim = make({ w: 1600, h: 900, count: 100, deterministic: false });
  const before = snapshot(sim);
  sim.resize(300);
  assert.equal(sim.count, 300);
  assert.deepEqual(snapshot(sim).slice(0, 200), before);
  const xs = snapshot(sim).filter((_, i) => i % 2 === 0).slice(100);
  assert.ok(Math.max(...xs) > 800, 'new particles should use the real width, not 800px');
  sim.resize(50);
  assert.deepEqual(snapshot(sim), before.slice(0, 100));
});

test('setSpeed rescales velocities', () => {
  const sim = make({ count: 200 });
  sim.setSpeed(80);
  for (const s of speeds(sim)) assert.ok(Math.abs(s - 80) < 1e-3);
});

test('advance keeps particles in bounds with bounded speed and counts steps', () => {
  const sim = make();
  sim.advance(600);
  assert.equal(sim.step, 600);
  const p = snapshot(sim);
  for (let i = 0; i < p.length; i += 2) {
    assert.ok(p[i] >= 0 && p[i] <= W && p[i + 1] >= 0 && p[i + 1] <= H);
  }
  const s = speeds(sim);
  assert.ok(Math.max(...s) <= 40 * 2.5 + 1e-3);
  assert.ok(mean(s) > 10, 'particles should keep moving');
});

test('replay: same seed, same plugin toggles at the same steps -> same state hash', async () => {
  await sp.loadPlugins();
  const run = (toggleAt, batches) => {
    const sim = make();
    const host = new sp.PluginHost();
    // advancing in different batch sizes must not matter (fixed timestep)
    let done = 0;
    for (const b of batches) {
      if (done <= toggleAt && done + b > toggleAt) {
        sim.advance(toggleAt - done);
        host.setEnabled('force', 'gravity-well-force', true);
        sim.forces = host.forces;
        sim.advance(done + b - toggleAt);
      } else {
        sim.advance(b);
      }
      done += b;
    }
    return sim.stateHash();
  };
  const a = run(100, [300]);
  assert.equal(run(100, [1, 99, 50, 150]), a);
  assert.notEqual(run(101, [300]), a, 'toggling one step later must change the result');
});

test('engines are isolated: plugins on one host do not affect another', async () => {
  await sp.loadPlugins();
  const a = new sp.PluginHost();
  const b = new sp.PluginHost();
  a.setEnabled('force', 'gravity-well-force', true);
  assert.equal(a.forces.length, 1);
  assert.equal(b.forces.length, 0);
});

test('enabling a plugin twice registers it once', async () => {
  await sp.loadPlugins();
  const host = new sp.PluginHost();
  host.setEnabled('force', 'gravity-well-force', true);
  host.setEnabled('force', 'gravity-well-force', true);
  assert.equal(host.forces.length, 1);
  host.setEnabled('force', 'gravity-well-force', false);
  assert.equal(host.forces.length, 0);
});

test('gravity well pulls particles in, fireworks pushes them out', async () => {
  await sp.loadPlugins();
  const run = id => {
    const sim = make();
    const host = new sp.PluginHost();
    const start = meanDistToCenter(sim);
    host.setEnabled('force', id, true);
    sim.forces = host.forces;
    sim.advance(300);
    return meanDistToCenter(sim) - start;
  };
  assert.ok(run('gravity-well-force') < -50);
  assert.ok(run('fireworks-force') > 50);
});

test('shader plugin is registered and bumps the shader version', async () => {
  await sp.loadPlugins();
  const host = new sp.PluginHost();
  const v = host.shaderVersion;
  assert.equal(host.glsl(), undefined);
  host.setEnabled('shader', 'gravity-well-shader', true);
  assert.ok(host.shaderVersion > v);
  assert.match(host.glsl(), /#version 300 es/);
  assert.match(host.wgsl(), /fn fs/);
  assert.deepEqual(host.state().shaders, ['gravity-well-shader']);
  host.disable('gravity-well-shader');
  assert.equal(host.glsl(), undefined);
});

test('hexToRgba parses short and long hex', () => {
  assert.deepEqual(sp.hexToRgba('#ff0000'), { r: 1, g: 0, b: 0, a: 1 });
  assert.deepEqual(sp.hexToRgba('#0f0'), { r: 0, g: 1, b: 0, a: 1 });
  assert.equal(sp.hexToRgba('nope').r.toFixed(2), '0.44');
});
