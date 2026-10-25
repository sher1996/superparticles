"""Train an NCA to grow a target image from one seed cell, hold it, and regrow after damage.

Usage:
    python training/train.py --target heart --steps 4000 --out training/runs/heart

Training recipe (Distill 2020, "regenerating" experiment):
  * a pool of states; each batch is sampled from the pool and written back,
    so the model also learns to *keep* the shape over long horizons
  * the worst sample in each batch is reset to the seed (keeps growth learnable)
  * the best few samples are damaged with a random circle (teaches repair)
  * per-parameter gradient normalisation, Adam, warmup + cosine LR
"""

import argparse
import json
import random
import time
from pathlib import Path

import numpy as np
import torch

from nca import NCA, damage, lr_schedule, seed_state, to_rgba
from targets import TARGETS, from_image


def load_target(name: str, size: int, pad: int):
    return TARGETS[name](size, pad) if name in TARGETS else from_image(name, size, pad)


def snapshot(model, size, step, folder):
    """Grow from a seed with the current weights (deterministic mask) and save what it makes."""
    from PIL import Image
    from nca import hash_fire_mask
    folder.mkdir(parents=True, exist_ok=True)
    with torch.no_grad():
        x = seed_state(1, size)
        for s in range(150):
            x = model(x, hash_fire_mask(size, size, s, 7))
    a = x[0, :4].clamp(0, 1).numpy().transpose(1, 2, 0)
    rgb = a[..., :3] + (1 - a[..., 3:4]) * 0.06  # premultiplied colour over a dark background
    Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).resize((128, 128), Image.NEAREST).save(folder / f"step_{step:05d}.png")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default="heart", help=f"one of {sorted(TARGETS)}, or a path to an RGBA image")
    ap.add_argument("--size", type=int, default=64)
    ap.add_argument("--pad", type=int, default=12)
    ap.add_argument("--steps", type=int, default=4000)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--pool", type=int, default=1024)
    ap.add_argument("--damage", type=int, default=3, help="samples per batch to damage (0 = growth only)")
    ap.add_argument("--rollout", type=int, nargs=2, default=[64, 96])
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--out", default="training/runs/heart")
    ap.add_argument("--resume", action="store_true", help="continue from <out>/checkpoint.pt")
    ap.add_argument("--snapshot-every", type=int, default=0,
                    help="every N steps, grow from a seed with the current weights and save a picture (training timeline)")
    args = ap.parse_args()

    if args.threads:
        torch.set_num_threads(args.threads)
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    gen = torch.Generator().manual_seed(args.seed + 1)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    target = torch.from_numpy(load_target(args.target, args.size, args.pad))
    model = NCA()
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    pool = seed_state(args.pool, args.size)

    log = open(out / "log.jsonl", "a")
    config = {**vars(args), "params": model.param_count(), "torch": str(torch.__version__)}
    (out / "config.json").write_text(json.dumps(config, indent=2))
    print(json.dumps(config))

    start = 0
    ckpt_path = out / "checkpoint.pt"
    if args.resume and ckpt_path.exists():
        ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)  # our own checkpoint
        model.load_state_dict(ckpt["model"])
        if "opt" in ckpt:
            opt.load_state_dict(ckpt["opt"])
        start = ckpt["step"] + 1
        gen.manual_seed(args.seed + 1 + start)
        print(f"resumed from step {ckpt['step']}", flush=True)

    t0 = time.time()
    for step in range(start, args.steps):
        for g in opt.param_groups:
            g["lr"] = lr_schedule(step, args.steps, args.lr)

        idx = torch.randint(0, args.pool, (args.batch,), generator=gen)
        x = pool[idx].clone()
        with torch.no_grad():
            per = ((to_rgba(x) - target) ** 2).mean(dim=(1, 2, 3))
            order = per.argsort(descending=True)
            x = x[order]
            idx = idx[order]
            x[:1] = seed_state(1, args.size)
            if args.damage:
                x[-args.damage:] = damage(x[-args.damage:], gen)

        n_iter = random.randint(*args.rollout)
        for _ in range(n_iter):
            x = model(x)

        loss = ((to_rgba(x) - target) ** 2).mean()
        opt.zero_grad()
        loss.backward()
        with torch.no_grad():
            for p in model.parameters():
                if p.grad is not None:
                    p.grad /= p.grad.norm() + 1e-8
        opt.step()

        with torch.no_grad():
            pool[idx] = x.detach()

        if step % 20 == 0 or step == args.steps - 1:
            rec = {"step": step, "loss": loss.item(), "lr": opt.param_groups[0]["lr"], "iters": n_iter,
                   "elapsed": round(time.time() - t0, 1)}
            log.write(json.dumps(rec) + "\n")
            log.flush()
            print(json.dumps(rec), flush=True)
        if args.snapshot_every and (step % args.snapshot_every == 0 or step == args.steps - 1):
            snapshot(model, args.size, step, out / "snapshots")
        if step % 250 == 0 or step == args.steps - 1:
            tmp = out / "checkpoint.tmp"
            torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "step": step, "config": config}, tmp)
            tmp.replace(ckpt_path)  # atomic: a crash mid-save never corrupts the checkpoint

    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
