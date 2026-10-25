"""Measure how well a learned swarm assembles, holds and re-assembles its shape.

    python training/evaluate_swarm.py training/runs/swarm-heart/checkpoint.pt

Deterministic (hashed update mask, fixed blobs). Metrics:
  assemble_coverage  share of target points with a particle within 0.06, 150 steps from a blob
  assemble_chamfer   symmetric mean squared nearest-neighbour distance at that point
  persist_coverage   coverage after 600 steps
  recover_coverage   mean coverage 150 steps after pushing a random third of the swarm apart (8 trials)
  recover_vs_intact  recover_coverage / assemble_coverage
Writes metrics.json and evaluation.png next to the checkpoint.
"""

import json
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw

from swarm import Swarm, blob, chamfer, coverage, hash_fire, scatter, target_points


def run(model, pos, st, start, steps, seed):
    n = pos.shape[1]
    for s in range(start, start + steps):
        pos, st = model(pos, st, hash_fire(n, s, seed))
    return pos, st


def picture(pos, st, size=160):
    img = Image.new("RGB", (size, size), "black")
    d = ImageDraw.Draw(img)
    for (x, y), c in zip(pos[0].tolist(), st[0, :, :3].clamp(0, 1).tolist()):
        px, py = (x + 1.1) / 2.2 * size, (y + 1.1) / 2.2 * size
        d.ellipse([px - 2, py - 2, px + 2, py + 2], fill=tuple(int(v * 255) for v in c))
    return img


def main():
    ckpt_path = Path(sys.argv[1])
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)  # our own checkpoint
    cfg = ckpt["config"]
    model = Swarm()
    model.load_state_dict(ckpt["model"])
    tpts, _ = target_points(cfg["target"])
    n, seed = cfg["particles"], 7
    g = torch.Generator().manual_seed(123)
    with torch.no_grad():
        pos, st = blob(1, n, g)
        sheet = [picture(pos, st)]
        pos, st = run(model, pos, st, 0, 150, seed)
        sheet.append(picture(pos, st))
        cov = coverage(pos, tpts).item()
        ch = chamfer(pos, tpts)[0].item()
        lp, ls = run(model, pos, st, 150, 450, seed)
        persist = coverage(lp, tpts).item()
        finite = bool(torch.isfinite(lp).all() and torch.isfinite(ls).all())
        rec = []
        for i in range(8):
            gi = torch.Generator().manual_seed(1000 + i)
            dp = scatter(pos, gi)
            hp, hs = run(model, dp, st, 150, 150, seed + 1 + i)
            rec.append(coverage(hp, tpts).item())
            if i < 2:
                sheet += [picture(dp, st), picture(hp, hs)]
    metrics = {
        "assemble_coverage": round(cov, 4),
        "assemble_chamfer": round(ch, 5),
        "persist_coverage": round(persist, 4),
        "recover_coverage": round(float(np.mean(rec)), 4),
        "recover_min": round(float(np.min(rec)), 4),
        "recover_vs_intact": round(float(np.mean(rec)) / max(cov, 1e-6), 4),
        "nan_free": finite,
        "checkpoint_step": ckpt["step"],
    }
    (ckpt_path.parent / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(json.dumps(metrics, indent=2))
    w = Image.new("RGB", (160 * len(sheet), 160))
    for i, im in enumerate(sheet):
        w.paste(im, (160 * i, 0))
    w.save(ckpt_path.parent / "evaluation.png")


if __name__ == "__main__":
    main()
