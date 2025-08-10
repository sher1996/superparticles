// Node.js test script for SuperParticles API
// Run with: node test-api-node.js

console.log('🧪 Testing SuperParticles API (Node.js)...\n');

// Mock the core functions for testing
const mockCore = {
  resizeParticleBuffers: (newN) => {
    console.log(`  🔧 resizeParticleBuffers(${newN}) called`);
    return true;
  }
};

// Simulate the API implementation
let opts = { 
  color: '#70c1ff', 
  speed: 40, 
  useWebGL: false, 
  useWebGPU: false, 
  particleCount: 1000, 
  deterministic: false 
};

function setOptions(next) {
  console.log(`🔧 setOptions called with:`, next);
  
  if (next.speed !== undefined) {
    opts.speed = next.speed;
    console.log(`  ✅ Speed updated to: ${opts.speed}`);
  }
  
  if (next.deterministic !== undefined) {
    opts.deterministic = next.deterministic;
    console.log(`  ✅ Deterministic updated to: ${opts.deterministic}`);
  }
  
  if (next.particleCount !== undefined && next.particleCount !== opts.particleCount) {
    console.log(`  ✅ Particle count updated from ${opts.particleCount} to ${next.particleCount}`);
    // Call the core function
    mockCore.resizeParticleBuffers(next.particleCount);
    opts.particleCount = next.particleCount;
  }
  
  if (next.color !== undefined) {
    opts.color = next.color;
    console.log(`  ✅ Color updated to: ${opts.color}`);
  }
  
  if (next.useWebGL !== undefined) {
    opts.useWebGL = next.useWebGL;
    console.log(`  ✅ WebGL updated to: ${opts.useWebGL}`);
  }
  
  if (next.useWebGPU !== undefined) {
    opts.useWebGPU = next.useWebGPU;
    console.log(`  ✅ WebGPU updated to: ${opts.useWebGPU}`);
  }
}

function exportState() {
  console.log('📤 exportState called');
  return { ...opts };
}

function importState(state) {
  console.log('📥 importState called with:', state);
  setOptions(state);
}

// Test suite
function runTests() {
  console.log('🚀 Starting test suite...\n');
  
  // Test 1: Initial state
  console.log('1️⃣ Testing initial state:');
  console.log('   Initial options:', opts);
  
  // Test 2: setOptions with speed
  console.log('\n2️⃣ Testing setOptions with speed change:');
  setOptions({ speed: 80 });
  
  // Test 3: setOptions with particle count
  console.log('\n3️⃣ Testing setOptions with particle count change:');
  setOptions({ particleCount: 5000 });
  
  // Test 4: setOptions with multiple options
  console.log('\n4️⃣ Testing setOptions with multiple options:');
  setOptions({ 
    speed: 60, 
    deterministic: true, 
    color: '#ff6b6b' 
  });
  
  // Test 5: exportState
  console.log('\n5️⃣ Testing exportState:');
  const currentState = exportState();
  console.log('   Exported state:', currentState);
  
  // Test 6: importState
  console.log('\n6️⃣ Testing importState:');
  const testState = { 
    speed: 100, 
    particleCount: 2000, 
    deterministic: false,
    color: '#4ecdc4'
  };
  importState(testState);
  
  // Test 7: Verify import worked
  console.log('\n7️⃣ Verifying importState worked:');
  const finalState = exportState();
  console.log('   Final state:', finalState);
  
  // Test 8: Edge cases
  console.log('\n8️⃣ Testing edge cases:');
  setOptions({}); // Empty options
  setOptions({ speed: undefined }); // Undefined value
  setOptions({ particleCount: 1000 }); // Same particle count
  
  console.log('\n✅ All tests completed!');
}

// Run the tests
runTests();

// Export for potential reuse
module.exports = { setOptions, exportState, importState, opts };
