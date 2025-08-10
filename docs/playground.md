# SuperParticles Playground

The SuperParticles playground provides an interactive interface to experiment with particle system parameters and plugins.

## Controls

### Renderer Selection
- **Canvas2D**: CPU-based rendering, compatible everywhere
- **WebGL2**: GPU-accelerated rendering, modern browsers
- **WebGPU**: Next-gen GPU rendering, experimental

### Speed Slider
- Range: 1-100
- Changes particle motion speed instantly
- Affects all active force plugins

### Particle Count
- Range: 100-5000 particles
- Can be adjusted while running
- Automatically resizes buffers without crashes or memory leaks

### Deterministic Toggle
- When enabled: identical preset links render identically on any machine
- Uses fixed random seed for reproducible behavior
- Essential for sharing consistent presets

### Color Picker
- Changes particle color in real-time
- Supports any valid CSS color value

## Plugins

### Force Plugins
- **Fireworks Force**: Creates explosive outward forces
- **Gravity Well Force**: Attracts particles to center points

### Shader Plugins
- **Gravity Well Shader**: Visual shader effects for gravity wells

## Presets

### Copy Preset URL
- Captures current settings and active plugins
- Encodes configuration in URL hash
- Share exact configurations with others

### Reset
- Restores default settings
- Clears all active plugins
- Returns to Canvas2D renderer

## Persistence

- All settings automatically save to localStorage
- Plugin states are preserved between sessions
- Preset URLs work across different machines

## Performance

- FPS counter shows real-time performance
- Particle count automatically adjusts for device capabilities
- Renderer switching maintains visual consistency
