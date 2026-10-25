"""Measure growth, persistence and regeneration of a trained NCA.

    python training/evaluate.py training/runs/heart/checkpoint.pt

Writes metrics.json next to the checkpoint and renders a contact sheet (evaluation.png).
All rollouts use the deterministic hash fire mask, so results are exactly reproducible.

Metrics (thresholds are the project's Chapter 6 gates, see docs/research/chapter-6-nca.md):
  growth_iou      IoU of alpha>0.1 vs target after 200 steps from the seed
  persist_iou     IoU after 1000 steps (does the shape stay stable?)
  recovery_iou    mean IoU 128 steps after cutting a hole, over 16 hole positions
  recovered_frac  fraction of those holes with recovery IoU >= 0.80
  nan_free        no NaN/inf in any rollout
Diagnostics (not gates):
  growth_iou_solid    IoU at alpha > 0.5, ignoring the faint fringe a soft-edged model grows
  recovery_vs_intact  recovery IoU / growth IoU: how much of its own undamaged shape it regrows
"""

import json
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from nca import NCA, hash_fire_mask, iou, seed_state, to_rgba
from targets import TARGETS, from_image


def rgba_image(x: torch.Tensor) -> Image.Image:
    a = to_rgba(x[0]).numpy().transpose(1, 2, 0)
    rgb = a[..., :3] + (1 - a[..., 3:4])  # composite premultiplied over white
    return Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).resize((128, 128), Image.NEAREST)


def run(model, x, start, steps, seed):
    size = x.shape[-1]
    for s in range(start, start + steps):
        x = model(x, hash_fire_mask(size, size, s, seed))
    return x


def cut(x, cx, cy, r):
    size = x.shape[-1]
    yy, xx = np.meshgrid(np.arange(size), np.arange(size), indexing="ij")
    m = torch.from_numpy(((xx - cx) ** 2 + (yy - cy) ** 2) < r * r)
    x = x.clone()
    x[:, :, m] = 0
    return x


def main() -> None:
    ckpt_path = Path(sys.argv[1])
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)  # our own checkpoints
    cfg = ckpt["config"]
    model = NCA()
    model.load_state_dict(ckpt["model"])
    model.eval()
    t = cfg["target"]
    target = torch.from_numpy(TARGETS[t](cfg["size"], cfg["pad"]) if t in TARGETS else from_image(t, cfg["size"], cfg["pad"]))
    size, seed = cfg["size"], 7

    with torch.no_grad():
        x = run(model, seed_state(1, size), 0, 200, seed)
        grown = x
        growth = iou(to_rgba(x[0]), target)
        growth_solid = iou(to_rgba(x[0]), target, threshold=0.5)
        x1000 = run(model, x, 200, 800, seed)
        persist = iou(to_rgba(x1000[0]), target)
        finite = bool(torch.isfinite(x1000).all())

        recov, sheet = [], [rgba_image(grown), rgba_image(x1000)]
        rng = np.random.default_rng(0)
        inner = size - 2 * cfg["pad"]
        for i in range(16):
            cx, cy = rng.integers(cfg["pad"], cfg["pad"] + inner, size=2)
            r = inner * rng.uniform(0.15, 0.3)
            d = cut(grown, cx, cy, r)
            healed = run(model, d, 200, 128, seed + i + 1)
            finite &= bool(torch.isfinite(healed).all())
            recov.append(iou(to_rgba(healed[0]), target))
            if i < 4:
                sheet += [rgba_image(d), rgba_image(healed)]

    metrics = {
        "growth_iou": round(growth, 4),
        "persist_iou": round(persist, 4),
        "recovery_iou": round(float(np.mean(recov)), 4),
        "recovery_min": round(float(np.min(recov)), 4),
        "recovered_frac": round(float(np.mean([r >= 0.8 for r in recov])), 4),
        "nan_free": finite,
        "growth_iou_solid": round(growth_solid, 4),
        "recovery_vs_intact": round(float(np.mean(recov)) / max(growth, 1e-6), 4),
        "checkpoint_step": ckpt["step"],
    }
    gates = {
        "growth_iou>=0.85": metrics["growth_iou"] >= 0.85,
        "recovery_iou>=0.80": metrics["recovery_iou"] >= 0.80,
        "nan_free": metrics["nan_free"],
    }
    metrics["gates"] = gates
    (ckpt_path.parent / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(json.dumps(metrics, indent=2))

    w = Image.new("RGB", (128 * len(sheet), 128), "white")
    for i, im in enumerate(sheet):
        w.paste(im, (128 * i, 0))
    w.save(ckpt_path.parent / "evaluation.png")


if __name__ == "__main__":
    main()
