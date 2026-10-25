"""Export a trained shadow-matting checkpoint to ONNX, so the server can run it without torch.

    python training/export_onnx.py runs/shadow-best.pt server/modelos/shadow-matte.onnx

The server already speaks ONNX Runtime for BiRefNet; this keeps the shadow network on the same
runtime instead of dragging a second deep-learning stack into the install.
"""
from __future__ import annotations

import sys
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_shadow import LADO, ShadowMatte  # noqa: E402


def main(pesos: Path, saida: Path) -> None:
    rede = ShadowMatte()
    rede.load_state_dict(torch.load(pesos, map_location="cpu"))
    rede.eval()
    saida.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        rede,
        torch.zeros(1, 3, LADO, LADO),
        str(saida),
        input_names=["image"],
        output_names=["factor"],
        # The side is dynamic on purpose: a shadow field is smooth, so it can be predicted at a
        # lower resolution than the photo and scaled back up without visible loss.
        dynamic_axes={"image": {0: "n", 2: "h", 3: "w"}, "factor": {0: "n", 2: "h", 3: "w"}},
        opset_version=17,
    )
    print(f"wrote {saida} ({saida.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
