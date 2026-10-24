"""Measure growth, persistence and regeneration of a trained 3D voxel NCA.

    python training/evaluate3d.py training/runs/planet3d/checkpoint.pt

Same metrics as evaluate.py, adapted to 16^3: growth IoU after 150 steps,
persistence after 600, recovery 150 steps after (a) cutting away the front
half and (b) 8 random ball-shaped holes. Uses the hashed runtime mask.
"""

import json
import sys
from pathlib import Path

import numpy as np
import torch

from nca3d import NCA3D, TARGETS3D, hash_fire_mask3d, iou3d, seed_state


def run(model, x, start, steps, seed):
    size = x.shape[-1]
    for s in range(start, start + steps):
        x = model(x, hash_fire_mask3d(size, s, seed))
    return x


def main():
    ckpt_path = Path(sys.argv[1])
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)  # our own checkpoint
    cfg = ckpt["config"]
    model = NCA3D()
    model.load_state_dict(ckpt["model"])
    size, seed = cfg["size"], 7
    target = torch.from_numpy(TARGETS3D[cfg["target"]](size))
    with torch.no_grad():
        grown = run(model, seed_state(1, size), 0, 150, seed)
        growth = iou3d(grown[0, :4], target)
        growth_solid = iou3d(grown[0, :4], target, threshold=0.5)
        later = run(model, grown, 150, 450, seed)
        persist = iou3d(later[0, :4], target)
        finite = bool(torch.isfinite(later).all())

        half = grown.clone()
        half[:, :, : size // 2] = 0
        healed_half = run(model, half, 150, 150, seed + 1)
        recov_half = iou3d(healed_half[0, :4], target)

        rng = np.random.default_rng(0)
        zz, yy, xx = np.meshgrid(*(np.arange(size),) * 3, indexing="ij")
        recov = []
        for i in range(8):
            c = rng.uniform(size * 0.25, size * 0.75, 3)
            r = size * rng.uniform(0.15, 0.25)
            m = torch.from_numpy(((xx - c[0]) ** 2 + (yy - c[1]) ** 2 + (zz - c[2]) ** 2) < r * r)
            d = grown.clone()
            d[:, :, m] = 0
            h = run(model, d, 150, 150, seed + 10 + i)
            finite &= bool(torch.isfinite(h).all())
            recov.append(iou3d(h[0, :4], target))

    metrics = {
        "growth_iou": round(growth, 4),
        "growth_iou_solid": round(growth_solid, 4),
        "persist_iou": round(persist, 4),
        "recovery_half_iou": round(recov_half, 4),
        "recovery_iou": round(float(np.mean(recov)), 4),
        "recovery_min": round(float(np.min(recov)), 4),
        "recovery_vs_intact": round(float(np.mean(recov)) / max(growth, 1e-6), 4),
        "nan_free": finite,
        "checkpoint_step": ckpt["step"],
    }
    metrics["gates"] = {
        "growth_iou>=0.85": metrics["growth_iou"] >= 0.85,
        "recovery_iou>=0.80": metrics["recovery_iou"] >= 0.80,
        "nan_free": finite,
    }
    (ckpt_path.parent / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(json.dumps(metrics, indent=2))


if __name__ == "__main__":
    main()
