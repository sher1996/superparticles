// Runs the real WebGPU NCA compute shaders headless through Dawn (the `webgpu`
// npm package) and checks them against the PyTorch vectors and the CPU reference.
// Uses Chromium's bundled SwiftShader Vulkan driver when no GPU driver exists.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { build } from 'esbuild';

function findSwiftShader() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), '.cache', 'ms-playwright')].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // prefer full Chromium's SwiftShader; the headless-shell build crashed under Dawn here
    const dirs = readdirSync(root).sort((a, b) => Number(b.startsWith('chromium-')) - Number(a.startsWith('chromium-')));
    for (const dir of dirs) {
      if (!dir.startsWith('chromium') || !statSync(join(root, dir)).isDirectory()) continue;
      for (const sub of readdirSync(join(root, dir))) {
        const icd = join(root, dir, sub, 'vk_swiftshader_icd.json');
        if (existsSync(icd)) return icd;
      }
    }
  }
  return null;
}
if (!process.env.VK_ICD_FILENAMES) {
  const icd = findSwiftShader();
  if (icd) process.env.VK_ICD_FILENAMES = icd;
}

// Bundle before starting Dawn: esbuild's child process and Dawn's threads don't mix
const { outputFiles } = await build({
  stdin: {
    contents: `export * from './src/nca/model.ts'; export * from './src/nca/cpu.ts'; export * from './src/nca/webgpu.ts'; export * from './src/nca/backend.ts';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'neutral', write: false,
});
const nca = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const { create, globals } = await import('webgpu');
Object.assign(globalThis, globals);
// Pin the Dawn instance for the whole run: the tests execute after this module's
// top-level code, and an unreferenced instance can be garbage collected, which
// tears down Dawn's threads mid-test (glibc aborts with a futex error).
const gpu = (globalThis.__dawnInstance = create([]));
const adapter = await gpu.requestAdapter();
// One device for all tests: software drivers take a while to compile the update shader
const device = adapter ? await adapter.requestDevice() : null;

const doc = JSON.parse(readFileSync('test/fixtures/random.nca.json', 'utf8'));
const vec = JSON.parse(readFileSync('test/fixtures/random.vectors.json', 'utf8'));
const f32 = b64 => { const b = Buffer.from(b64, 'base64'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const maxErr = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

after(() => device?.destroy());
const opts = { timeout: 600000, skip: adapter ? false : 'no WebGPU adapter (install Chromium via Playwright for SwiftShader)' };

test('WebGPU compute matches PyTorch and the CPU reference', opts, async () => {
  const m = nca.parseModel(doc);
  const size = vec.size;
  // One backend for every check: software drivers compile the update shader slowly
  const backend = await nca.createWebGPUNCA(null, m, size, size, { device });

  // 1. exact PyTorch rollout
  backend.setState(f32(vec.input));
  backend.advance(vec.steps, vec.startStep, vec.seed);
  const err1 = maxErr(await backend.readState(), f32(vec.output));
  assert.ok(err1 < 1e-4, `vs PyTorch: max abs error ${err1}`);

  // 2. long seeded run with damage, against the CPU reference
  const seed = 99;
  const cpu = new nca.NCAGridCPU(m, { width: size, height: size, seed });
  // start from the grown test state (random weights would let a lone seed die at once)
  backend.setState(f32(vec.input));
  cpu.state.set(f32(vec.input));
  cpu.advance(30); backend.advance(30, 0, seed);
  cpu.damage(12, 12, 3); backend.damage(12, 12, 3);
  cpu.advance(30); backend.advance(30, 30, seed);
  const err2 = maxErr(await backend.readState(), cpu.state);
  assert.ok(err2 < 1e-3, `vs CPU: max abs error ${err2}`);
  assert.ok(cpu.state.some(v => v !== 0), 'the run must keep live cells');
  backend.destroy();
});
