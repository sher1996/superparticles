"""Train the 3D voxel NCA (Chapter 7 proof of concept).

    python training/train3d.py --steps 1500 --out training/runs/planet3d

Same pool + damage recipe as train.py; see that file for the reasoning.
"""

import argparse
import json
import random
import time
from pathlib import Path

import numpy as np
import torch

from nca import lr_schedule
from nca3d import NCA3D, TARGETS3D, damage, seed_state


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default="planet", choices=sorted(TARGETS3D))
    ap.add_argument("--size", type=int, default=16)
    ap.add_argument("--steps", type=int, default=1500)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--pool", type=int, default=256)
    ap.add_argument("--damage", type=int, default=1)
    ap.add_argument("--rollout", type=int, nargs=2, default=[32, 48])
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default="training/runs/planet3d")
    ap.add_argument("--resume", action="store_true")
    args = ap.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    gen = torch.Generator().manual_seed(args.seed + 1)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    target = torch.from_numpy(TARGETS3D[args.target](args.size))
    model = NCA3D()
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    pool = seed_state(args.pool, args.size)
    config = {**vars(args), "dims": 3, "params": model.param_count(), "torch": str(torch.__version__)}
    (out / "config.json").write_text(json.dumps(config, indent=2))
    print(json.dumps(config), flush=True)

    start = 0
    ckpt_path = out / "checkpoint.pt"
    if args.resume and ckpt_path.exists():
        ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)  # our own checkpoint
        model.load_state_dict(ckpt["model"])
        opt.load_state_dict(ckpt["opt"])
        start = ckpt["step"] + 1
        gen.manual_seed(args.seed + 1 + start)
        print(f"resumed from step {ckpt['step']}", flush=True)

    log = open(out / "log.jsonl", "a")
    t0 = time.time()
    for step in range(start, args.steps):
        for g in opt.param_groups:
            g["lr"] = lr_schedule(step, args.steps, args.lr)
        idx = torch.randint(0, args.pool, (args.batch,), generator=gen)
        x = pool[idx].clone()
        with torch.no_grad():
            per = ((x[:, :4] - target) ** 2).mean(dim=(1, 2, 3, 4))
            order = per.argsort(descending=True)
            x, idx = x[order], idx[order]
            x[:1] = seed_state(1, args.size)
            if args.damage and step > 200:  # learn to grow first, then to heal
                x[-args.damage:] = damage(x[-args.damage:], gen)
        n_iter = random.randint(*args.rollout)
        for _ in range(n_iter):
            x = model(x)
        loss = ((x[:, :4] - target) ** 2).mean()
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
            rec = {"step": step, "loss": loss.item(), "iters": n_iter, "elapsed": round(time.time() - t0, 1)}
            log.write(json.dumps(rec) + "\n")
            log.flush()
            print(json.dumps(rec), flush=True)
        if step % 100 == 0 or step == args.steps - 1:
            tmp = out / "checkpoint.tmp"
            torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "step": step, "config": config}, tmp)
            tmp.replace(ckpt_path)
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
