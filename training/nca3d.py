"""3D voxel neural cellular automaton (Chapter 7 proof of concept, 16x16x16 voxels).

Same recipe as nca.py, one dimension up: each voxel perceives its 3x3x3
neighbourhood through identity + Sobel x/y/z filters (4C inputs), a shared MLP
proposes a residual update, voxels fire stochastically and only "alive" voxels
(alpha > 0.1 within the 3x3x3 neighbourhood) survive.

Tensor layout: (batch, channels, depth z, height y, width x).
"""

import torch
import torch.nn as nn
import torch.nn.functional as F

from nca import ALIVE_THRESHOLD, hash_u32

CHANNELS = 16
HIDDEN = 96
FIRE_RATE = 0.5


def _filters(channels: int) -> torch.Tensor:
    smooth = torch.tensor([1.0, 2.0, 1.0])
    deriv = torch.tensor([-1.0, 0.0, 1.0])
    ident = torch.zeros(3, 3, 3)
    ident[1, 1, 1] = 1.0
    # kernel[z, y, x]
    sx = torch.einsum("i,j,k->ijk", smooth, smooth, deriv) / 32.0
    sy = torch.einsum("i,j,k->ijk", smooth, deriv, smooth) / 32.0
    sz = torch.einsum("i,j,k->ijk", deriv, smooth, smooth) / 32.0
    k = torch.stack([ident, sx, sy, sz])  # (4, 3, 3, 3)
    return k.repeat(channels, 1, 1, 1)[:, None]  # (4C, 1, 3, 3, 3), index 4c + k


class NCA3D(nn.Module):
    def __init__(self, channels: int = CHANNELS, hidden: int = HIDDEN, fire_rate: float = FIRE_RATE):
        super().__init__()
        self.channels = channels
        self.hidden = hidden
        self.fire_rate = fire_rate
        self.register_buffer("kernel", _filters(channels), persistent=False)
        self.fc1 = nn.Conv3d(channels * 4, hidden, 1)
        self.fc2 = nn.Conv3d(hidden, channels, 1, bias=False)
        nn.init.zeros_(self.fc2.weight)

    def perceive(self, x):
        return F.conv3d(x, self.kernel, padding=1, groups=self.channels)

    @staticmethod
    def alive(x):
        return F.max_pool3d(x[:, 3:4], 3, stride=1, padding=1) > ALIVE_THRESHOLD

    def forward(self, x, fire_mask=None):
        pre = self.alive(x)
        dx = self.fc2(F.relu(self.fc1(self.perceive(x))))
        if fire_mask is None:
            fire_mask = torch.rand_like(x[:, :1]) <= self.fire_rate
        x = x + dx * fire_mask.to(x.dtype)
        post = self.alive(x)
        return x * (pre & post).to(x.dtype)

    def param_count(self):
        return sum(p.numel() for p in self.parameters())


def seed_state(batch: int, size: int, channels: int = CHANNELS):
    x = torch.zeros(batch, channels, size, size, size)
    c = size // 2
    x[:, 3:, c, c, c] = 1.0
    return x


def hash_fire_mask3d(size: int, step: int, seed: int, fire_rate: float = FIRE_RATE):
    """Per-voxel mask; the hash's x input is x + size * z, so z=0 equals the 2D mask."""
    import numpy as np
    zz, yy, xx = np.meshgrid(*(np.arange(size, dtype=np.uint64),) * 3, indexing="ij")
    v = hash_u32(xx + np.uint64(size) * zz, yy, step, seed) >> np.uint64(8)
    m = v < np.uint64(int(fire_rate * (1 << 24)))
    return torch.from_numpy(m)[None, None]


def damage(x, generator=None, radius=(0.15, 0.35)):
    b, _, d, h, w = x.shape
    zz, yy, xx = torch.meshgrid(*(torch.linspace(-1, 1, n) for n in (d, h, w)), indexing="ij")
    out = x.clone()
    for i in range(b):
        c = (torch.rand(3, generator=generator) - 0.5).tolist()
        r = radius[0] + (radius[1] - radius[0]) * torch.rand(1, generator=generator).item()
        mask = ((xx - c[0]) ** 2 + (yy - c[1]) ** 2 + (zz - c[2]) ** 2) < (2 * r) ** 2
        out[i, :, mask] = 0.0
    return out


def iou3d(rgba, target, threshold=ALIVE_THRESHOLD):
    a = rgba[3] > threshold
    b = target[3] > threshold
    union = (a | b).sum().item()
    return 1.0 if union == 0 else (a & b).sum().item() / union


def planet(size: int = 16):
    """Target: a small planet (blue-green sphere) with a tilted orange ring.
    Returns (4, D, H, W) premultiplied RGBA."""
    import numpy as np
    g = (np.arange(size) - (size - 1) / 2) / (size / 2)
    z, y, x = np.meshgrid(g, g, g, indexing="ij")
    out = np.zeros((4, size, size, size), dtype=np.float32)
    r = np.sqrt(x * x + y * y + z * z)
    sphere = r < 0.45
    # ring in a plane tilted 25 degrees around x
    t = np.deg2rad(25)
    yr = y * np.cos(t) - z * np.sin(t)
    zr = y * np.sin(t) + z * np.cos(t)
    rr = np.sqrt(x * x + zr * zr)
    ring = (np.abs(yr) < 0.13) & (rr > 0.6) & (rr < 0.92)
    # sphere colour: green northern half, blue southern half
    out[0][sphere] = np.where(y[sphere] < 0, 0.2, 0.15)
    out[1][sphere] = np.where(y[sphere] < 0, 0.75, 0.45)
    out[2][sphere] = np.where(y[sphere] < 0, 0.35, 0.95)
    out[3][sphere] = 1.0
    out[0][ring], out[1][ring], out[2][ring], out[3][ring] = 1.0, 0.6, 0.15, 1.0
    return out


TARGETS3D = {"planet": planet}
