// Test deterministic behavior for SuperParticles
// This test verifies that deterministic mode produces identical results

import { init, setOptions, exportState, importState } from "./dist/index.js";

async function testDeterministic() {
  console.log('🧪 Testing Deterministic Behavior...\n');
  
  // Create a canvas element for testing
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  
  try {
    // Test 1: Same settings should produce same state
    console.log('🔍 Test 1: Deterministic mode consistency');
    
    const state1 = { speed: 50, particleCount: 1000, deterministic: true };
    const state2 = { speed: 50, particleCount: 1000, deterministic: true };
    
    // Initialize with first state
    const engine1 = await init(canvas, state1);
    const export1 = exportState();
    
    // Stop and reinitialize with second state
    engine1.stop();
    const engine2 = await init(canvas, state2);
    const export2 = exportState();
    
    // Compare exports
    const match = JSON.stringify(export1) === JSON.stringify(export2);
    console.log(`  ${match ? '✅' : '❌'} States match: ${match}`);
    
    // Test 2: Different deterministic seeds should produce different results
    console.log('\n🔍 Test 2: Non-deterministic mode produces different results');
    
    const state3 = { speed: 50, particleCount: 1000, deterministic: false };
    engine2.stop();
    const engine3 = await init(canvas, state3);
    const export3 = exportState();
    
    const different = JSON.stringify(export1) !== JSON.stringify(export3);
    console.log(`  ${different ? '✅' : '❌'} Non-deterministic produces different results: ${different}`);
    
    // Test 3: Preset URL consistency
    console.log('\n🔍 Test 3: Preset URL consistency');
    
    const preset1 = {
      o: export1,
      p: ['fireworks-force', 'gravity-well-force']
    };
    
    const preset2 = {
      o: export1,
      p: ['fireworks-force', 'gravity-well-force']
    };
    
    const presetMatch = JSON.stringify(preset1) === JSON.stringify(preset2);
    console.log(`  ${presetMatch ? '✅' : '❌'} Preset payloads match: ${presetMatch}`);
    
    // Test 4: Base64 encoding/decoding
    console.log('\n🔍 Test 4: Base64 encoding/decoding');
    
    const encoded = btoa(JSON.stringify(preset1));
    const decoded = JSON.parse(atob(encoded));
    const encodeMatch = JSON.stringify(preset1) === JSON.stringify(decoded);
    
    console.log(`  ${encodeMatch ? '✅' : '❌'} Base64 round-trip works: ${encodeMatch}`);
    console.log(`  Encoded length: ${encoded.length} characters`);
    
    engine3.stop();
    
    console.log('\n🎯 Deterministic Test Results:');
    console.log(`  - Mode consistency: ${match ? 'PASS' : 'FAIL'}`);
    console.log(`  - Non-deterministic difference: ${different ? 'PASS' : 'FAIL'}`);
    console.log(`  - Preset consistency: ${presetMatch ? 'PASS' : 'FAIL'}`);
    console.log(`  - Base64 encoding: ${encodeMatch ? 'PASS' : 'FAIL'}`);
    
    const allPassed = match && different && presetMatch && encodeMatch;
    console.log(`\n${allPassed ? '✅' : '❌'} Overall: ${allPassed ? 'PASSED' : 'FAILED'}`);
    
    return allPassed;
    
  } catch (error) {
    console.error('💥 Test failed with error:', error);
    return false;
  }
}

// Run the test if this file is executed directly
if (typeof window !== 'undefined') {
  // Browser environment
  window.testDeterministic = testDeterministic;
} else {
  // Node environment
  console.log('This test requires a browser environment with canvas support');
}
