/* SuperParticles – Core Physics & Arrays */

import { getActiveForces } from './plugin.js';
import type { Vec2 } from './types/plugin.js';

export interface Options {
  color?: string;
  speed?: number;
  particleCount?: number;
  deterministic?: boolean;
}

// Global plugin state that can be controlled from the playground
export const globalPluginState = {
  fireworksEnabled: false,
  gravityWellEnabled: false
};

// Debug state will be declared after N is defined

let N = 10_000; // Reduced from 50_000 for better performance
const dt = 1 / 60;                // Reduced from 1/120 for better performance
const rngSeed = 1337;              // repeatable look
let seed = rngSeed;
const rand = () => {
  seed = (seed * 9301 + 49297) % 233280;
  return seed / 233280; // Return value between 0 and 1
};

/* shared buffers */
let pos = new Float32Array(N * 2);   // x, y
let vel = new Float32Array(N * 2);   // vx, vy

// Comprehensive debug and validation state
export const debugState = {
  // Basic particle stats
  particleCount: 0,
  totalParticles: N,
  sampleSize: 0,
  
  // Plugin effectiveness
  fireworksParticles: 0,
  gravityWellParticles: 0,
  neutralParticles: 0,
  
  // Movement analysis
  averageSpeed: 0,
  maxSpeed: 0,
  minSpeed: 0,
  speedVariance: 0,
  
  // Position analysis
  centerDistance: 0,
  maxDistance: 0,
  minDistance: 0,
  distanceVariance: 0,
  
  // Direction analysis
  particlesMovingUp: 0,
  particlesMovingDown: 0,
  particlesMovingLeft: 0,
  particlesMovingRight: 0,
  
  // Force analysis
  fireworksForceApplied: 0,
  gravityWellForceApplied: 0,
  sineFieldForceApplied: 0,
  
  // Performance metrics
  frameTime: 0,
  physicsTime: 0,
  renderTime: 0,
  
  // System state
  screenWidth: 0,
  screenHeight: 0,
  centerX: 0,
  centerY: 0,
  
  // Plugin state
  fireworksEnabled: false,
  gravityWellEnabled: false,
  
  // Validation timing
  lastValidation: 0,
  validationCount: 0,
  
  // Debug control
  debugEnabled: true,
  detailedLogging: true,
  
  // System configuration
  deterministic: false
};

export function initArrays(w: number, h: number, speed: number, deterministic = false) {
  // Reset seed for deterministic mode
  if (deterministic) {
    seed = rngSeed;
  }
  
  // Update debug state
  debugState.deterministic = deterministic;
  
  console.log(`🔧 initArrays called with: w=${w}, h=${h}, speed=${speed}, deterministic=${deterministic}`);
  console.log(`🔧 Random seed: ${seed}, First few rand() values: ${rand()}, ${rand()}, ${rand()}`);
  
  // Reset seed again after logging
  seed = rngSeed;
  
  for (let i = 0; i < N; i++) {
    const ix = i << 1;
    const randX = rand();
    const randY = rand();
    pos[ix]     = randX * w;
    pos[ix + 1] = randY * h;
    
    // Log first few positions
    if (i < 3) {
      console.log(`🔧 Particle ${i}: randX=${randX}, randY=${randY} → pos[${ix}]=${pos[ix]}, pos[${ix+1}]=${pos[ix+1]}`);
    }
    
    // random dir, uniform speed
    const a = rand() * Math.PI * 2;
    vel[ix]     = Math.cos(a) * speed;
    vel[ix + 1] = Math.sin(a) * speed;
  }
}

