"""Random-weight 3D model + parity vectors for the JS tests.

    python training/make_test_model3d.py test/fixtures/random3d.nca.json
"""

import subprocess
import sys
import tempfile
from pathlib import Path

import torch

from nca3d import NCA3D

torch.manual_seed(7)
model = NCA3D()
with torch.no_grad():
    model.fc2.weight.normal_(0, 0.02)
cfg = {"target": "random3d", "size": 8, "steps": 0, "batch": 0, "pool": 0, "damage": 0, "seed": 7,
       "params": model.param_count(), "torch": str(torch.__version__)}
with tempfile.TemporaryDirectory() as d:
    ckpt = Path(d) / "checkpoint.pt"
    torch.save({"model": model.state_dict(), "step": 0, "config": cfg}, ckpt)
    subprocess.run([sys.executable, str(Path(__file__).with_name("export3d.py")), str(ckpt), sys.argv[1], "--dtype", "float32"], check=True)
