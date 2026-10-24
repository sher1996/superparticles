"""Random-weight swarm + parity vectors for the JS tests.

    python training/make_test_swarm.py test/fixtures/random.swarm.json
"""

import subprocess
import sys
import tempfile
from pathlib import Path

import torch

from swarm import Swarm

torch.manual_seed(3)
model = Swarm()
with torch.no_grad():
    model.fc2.weight.normal_(0, 0.3)  # large enough that particles really move
cfg = {"target": "random", "particles": 48, "steps": 0, "batch": 0, "pool": 0, "seed": 3,
       "params": model.param_count(), "torch": str(torch.__version__)}
with tempfile.TemporaryDirectory() as d:
    ckpt = Path(d) / "checkpoint.pt"
    torch.save({"model": model.state_dict(), "step": 0, "config": cfg}, ckpt)
    subprocess.run([sys.executable, str(Path(__file__).with_name("export_swarm.py")), str(ckpt), sys.argv[1], "--dtype", "float32"], check=True)
