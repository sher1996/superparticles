import { build } from 'esbuild';

build({
  entryPoints: ['src/index.ts'],
  outdir: 'dist',
  bundle: true,
  minify: true,
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  target: ['es2020'], // needed for async/await in drawGPU
}).catch(() => process.exit(1)); 