export function resizeParticleBuffers(newN: number) {
  // Preserve existing data as much as possible
  const oldN = N;
  const oldPos = pos;
  const oldVel = vel;
  
  // Create new buffers with new size
  N = newN;
  pos = new Float32Array(N * 2);
  vel = new Float32Array(N * 2);
  
  // Copy existing data (as much as possible)
  const copyCount = Math.min(oldN, newN);
  pos.set(oldPos.subarray(0, copyCount * 2));
  vel.set(oldVel.subarray(0, copyCount * 2));
  
  // If expanding, initialize new particles
  if (newN > oldN) {
    // Re-seed if deterministic to maintain consistency
    if (debugState.deterministic) {
      seed = rngSeed;
    }
    
    for (let i = oldN; i < newN; i++) {
      const ix = i << 1;
      const randX = rand();
      const randY = rand();
      pos[ix] = randX * 800; // Default width
      pos[ix + 1] = randY * 600; // Default height
      
      // Random direction with default speed
      const a = rand() * Math.PI * 2;
      const defaultSpeed = 40;
      vel[ix] = Math.cos(a) * defaultSpeed;
      vel[ix + 1] = Math.sin(a) * defaultSpeed;
    }
  }
  
  // Update debug state
  debugState.totalParticles = N;
  
  console.log(`🔧 Resized particle buffers: ${oldN} → ${newN} particles`);
}

// Getter function for current particle count
export function getParticleCount(): number {
  return N;
}

