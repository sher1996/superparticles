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
from targets import TARGETS


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default="heart", choices=sorted(TARGETS))
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
    args = ap.parse_args()

    if args.threads:
        torch.set_num_threads(args.threads)
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    gen = torch.Generator().manual_seed(args.seed + 1)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    target = torch.from_numpy(TARGETS[args.target](args.size, args.pad))
    model = NCA()
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    pool = seed_state(args.pool, args.size)

    log = open(out / "log.jsonl", "a")
    config = {**vars(args), "params": model.param_count(), "torch": str(torch.__version__)}
    (out / "config.json").write_text(json.dumps(config, indent=2))
    print(json.dumps(config))

    t0 = time.time()
    for step in range(args.steps):
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
        if step % 250 == 0 or step == args.steps - 1:
            torch.save({"model": model.state_dict(), "step": step, "config": config}, out / "checkpoint.pt")

    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
