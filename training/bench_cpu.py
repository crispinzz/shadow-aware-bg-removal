"""Measure, on this machine, what a training step of the shadow network actually costs.

Nobody should plan a training run on a guess. This times one forward+backward at a few sizes and
prints the hours a full run would take on the ISTD training split (1330 images):

    python training/bench_cpu.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_shadow import ShadowMatte, perda  # noqa: E402

IMAGENS_ISTD = 1330


def medir(lado: int, lote: int, repeticoes: int = 3) -> float:
    rede = ShadowMatte()
    otim = torch.optim.AdamW(rede.parameters(), lr=2e-4)
    x = torch.randn(lote, 3, lado, lado)
    alvo = torch.rand(lote, 1, lado, lado) * 0.7 + 0.3
    valido = torch.ones(lote, 1, lado, lado)

    otim.zero_grad(set_to_none=True)          # uma passada fria, fora da conta
    perda(rede(x), alvo, valido).backward()
    otim.step()

    inicio = time.perf_counter()
    for _ in range(repeticoes):
        otim.zero_grad(set_to_none=True)
        perda(rede(x), alvo, valido).backward()
        otim.step()
    return (time.perf_counter() - inicio) / repeticoes


def main() -> None:
    threads = torch.get_num_threads()
    print(f"torch {torch.__version__}, {threads} threads, cuda={torch.cuda.is_available()}\n")
    print(f"{'size':>6} {'batch':>6} {'s/step':>8} {'img/s':>8} {'h / 40 epochs':>14}")
    for lado, lote in ((256, 4), (320, 4), (384, 4), (384, 8)):
        try:
            s = medir(lado, lote)
        except RuntimeError as erro:          # out of memory on a small machine
            print(f"{lado:>6} {lote:>6}   {erro.__class__.__name__}")
            continue
        img_s = lote / s
        horas = (IMAGENS_ISTD / img_s) * 40 / 3600
        print(f"{lado:>6} {lote:>6} {s:>8.2f} {img_s:>8.2f} {horas:>14.1f}")


if __name__ == "__main__":
    main()
