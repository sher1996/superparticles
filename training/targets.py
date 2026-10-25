"""Target images for training. Drawn procedurally so the repo has no binary assets
and every run starts from byte-identical targets."""

import numpy as np
from PIL import Image, ImageDraw


def _finish(img: Image.Image, size: int, pad: int) -> np.ndarray:
    """Downsample with antialiasing, pad, and premultiply RGB by alpha."""
    inner = size - 2 * pad
    img = img.resize((inner, inner), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(img, (pad, pad), img)
    a = np.asarray(canvas, dtype=np.float32) / 255.0
    a[..., :3] *= a[..., 3:4]
    return a.transpose(2, 0, 1)  # (4, H, W)


def heart(size: int = 64, pad: int = 12) -> np.ndarray:
    s = 512
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = s * 0.27
    # two lobes + a point
    d.ellipse([s * 0.5 - 2 * r + 8, s * 0.1, s * 0.5 + 8, s * 0.1 + 2 * r], fill=(226, 40, 70, 255))
    d.ellipse([s * 0.5 - 8, s * 0.1, s * 0.5 + 2 * r - 8, s * 0.1 + 2 * r], fill=(226, 40, 70, 255))
    d.polygon([(s * 0.5 - 2 * r + 12, s * 0.1 + r * 1.25), (s * 0.5 + 2 * r - 12, s * 0.1 + r * 1.25), (s * 0.5, s * 0.92)],
              fill=(226, 40, 70, 255))
    # highlight so the model must learn internal structure, not just a flat blob
    d.ellipse([s * 0.30, s * 0.22, s * 0.42, s * 0.34], fill=(255, 170, 185, 255))
    return _finish(img, size, pad)


def ring(size: int = 64, pad: int = 12) -> np.ndarray:
    s = 512
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([s * 0.05, s * 0.05, s * 0.95, s * 0.95], fill=(60, 140, 255, 255))
    d.ellipse([s * 0.3, s * 0.3, s * 0.7, s * 0.7], fill=(0, 0, 0, 0))
    d.ellipse([s * 0.42, s * 0.42, s * 0.58, s * 0.58], fill=(255, 210, 60, 255))
    return _finish(img, size, pad)


TARGETS = {"heart": heart, "ring": ring}


def from_image(path: str, size: int = 64, pad: int = 12) -> np.ndarray:
    """Any RGBA image (e.g. a drawing saved from playground/train.html) as a target."""
    img = Image.open(path).convert("RGBA")
    img.thumbnail((512, 512))
    square = Image.new("RGBA", (max(img.size),) * 2, (0, 0, 0, 0))
    square.paste(img, ((square.width - img.width) // 2, (square.height - img.height) // 2))
    return _finish(square, size, pad)
