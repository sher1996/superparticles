import { build } from 'esbuild';
import { copyFileSync } from 'fs';
import { execSync } from 'child_process';

// Build main source files
await build({
  entryPoints: ['src/index.ts'],
  outdir: 'dist',
  bundle: true,
  minify: true,
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  target: ['es2020'], // needed for async/await in drawGPU
});

// Build plugin files
await build({
  entryPoints: ['plugins/FireworksForce.ts', 'plugins/GravityWellForce.ts', 'plugins/GravityWellShader.ts'],
  outdir: 'dist/plugins',
  bundle: false,
  minify: false,
  format: 'esm',
  target: ['es2020'],
});

// Build playground files
await build({
  entryPoints: ['playground/app.ts'],
  outdir: 'dist/playground',
  bundle: false,
  minify: false,
  format: 'esm',
  target: ['es2022'],
});

// Copy playground files to dist folder
copyFileSync('playground/index.html', 'dist/playground/index.html');
copyFileSync('playground/ui.css', 'dist/playground/ui.css');

// Copy manifest file to dist folder
copyFileSync('plugins/manifest.json', 'dist/plugins/manifest.json');

// Check bundle sizes
console.log('\n📦 Bundle Size Report:');
try {
  const mainSize = execSync('node -e "console.log(require(\'fs\').statSync(\'dist/index.js\').size)"', { encoding: 'utf8' }).trim();
  const mainSizeKB = Math.round(parseInt(mainSize) / 1024);
  console.log(`Main bundle: ${mainSizeKB}KB`);
  
  // Bundle budget fail-gate: check gzipped size
  try {
    const gzippedSize = execSync('gzip -c dist/index.js | wc -c', { encoding: 'utf8' }).trim();
    const gzippedSizeBytes = parseInt(gzippedSize);
    const gzippedSizeKB = Math.round(gzippedSizeBytes / 1024);
    console.log(`Main bundle (gzipped): ${gzippedSizeKB}KB (${gzippedSizeBytes} bytes)`);
    
    if (gzippedSizeBytes > 15000) {
      console.error(`❌ Bundle budget exceeded: ${gzippedSizeBytes} bytes > 15000 bytes limit`);
      process.exit(1);
    }
  } catch (e) {
    console.log('⚠️  Could not check gzipped size (gzip command not available)');
  }
  
  if (parseInt(mainSize) > 50 * 1024) {
    console.log('⚠️  Warning: Main bundle exceeds 50KB target');
  }
  
  // Check plugin sizes
  const pluginFiles = ['FireworksForce.js', 'GravityWellForce.js', 'GravityWellShader.js'];
  for (const file of pluginFiles) {
    try {
      const size = execSync(`node -e "console.log(require('fs').statSync('dist/plugins/${file}').size)"`, { encoding: 'utf8' }).trim();
      const sizeKB = Math.round(parseInt(size) / 1024);
      console.log(`Plugin ${file}: ${sizeKB}KB`);
      
      if (parseInt(size) > 50 * 1024) {
        console.log(`⚠️  Warning: Plugin ${file} exceeds 50KB target`);
      }
    } catch (e) {
      // Plugin file doesn't exist, skip
    }
  }
} catch (e) {
  console.log('Could not generate bundle size report');
}

console.log('\n✅ Build complete!'); 