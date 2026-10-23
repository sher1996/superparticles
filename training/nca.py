"""Neural cellular automaton (NCA) model shared by training, evaluation and export.

Architecture follows "Growing Neural Cellular Automata" (Mordvintsev et al., Distill 2020):
every cell holds C channels (RGBA + hidden), perceives itself and its 3x3 neighbourhood
through fixed identity + Sobel filters, and updates with one small shared MLP
(1x1 convolutions). Cells update stochastically and only "alive" cells (or their
neighbours) take part, so the pattern has to grow outward from a seed.

The forward pass here is the reference definition that the JavaScript and GPU
implementations must reproduce (see test vectors written by export.py).
"""

import math

import torch
import torch.nn as nn
import torch.nn.functional as F

CHANNELS = 16
HIDDEN = 128
FIRE_RATE = 0.5
ALIVE_THRESHOLD = 0.1


def _filters(channels: int) -> torch.Tensor:
    ident = torch.tensor([[0.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 0.0]])
    sobel_x = torch.tensor([[-1.0, 0.0, 1.0], [-2.0, 0.0, 2.0], [-1.0, 0.0, 1.0]]) / 8.0
    sobel_y = sobel_x.T
    k = torch.stack([ident, sobel_x, sobel_y])  # (3, 3, 3)
    # Depthwise: output channel order is [c0_id, c0_sx, c0_sy, c1_id, ...]
    return k.repeat(channels, 1, 1)[:, None]  # (3C, 1, 3, 3)


class NCA(nn.Module):
    def __init__(self, channels: int = CHANNELS, hidden: int = HIDDEN, fire_rate: float = FIRE_RATE):
        super().__init__()
        self.channels = channels
        self.hidden = hidden
        self.fire_rate = fire_rate
        self.register_buffer("kernel", _filters(channels), persistent=False)
        self.fc1 = nn.Conv2d(channels * 3, hidden, 1)
        self.fc2 = nn.Conv2d(hidden, channels, 1, bias=False)
        nn.init.zeros_(self.fc2.weight)  # start as "do nothing"

    def perceive(self, x: torch.Tensor) -> torch.Tensor:
        return F.conv2d(x, self.kernel, padding=1, groups=self.channels)

    @staticmethod
    def alive(x: torch.Tensor) -> torch.Tensor:
        return F.max_pool2d(x[:, 3:4], 3, stride=1, padding=1) > ALIVE_THRESHOLD

    def update(self, x: torch.Tensor) -> torch.Tensor:
        """Deterministic residual update (before stochastic masking)."""
        return self.fc2(F.relu(self.fc1(self.perceive(x))))

    def forward(self, x: torch.Tensor, fire_mask: torch.Tensor | None = None) -> torch.Tensor:
        pre = self.alive(x)
        dx = self.update(x)
        if fire_mask is None:
            fire_mask = torch.rand_like(x[:, :1]) <= self.fire_rate
        x = x + dx * fire_mask.to(x.dtype)
        post = self.alive(x)
        return x * (pre & post).to(x.dtype)

    def param_count(self) -> int:
        return sum(p.numel() for p in self.parameters())


def seed_state(batch: int, size: int, channels: int = CHANNELS) -> torch.Tensor:
    """A single live cell in the centre: alpha and hidden channels = 1, RGB = 0."""
    x = torch.zeros(batch, channels, size, size)
    c = size // 2
    x[:, 3:, c, c] = 1.0
    return x


def damage(x: torch.Tensor, generator: torch.Generator | None = None, radius: tuple[float, float] = (0.1, 0.4)) -> torch.Tensor:
    """Zero a random circle in each sample (radius as a fraction of grid size)."""
    b, _, h, w = x.shape
    yy, xx = torch.meshgrid(torch.linspace(-1, 1, h), torch.linspace(-1, 1, w), indexing="ij")
    out = x.clone()
    for i in range(b):
        cx, cy = (torch.rand(2, generator=generator) * 1.0 - 0.5).tolist()
        r = radius[0] + (radius[1] - radius[0]) * torch.rand(1, generator=generator).item()
        mask = ((xx - cx) ** 2 + (yy - cy) ** 2) < (2 * r) ** 2
        out[i, :, mask] = 0.0
    return out


def iou(rgba: torch.Tensor, target: torch.Tensor, threshold: float = ALIVE_THRESHOLD) -> float:
    """Intersection-over-union of the visible (alpha > threshold) area."""
    a = rgba[3] > threshold
    b = target[3] > threshold
    union = (a | b).sum().item()
    return 1.0 if union == 0 else (a & b).sum().item() / union


def to_rgba(x: torch.Tensor) -> torch.Tensor:
    """Visible channels, unclamped. (Clamping here would zero the gradient for
    every newborn cell, whose RGB starts at exactly 0.)"""
    return x[..., :4, :, :]


def lr_schedule(step: int, total: int, base: float = 2e-3) -> float:
    # Linear warmup then cosine decay to 10%
    warm = 50
    if step < warm:
        return base * (step + 1) / warm
    t = (step - warm) / max(1, total - warm)
    return base * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * t)))


# ---------------------------------------------------------------------------
# Deterministic fire mask shared with the runtime implementations.
# Training uses torch.rand; at runtime every implementation (JS, WebGL2, WebGPU)
# uses this integer hash so a seeded run replays identically everywhere.

def _u32(v):
    import numpy as np
    return np.asarray(v, dtype=np.uint64) & np.uint64(0xFFFFFFFF)


def hash_u32(x, y, step, seed):
    """Murmur3-style finaliser over (x, y, step, seed). Inputs are uint32 arrays/ints."""
    import numpy as np
    h = _u32(_u32(x) * np.uint64(0x8DA6B343))
    h = _u32(h ^ _u32(_u32(y) * np.uint64(0xD8163841)))
    h = _u32(h ^ _u32(_u32(step) * np.uint64(0xCB1AB31F)))
    h = _u32(h ^ _u32(seed))
    h = _u32(h ^ (h >> np.uint64(16)))
    h = _u32(h * np.uint64(0x85EBCA6B))
    h = _u32(h ^ (h >> np.uint64(13)))
    h = _u32(h * np.uint64(0xC2B2AE35))
    h = _u32(h ^ (h >> np.uint64(16)))
    return h


def hash_fire_mask(h: int, w: int, step: int, seed: int, fire_rate: float = FIRE_RATE) -> torch.Tensor:
    """(1, 1, H, W) bool mask: cell fires when the top 24 bits of its hash < fire_rate * 2^24."""
    import numpy as np
    yy, xx = np.meshgrid(np.arange(h, dtype=np.uint64), np.arange(w, dtype=np.uint64), indexing="ij")
    v = hash_u32(xx, yy, step, seed) >> np.uint64(8)
    m = v < np.uint64(int(fire_rate * (1 << 24)))
    return torch.from_numpy(m)[None, None]
