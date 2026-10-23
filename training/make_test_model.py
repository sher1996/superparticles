"""Write a small random-weight model + parity vectors used by the JS test suite.

    python training/make_test_model.py test/fixtures/random.nca.json
"""

import subprocess
import sys
import tempfile
from pathlib import Path

import torch

from nca import NCA

out = Path(sys.argv[1])
torch.manual_seed(42)
model = NCA()
with torch.no_grad():
    model.fc2.weight.normal_(0, 0.02)  # non-zero so the pattern actually changes
cfg = {"target": "random", "size": 24, "pad": 4, "steps": 0, "batch": 0, "pool": 0, "damage": 0, "seed": 42,
       "params": model.param_count(), "torch": str(torch.__version__)}
with tempfile.TemporaryDirectory() as d:
    ckpt = Path(d) / "checkpoint.pt"
    torch.save({"model": model.state_dict(), "step": 0, "config": cfg}, ckpt)
    for dtype in ("float32",):
        subprocess.run([sys.executable, str(Path(__file__).with_name("export.py")), str(ckpt), str(out), dtype], check=True)
