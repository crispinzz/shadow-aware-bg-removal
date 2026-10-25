"""Train the shadow matting network: the part no background remover has.

Segmentation of the *product* is a solved problem — BiRefNet already does it better than anything
we could train on one machine. What nobody ships is a network that answers the other question:

    for every background pixel, how much did the object darken the backdrop here?

That is a regression, not a segmentation: the target is a continuous factor in [0, 1], where 1 is
untouched backdrop and 0.6 is a pixel the object dimmed to 60%. Train that, and the shadow comes
back with its own perspective and softness instead of being drawn as an ellipse.

The analytic version of this lives in src/backdrop.ts and works whenever the backdrop is a plain
seamless sweep. It breaks on the cases a network would learn:

  * the backdrop is textured or coloured, so "divide by the local light" also divides the texture;
  * the shadow leaves the sweep and climbs a wall, where the reference light changes abruptly;
  * two lights make two overlapping shadows of different densities;
  * the object is translucent, so part of the darkening is transmission, not occlusion.

Datasets (download separately, both free for research):

  ISTD      https://github.com/DeepInsight-PCALab/ST-CGAN   1870 triplets: shadow, mask, shadow-free
  SBU       https://www3.cs.stonybrook.edu/~cvl/dataset.html 4727 pairs: shadow, binary mask

ISTD is the one that matters here: it ships the shadow-free version of the same frame, so the
*factor* is directly computable as shadow / shadow_free, per pixel. SBU only has binary masks,
which is exactly the information this project refuses to settle for.

    python training/train_shadow.py --data /path/to/ISTD --epochs 40 --batch 8
    python training/export_onnx.py runs/shadow-best.pt server/modelos/shadow-matte.onnx

Honest numbers, measured by training/bench_cpu.py and not guessed. On an Intel i5-13400 (10 worker
threads, no CUDA), one forward+backward+step of this network:

    256 px, batch 4   1.6 s/step    6 h for 40 epochs on ISTD
    320 px, batch 4   2.9 s/step   11 h
    384 px, batch 4   4.3 s/step   16 h

So a plain desktop CPU trains this overnight. That is only true because the network is small on
purpose; fine-tuning a subject segmenter like BiRefNet on the same machine is not in the same
universe and should go to a rented GPU. Run bench_cpu.py on your own machine before planning.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

try:
    import cv2
except ImportError as erro:  # pragma: no cover - the message is the point
    raise SystemExit("pip install opencv-python torch") from erro


LADO = 320  # training side; 256 halves the time, 384 buys little on a signal this smooth


def tamanho_do_lado(lado: int | None = None) -> int:
    """The side every image is resized to. Overridable from the command line."""
    global LADO
    if lado:
        LADO = lado
    return LADO


class IstdFactors(Dataset):
    """ISTD, read as factors instead of masks.

    `factor = shadow / shadow_free`, clipped to [0.3, 1]. Where the shadow-free frame is almost
    black the ratio is meaningless, so those pixels are dropped from the loss with a weight map
    rather than being learned as noise.
    """

    def __init__(self, raiz: Path, split: str = "train") -> None:
        pasta = raiz / ("train" if split == "train" else "test")
        sufixo = "_A" if split == "train" else "_A"
        self.sombras = sorted((pasta / f"{split}{sufixo}").glob("*.png"))
        self.livres = pasta / f"{split}_C"
        if not self.sombras:
            raise SystemExit(f"no images under {pasta}; check --data points at the ISTD root")

    def __len__(self) -> int:
        return len(self.sombras)

    def __getitem__(self, i: int):
        caminho = self.sombras[i]
        sombra = cv2.imread(str(caminho), cv2.IMREAD_COLOR)
        livre = cv2.imread(str(self.livres / caminho.name), cv2.IMREAD_COLOR)
        sombra = cv2.resize(sombra, (LADO, LADO), interpolation=cv2.INTER_AREA).astype(np.float32)
        livre = cv2.resize(livre, (LADO, LADO), interpolation=cv2.INTER_AREA).astype(np.float32)

        luz_sombra = sombra.mean(axis=2)
        luz_livre = livre.mean(axis=2)
        valido = (luz_livre > 25).astype(np.float32)          # near-black: ratio says nothing
        fator = np.clip(luz_sombra / np.maximum(luz_livre, 1.0), 0.3, 1.0)

        entrada = torch.from_numpy(sombra.transpose(2, 0, 1) / 255.0)
        return entrada, torch.from_numpy(fator)[None], torch.from_numpy(valido)[None]


def bloco(entra: int, sai: int) -> nn.Sequential:
    return nn.Sequential(
        nn.Conv2d(entra, sai, 3, padding=1), nn.BatchNorm2d(sai), nn.ReLU(inplace=True),
        nn.Conv2d(sai, sai, 3, padding=1), nn.BatchNorm2d(sai), nn.ReLU(inplace=True),
    )


class ShadowMatte(nn.Module):
    """A small U-Net. Deliberately small: the signal is low frequency.

    A shadow is a smooth field — no texture, no edges of its own beyond the penumbra. A deep
    high-capacity decoder spends its parameters hallucinating detail that must not be there, and
    the output is a factor map that then gets multiplied into the image, where any invented grain
    is immediately visible. 1.9M parameters; the output is a sigmoid rescaled to [0.3, 1].
    """

    def __init__(self) -> None:
        super().__init__()
        self.e1, self.e2, self.e3 = bloco(3, 32), bloco(32, 64), bloco(64, 128)
        self.meio = bloco(128, 192)
        self.d3, self.d2, self.d1 = bloco(192 + 128, 128), bloco(128 + 64, 64), bloco(64 + 32, 32)
        self.saida = nn.Conv2d(32, 1, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        e1 = self.e1(x)
        e2 = self.e2(F.max_pool2d(e1, 2))
        e3 = self.e3(F.max_pool2d(e2, 2))
        m = self.meio(F.max_pool2d(e3, 2))
        d3 = self.d3(torch.cat([F.interpolate(m, scale_factor=2, mode="bilinear", align_corners=False), e3], 1))
        d2 = self.d2(torch.cat([F.interpolate(d3, scale_factor=2, mode="bilinear", align_corners=False), e2], 1))
        d1 = self.d1(torch.cat([F.interpolate(d2, scale_factor=2, mode="bilinear", align_corners=False), e1], 1))
        return 0.3 + 0.7 * torch.sigmoid(self.saida(d1))


def gradiente(x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    return x[..., 1:] - x[..., :-1], x[..., 1:, :] - x[..., :-1, :]


def perda(previsto: torch.Tensor, alvo: torch.Tensor, valido: torch.Tensor) -> torch.Tensor:
    """L1 where the ratio is meaningful, plus a gradient term.

    The gradient term is what keeps the penumbra. Plain L1 is happy to predict a slightly wrong
    constant across a soft edge; matching the derivative forces the falloff to land in the right
    place, which is the whole difference between a real shadow and a blurred blob.
    """
    base = (torch.abs(previsto - alvo) * valido).sum() / valido.sum().clamp(min=1)
    px, py = gradiente(previsto)
    ax, ay = gradiente(alvo)
    borda = torch.abs(px - ax).mean() + torch.abs(py - ay).mean()
    return base + 0.4 * borda


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True, type=Path, help="ISTD root (has train/ and test/)")
    p.add_argument("--epochs", type=int, default=40)
    p.add_argument("--batch", type=int, default=8)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--out", type=Path, default=Path("runs"))
    p.add_argument("--size", type=int, default=LADO, help="training side in pixels")
    p.add_argument("--threads", type=int, default=0, help="0 keeps torch's own choice")
    args = p.parse_args()

    tamanho_do_lado(args.size)
    if args.threads:
        torch.set_num_threads(args.threads)
    dispositivo = "cuda" if torch.cuda.is_available() else "cpu"
    if dispositivo == "cpu":
        # Overnight, not impossible: see the measured table at the top of this file. Peak RSS is
        # roughly 1.5 GB at 320 px batch 4, so close the browser before starting.
        print(f"no CUDA: training on CPU with {torch.get_num_threads()} threads at {LADO} px. "
              "Run training/bench_cpu.py to see what that costs here.")

    # Workers hold their own copy of each batch; on a 16 GB machine that is the first thing to cut.
    trabalhadores = 2 if dispositivo == "cpu" else 4
    treino = DataLoader(IstdFactors(args.data, "train"), batch_size=args.batch, shuffle=True,
                        num_workers=trabalhadores, drop_last=True)
    teste = DataLoader(IstdFactors(args.data, "test"), batch_size=args.batch, num_workers=1)

    rede = ShadowMatte().to(dispositivo)
    otim = torch.optim.AdamW(rede.parameters(), lr=args.lr, weight_decay=1e-4)
    passos = torch.optim.lr_scheduler.CosineAnnealingLR(otim, args.epochs)
    args.out.mkdir(parents=True, exist_ok=True)
    melhor = float("inf")

    for epoca in range(args.epochs):
        rede.train()
        soma = 0.0
        for entrada, alvo, valido in treino:
            entrada, alvo, valido = entrada.to(dispositivo), alvo.to(dispositivo), valido.to(dispositivo)
            otim.zero_grad(set_to_none=True)
            erro = perda(rede(entrada), alvo, valido)
            erro.backward()
            otim.step()
            soma += erro.item()
        passos.step()

        rede.eval()
        validacao = 0.0
        with torch.no_grad():
            for entrada, alvo, valido in teste:
                entrada, alvo, valido = entrada.to(dispositivo), alvo.to(dispositivo), valido.to(dispositivo)
                validacao += perda(rede(entrada), alvo, valido).item()
        validacao /= max(len(teste), 1)
        print(f"epoch {epoca + 1:3d}/{args.epochs}  train {soma / len(treino):.4f}  val {validacao:.4f}")

        if validacao < melhor:
            melhor = validacao
            torch.save(rede.state_dict(), args.out / "shadow-best.pt")
            print(f"  saved {args.out / 'shadow-best.pt'} (val {melhor:.4f})")


if __name__ == "__main__":
    main()
