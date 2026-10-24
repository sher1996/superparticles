# Training Smart Particles models

These scripts train the neural cellular automata (NCA) used by `superparticles/nca`.
A model is a single small network (about 8,000 weights) that every cell runs on its
own neighbourhood. Trained the right way, those local updates grow a target shape
from one seed cell, keep it stable, and regrow it after damage.

The recipe follows *Growing Neural Cellular Automata* (Mordvintsev et al., Distill 2020);
`docs/research/chapter-6-nca.md` explains the design choices and results.

## Setup

```bash
python -m venv .venv
. .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r training/requirements.txt
```

A GPU helps but is not required: the shipped heart model was trained on 4 CPU cores.

## Train, evaluate, export (2D)

```bash
cd training
python train.py --target heart --steps 3000 --out runs/heart        # ~2 h on 4 CPU cores
python evaluate.py runs/heart/checkpoint.pt                          # writes metrics.json + evaluation.png
python export.py runs/heart/checkpoint.pt ../models/heart.nca.json   # float16 weights + parity vectors
```

- `--resume` continues from `runs/<name>/checkpoint.pt` after an interruption.
- Targets live in `targets.py` (drawn procedurally, so runs are reproducible). Add your
  own function returning a `(4, H, W)` premultiplied RGBA array and register it in `TARGETS`.
- `--damage 0` trains growth only (no regeneration).

`evaluate.py` uses the same hashed update mask as the browser runtimes, so its numbers
are exactly what the shipped model does in the browser with the same seed.

| Metric | Meaning | Gate |
|---|---|---|
| `growth_iou` | overlap of visible cells with the target after 200 steps from the seed | ≥ 0.85 |
| `persist_iou` | the same after 1,000 steps (does it stay stable?) | — |
| `recovery_iou` | mean overlap 128 steps after cutting one of 16 random holes | ≥ 0.80 |
| `recovered_frac` | share of those holes that reach ≥ 0.80 | — |
| `nan_free` | no NaN or infinity in any rollout | required |

## 3D voxel models (Chapter 7 proof of concept)

```bash
python train3d.py --steps 1500 --out runs/planet3d
python export3d.py runs/planet3d/checkpoint.pt ../models/planet3d.nca.json --ply runs/planet3d/ply
```

`--ply` writes a grow → cut in half → heal sequence of coloured point clouds
(`frame_000.ply` …) that Blender (*File → Import → Stanford PLY*) or MeshLab can open.

## Model format

`superparticles-nca` version 1 is a JSON file with the network shape, update
constants, base64 weights (`float16` by default) and a `sha256` of the weight bytes.
See the header of `export.py` (2D) and `export3d.py` (3D) for the exact layout, and
`src/nca/model.ts` for the loader. Each export also writes `*.vectors.json`: an input
state and the exact output after a few seeded steps, which the JavaScript, WebGL2 and
WebGPU implementations are tested against.
