# SuperParticles Playground

The playground lets you try particle settings and plugins interactively. To run it, build and serve the repo (`npm run build && npm start`), then open <http://localhost:8000/playground/>.

## Controls

### Renderer
- **Canvas2D**: CPU drawing, works everywhere.
- **WebGL2**: GPU drawing with round particles and shader plugins.
- **WebGPU**: GPU drawing with shader plugins. This is experimental and needs a browser with WebGPU enabled.

If a renderer isn't available, the playground falls back (WebGPU → WebGL2 → Canvas2D) and shows a note under the buttons.

### Speed
- Range: 1–100.
- Rescales particle velocities immediately.

### Particles
- Range: 100–20,000.
- Can be changed while running. Existing particles stay where they are and new ones spawn across the whole canvas.

### Size
- Particle size in CSS pixels (1–8).

### Deterministic
- When on, particles respawn from a fixed seed, so the same preset gives the same starting layout on any machine.
- Toggling it re-scatters the particles.

### Color
- Changes the particle color immediately in every renderer.

## Plugins

### Force plugins
- **Fireworks Force**: pushes particles outward from the center.
- **Gravity Well Force**: pulls particles toward the center.

Turning both on makes them roughly cancel out.

### Shader plugins
- **Gravity Well Shader**: makes particles dimmer the closer they are to the center. Works in WebGL2 and WebGPU only, since Canvas2D has no shaders.

## Keyboard Shortcuts

All effect and checkbox settings in the control panel can be toggled via keyboard keys positioned conveniently on the left-hand side (`cvfdrsreaq` area):

| Key | Effect / Setting | Description |
| --- | --- | --- |
| <kbd>F</kbd> (or <kbd>Q</kbd>) | **Fireworks Force** | Toggles pushing particles outward |
| <kbd>V</kbd> (or <kbd>W</kbd> / <kbd>G</kbd>) | **Gravity Well Force** | Toggles pulling particles toward the center |
| <kbd>S</kbd> (or <kbd>E</kbd>) | **Gravity Well Shader** | Toggles center dimming shader (WebGL2/WebGPU) |
| <kbd>D</kbd> (or <kbd>A</kbd>) | **Deterministic** | Toggles fixed seed random layout |
| <kbd>C</kbd> | **Color** | Cycles through color presets |
| <kbd>R</kbd> | **Reset** | Restores default settings |

## Presets

- **Copy URL**: encodes the current settings and active plugins into the URL hash, so you can share them.
- **Reset**: restores the defaults, turns off all plugins and switches back to Canvas2D.

## Persistence

Settings and active plugins are saved to `localStorage` and restored on the next visit. A preset URL overrides the saved settings.
