import { build } from 'esbuild';

build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/superparticles.min.js',
  bundle: true,
  minify: true,
  format: 'esm',
}).catch(() => process.exit(1)); 