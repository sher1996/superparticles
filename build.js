import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'fs';
import { gzipSync } from 'zlib';
import { execFileSync } from 'child_process';

const GZIP_BUDGET = 15000; // bytes, for everything a Canvas2D page loads

// Library: entry + lazily loaded renderer/plugin chunks
const result = await build({
  entryPoints: ['src/index.ts'],
  outdir: 'dist',
  bundle: true,
  minify: true,
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  target: ['es2020'],
  loader: { '.wgsl': 'text' },
  metafile: true,
});

// Standalone plugin files, as examples for third-party authors
await build({
  entryPoints: ['plugins/FireworksForce.ts', 'plugins/GravityWellForce.ts', 'plugins/GravityWellShader.ts'],
  outdir: 'dist/plugins',
  bundle: false,
  minify: false,
  format: 'esm',
  target: ['es2020'],
});
mkdirSync('dist/plugins', { recursive: true });
copyFileSync('plugins/manifest.json', 'dist/plugins/manifest.json');

// Type declarations for consumers
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', '.', '--noEmit', 'false', '--declaration', '--emitDeclarationOnly', '--outDir', 'dist/types'], { stdio: 'inherit' });

// Size report
const kb = n => (n / 1024).toFixed(1) + 'KB';
const gz = file => gzipSync(readFileSync(file)).length;

console.log('\n📦 Bundle Size Report:');
let total = 0;
for (const file of Object.keys(result.metafile.outputs).sort()) {
  const size = gz(file);
  console.log(`  ${file.padEnd(44)} ${kb(statSync(file).size).padStart(8)}  (${kb(size)} gzipped)`);
  if (!/drawGL|drawGPU/.test(file)) total += size; // GPU renderers are only loaded when chosen
}
console.log(`  Core + Canvas2D + plugins: ${total} bytes gzipped (budget ${GZIP_BUDGET})`);
if (total > GZIP_BUDGET) {
  console.error(`❌ Bundle budget exceeded: ${total} > ${GZIP_BUDGET} bytes`);
  process.exit(1);
}

console.log('\n✅ Build complete!');
