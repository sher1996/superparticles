# Local image → 3D helper

Turns one picture into a full 3D shape on this computer's GPU, for the orchestrated swarm pages
(`playground/heart3d.html`). Uses [TripoSG](https://github.com/VAST-AI-Research/TripoSG)
(MIT licence). Nothing is uploaded anywhere: the helper only listens on `127.0.0.1:8765`.

Needs an NVIDIA GPU with about 8 GB of memory (tested target: RTX 2070 SUPER).

## Set up (once)

From the repository root:

```bash
cd tools/image3d
git clone --depth 1 https://github.com/VAST-AI-Research/TripoSG.git
uv venv --python 3.12 .venv
uv pip install --python .venv/Scripts/python.exe torch torchvision --index-url https://download.pytorch.org/whl/cu126
uv pip install --python .venv/Scripts/python.exe diffusers transformers einops huggingface_hub opencv-python-headless trimesh omegaconf scikit-image scipy peft jaxtyping typeguard pillow
.venv/Scripts/python.exe -c "from huggingface_hub import snapshot_download; snapshot_download('VAST-AI/TripoSG', local_dir='pretrained_weights/TripoSG')"
```

Disk use: about 4.5 GB for the Python environment and 8 GB for the model weights.
TripoSG's background remover (RMBG-1.4, non-commercial licence) is not needed: the page cuts the
background out itself and sends a transparent PNG.

## Run

```bash
tools/image3d/.venv/Scripts/python.exe tools/image3d/server.py
```

Then open `playground/heart3d.html` and use **Image → 3D (local AI)**.

Measured on an RTX 2070 SUPER: about 5.3 GB of GPU memory, 27 s for the AI itself, about 60–70 s
per picture on the helper's side, and the first picture takes about 30 s longer because the model
loads then. Only run one copy: a second one refuses to start while port 8765 is busy.