// Comprehensive validation function to analyze every aspect of particle behavior
function validateParticleBehavior(w: number, h: number) {
  const startTime = performance.now();
  const centerX = w * 0.5;
  const centerY = h * 0.5;
  
  // Initialize comprehensive analysis variables
  let totalSpeed = 0, totalSpeedSquared = 0;
  let totalDistance = 0, totalDistanceSquared = 0;
  let maxSpeed = 0, minSpeed = Infinity;
  let maxDistance = 0, minDistance = Infinity;
  
  // Plugin effectiveness counters
  let fireworksCount = 0, gravityWellCount = 0, neutralCount = 0;
  let fireworksForceApplied = 0, gravityWellForceApplied = 0, sineFieldForceApplied = 0;
  
  // Direction analysis
  let movingUp = 0, movingDown = 0, movingLeft = 0, movingRight = 0;
  
  // Sample particles for analysis
  const sampleSize = Math.min(100, N);
  const step = Math.floor(N / sampleSize);
  
  // Update system state
  debugState.screenWidth = w;
  debugState.screenHeight = h;
  debugState.centerX = centerX;
  debugState.centerY = centerY;
  debugState.fireworksEnabled = globalPluginState.fireworksEnabled;
  debugState.gravityWellEnabled = globalPluginState.gravityWellEnabled;
  debugState.sampleSize = sampleSize;
  debugState.validationCount++;
  
  for (let i = 0; i < sampleSize; i++) {
    const particleIndex = i * step;
    const ix = particleIndex << 1;
    
    // === SPEED ANALYSIS ===
    const speed = Math.sqrt(vel[ix] * vel[ix] + vel[ix + 1] * vel[ix + 1]);
    totalSpeed += speed;
    totalSpeedSquared += speed * speed;
    maxSpeed = Math.max(maxSpeed, speed);
    minSpeed = Math.min(minSpeed, speed);
    
    // === POSITION ANALYSIS ===
    const dx = pos[ix] - centerX;
    const dy = pos[ix + 1] - centerY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    totalDistance += distance;
    totalDistanceSquared += distance * distance;
    maxDistance = Math.max(maxDistance, distance);
    minDistance = Math.min(minDistance, distance);
    
    // === DIRECTION ANALYSIS ===
    if (vel[ix + 1] > 0.1) movingUp++;
    if (vel[ix + 1] < -0.1) movingDown++;
    if (vel[ix] > 0.1) movingRight++;
    if (vel[ix] < -0.1) movingLeft++;
    
    // === PLUGIN EFFECTIVENESS ANALYSIS ===
    if (distance > 0) {
      // Fireworks analysis
      if (globalPluginState.fireworksEnabled) {
        const outwardVelocity = (dx * vel[ix] + dy * vel[ix + 1]) / distance;
        if (outwardVelocity > 0.05) {
          fireworksCount++;
        }
        
        // Calculate expected fireworks force
        const fireworksForceX = (dx / distance) * 5.0;
        const fireworksForceY = (dy / distance) * 5.0;
        if (Math.abs(fireworksForceX) > 0.1 || Math.abs(fireworksForceY) > 0.1) {
          fireworksForceApplied++;
        }
      }
      
      // Gravity well analysis
      if (globalPluginState.gravityWellEnabled) {
        const inwardVelocity = -(dx * vel[ix] + dy * vel[ix + 1]) / distance;
        if (inwardVelocity > 0.05) {
          gravityWellCount++;
        }
        
        // Calculate expected gravity well force
        const gravityForceX = (dx / distance) * 3.0;
        const gravityForceY = (dy / distance) * 3.0;
        if (Math.abs(gravityForceX) > 0.1 || Math.abs(gravityForceY) > 0.1) {
          gravityWellForceApplied++;
        }
      }
      
      // Sine field analysis
      const sineK = 0.002;
      const amp = 4;
      const sineForceX = Math.sin(pos[ix + 1] * sineK) * amp * dt;
      const sineForceY = Math.cos(pos[ix] * sineK) * amp * dt;
      if (Math.abs(sineForceX) > 0.01 || Math.abs(sineForceY) > 0.01) {
        sineFieldForceApplied++;
      }
    }
  }
  
  // Calculate neutral particles (not affected by plugins)
  neutralCount = sampleSize - fireworksCount - gravityWellCount;
  
  // Calculate variances
  const avgSpeed = totalSpeed / sampleSize;
  const avgDistance = totalDistance / sampleSize;
  const speedVariance = (totalSpeedSquared / sampleSize) - (avgSpeed * avgSpeed);
  const distanceVariance = (totalDistanceSquared / sampleSize) - (avgDistance * avgDistance);
  
  // Update comprehensive debug state
  debugState.particleCount = sampleSize;
  debugState.fireworksParticles = fireworksCount;
  debugState.gravityWellParticles = gravityWellCount;
  debugState.neutralParticles = neutralCount;
  
  debugState.averageSpeed = avgSpeed;
  debugState.maxSpeed = maxSpeed;
  debugState.minSpeed = minSpeed;
  debugState.speedVariance = speedVariance;
  
  debugState.centerDistance = avgDistance;
  debugState.maxDistance = maxDistance;
  debugState.minDistance = minDistance;
  debugState.distanceVariance = distanceVariance;
  
  debugState.particlesMovingUp = movingUp;
  debugState.particlesMovingDown = movingDown;
  debugState.particlesMovingLeft = movingLeft;
  debugState.particlesMovingRight = movingRight;
  
  debugState.fireworksForceApplied = fireworksForceApplied;
  debugState.gravityWellForceApplied = gravityWellForceApplied;
  debugState.sineFieldForceApplied = sineFieldForceApplied;
  
  debugState.lastValidation = Date.now();
  
  // === COMPREHENSIVE LOGGING ===
  if (debugState.detailedLogging) {
    console.log(`\n🔍 COMPREHENSIVE PARTICLE ANALYSIS (${sampleSize} particles)`);
    console.log(`================================================`);
    
    // System Information
    console.log(`📊 SYSTEM STATE:`);
    console.log(`   Screen: ${w}x${h} | Center: (${centerX.toFixed(0)}, ${centerY.toFixed(0)})`);
    console.log(`   Total Particles: ${N} | Sample Size: ${sampleSize}`);
    console.log(`   Fireworks: ${globalPluginState.fireworksEnabled ? 'ON' : 'OFF'}`);
    console.log(`   Gravity Well: ${globalPluginState.gravityWellEnabled ? 'ON' : 'OFF'}`);
    
    // Movement Analysis
    console.log(`\n🚀 MOVEMENT ANALYSIS:`);
    console.log(`   Speed Range: ${minSpeed.toFixed(1)} - ${maxSpeed.toFixed(1)}`);
    console.log(`   Average Speed: ${avgSpeed.toFixed(1)} | Variance: ${speedVariance.toFixed(1)}`);
    console.log(`   Direction: Up ${movingUp} | Down ${movingDown} | Left ${movingLeft} | Right ${movingRight}`);
    
    // Position Analysis
    console.log(`\n📍 POSITION ANALYSIS:`);
    console.log(`   Distance Range: ${minDistance.toFixed(0)} - ${maxDistance.toFixed(0)}`);
    console.log(`   Average Distance: ${avgDistance.toFixed(0)} | Variance: ${distanceVariance.toFixed(0)}`);
    
    // Plugin Effectiveness
    console.log(`\n⚡ PLUGIN EFFECTIVENESS:`);
    console.log(`   Fireworks Particles: ${fireworksCount}/${sampleSize} (${(fireworksCount/sampleSize*100).toFixed(1)}%)`);
    console.log(`   Gravity Well Particles: ${gravityWellCount}/${sampleSize} (${(gravityWellCount/sampleSize*100).toFixed(1)}%)`);
    console.log(`   Neutral Particles: ${neutralCount}/${sampleSize} (${(neutralCount/sampleSize*100).toFixed(1)}%)`);
    
    // Force Analysis
    console.log(`\n💪 FORCE ANALYSIS:`);
    console.log(`   Fireworks Force Applied: ${fireworksForceApplied}/${sampleSize} (${(fireworksForceApplied/sampleSize*100).toFixed(1)}%)`);
    console.log(`   Gravity Well Force Applied: ${gravityWellForceApplied}/${sampleSize} (${(gravityWellForceApplied/sampleSize*100).toFixed(1)}%)`);
    console.log(`   Sine Field Force Applied: ${sineFieldForceApplied}/${sampleSize} (${(sineFieldForceApplied/sampleSize*100).toFixed(1)}%)`);
    
    // Performance Warnings
    console.log(`\n⚠️  PERFORMANCE WARNINGS:`);
    if (avgSpeed > 100) {
      console.log(`   ⚠️  HIGH SPEED: Average speed ${avgSpeed.toFixed(1)} is above recommended 100`);
    }
    if (avgSpeed < 5) {
      console.log(`   ⚠️  LOW SPEED: Average speed ${avgSpeed.toFixed(1)} is below recommended 5`);
    }
    if (fireworksCount < sampleSize * 0.2 && globalPluginState.fireworksEnabled) {
      console.log(`   ⚠️  LOW FIREWORKS EFFECTIVENESS: Only ${(fireworksCount/sampleSize*100).toFixed(1)}% outward particles`);
    }
    if (gravityWellCount < sampleSize * 0.2 && globalPluginState.gravityWellEnabled) {
      console.log(`   ⚠️  LOW GRAVITY WELL EFFECTIVENESS: Only ${(gravityWellCount/sampleSize*100).toFixed(1)}% inward particles`);
    }
    
    // Analysis Summary
    console.log(`\n📈 ANALYSIS SUMMARY:`);
    const dominantForce = fireworksCount > gravityWellCount ? 'Fireworks' : 
                         gravityWellCount > fireworksCount ? 'Gravity Well' : 'Balanced';
    console.log(`   Dominant Force: ${dominantForce}`);
    console.log(`   Movement Quality: ${avgSpeed > 20 && avgSpeed < 80 ? 'Good' : 'Needs Adjustment'}`);
    console.log(`   Distribution Quality: ${avgDistance > w * 0.2 && avgDistance < w * 0.8 ? 'Good' : 'Needs Adjustment'}`);
    
    console.log(`\n⏱️  Analysis completed in ${(performance.now() - startTime).toFixed(2)}ms`);
    console.log(`================================================\n`);
  }
}

export function stepPhysics(w: number, h: number) {
  const sineK = 0.002;
  const amp   = 4;
  const maxSpeed = 100; // Speed limit to prevent infinite acceleration
  const damping = 0.99; // Reduced damping for better performance
  
  for (let i = 0; i < N; i++) {
    const ix = i << 1;
    
    // Apply active plugin forces first
    const particlePos: Vec2 = { x: pos[ix], y: pos[ix + 1] };
    const activeForces = getActiveForces();
    for (const force of activeForces) {
      force(particlePos, i);
    }
    
    // Apply fireworks force if enabled - use actual screen dimensions
    if (globalPluginState.fireworksEnabled) {
      const centerX = w * 0.5;  // Center of screen width
      const centerY = h * 0.5;  // Center of screen height
      const dx = particlePos.x - centerX;
      const dy = particlePos.y - centerY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > 0) {
        // Fireworks effect - particles move outward
        const fireworksStrength = globalPluginState.gravityWellEnabled ? 4.0 : 5.0; // Keep strong when both active
        particlePos.x += (dx / distance) * fireworksStrength;
        particlePos.y += (dy / distance) * fireworksStrength;
      }
    }
    
    // Apply gravity well force if enabled - use actual screen dimensions
    if (globalPluginState.gravityWellEnabled) {
      const centerX = w * 0.5;  // Center of screen width
      const centerY = h * 0.5;  // Center of screen height
      const dx = centerX - particlePos.x; // Direction TO center (opposite of fireworks)
      const dy = centerY - particlePos.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > 0) {
        // Gravity well effect - particles move toward center
        // When both active, make gravity well distance-dependent for more interesting behavior
        let gravityStrength = 3.0;
        if (globalPluginState.fireworksEnabled) {
          // Stronger gravity well for particles closer to center, weaker for distant particles
          const normalizedDistance = Math.min(distance / (Math.max(w, h) * 0.5), 1.0);
          gravityStrength = 2.0 + (normalizedDistance * 3.0); // 2.0 to 5.0 based on distance
        }
        particlePos.x += (dx / distance) * gravityStrength;
        particlePos.y += (dy / distance) * gravityStrength;
      }
    }
    
    // Update velocity from plugin forces
    vel[ix]     += particlePos.x - pos[ix];
    vel[ix + 1] += particlePos.y - pos[ix + 1];
    
    // steer by sine field
    vel[ix]     += Math.sin(pos[ix + 1] * sineK) * amp * dt;
    vel[ix + 1] += Math.cos(pos[ix]     * sineK) * amp * dt;

    // Apply velocity damping to prevent infinite acceleration (simplified)
    vel[ix]     *= damping;
    vel[ix + 1] *= damping;
    
    // Apply speed limit (only when needed)
    const currentSpeed = Math.sqrt(vel[ix] * vel[ix] + vel[ix + 1] * vel[ix + 1]);
    if (currentSpeed > maxSpeed) {
      const scale = maxSpeed / currentSpeed;
      vel[ix]     *= scale;
      vel[ix + 1] *= scale;
    }

    // Integrate position with edge-respecting bounce instead of wrap-around
    const elasticity = 0.9; // 1.0 is perfectly elastic, <1.0 loses a bit of energy
    let nextX = pos[ix]     + vel[ix]     * dt;
    let nextY = pos[ix + 1] + vel[ix + 1] * dt;

    if (nextX < 0) {
      nextX = 0;
      vel[ix] = -vel[ix] * elasticity;
    } else if (nextX > w) {
      nextX = w;
      vel[ix] = -vel[ix] * elasticity;
    }

    if (nextY < 0) {
      nextY = 0;
      vel[ix + 1] = -vel[ix + 1] * elasticity;
    } else if (nextY > h) {
      nextY = h;
      vel[ix + 1] = -vel[ix + 1] * elasticity;
    }

    pos[ix]     = nextX;
    pos[ix + 1] = nextY;
  }
  
  // Run validation only when manually triggered
  if (debugState.debugEnabled && Math.random() < 0.1) { // 10% chance when enabled = immediate trigger
    validateParticleBehavior(w, h);
    debugState.debugEnabled = false; // Disable after one run
  }
}

export { pos, vel, N, dt }; 