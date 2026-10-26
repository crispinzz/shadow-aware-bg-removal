"""Render training pairs: the same frame with and without the shadow.

Supervised shadow matting needs the *same* scene twice — one with the cast shadow, one without —
because the target is the ratio between them. Photographs of objects with shadows, however many,
carry no such target: nothing in them says what the floor looked like underneath.

Rendering it sidesteps the problem. Here the clean plate is generated first, then a shadow is cast
onto it, so the ratio is known exactly instead of estimated. The point is not photorealism of the
object — the network never sees the object's pixels, only the backdrop around it. What has to be
realistic is the *shadow*: its penumbra, its density falloff, the perspective stretch, the way the
backdrop's own light and texture sit underneath it.

    python training/make_synthetic.py --out data/synthetic --train 900 --test 120

Writes the ISTD layout, so the existing loader reads it unchanged:

    data/synthetic/train/train_A/0001.png   with shadow
    data/synthetic/train/train_C/0001.png   without
"""
from __future__ import annotations

import argparse
import math
import random
from pathlib import Path

import cv2
import numpy as np

LADO = 384


def fundo(rng: random.Random) -> np.ndarray:
    """A seamless sweep, a painted wall, a sheet of paper: smooth light, sometimes a texture."""
    base = rng.uniform(120, 245)
    img = np.full((LADO, LADO), base, np.float32)

    # Light falloff: a gradient in a random direction, which is what a softbox leaves behind.
    yy, xx = np.mgrid[0:LADO, 0:LADO].astype(np.float32) / LADO
    ang = rng.uniform(0, math.tau)
    rampa = (xx * math.cos(ang) + yy * math.sin(ang))
    img *= 1.0 - rng.uniform(0.02, 0.35) * rampa

    # Vignette, sometimes.
    if rng.random() < 0.5:
        r = np.sqrt((xx - 0.5) ** 2 + (yy - 0.5) ** 2)
        img *= 1.0 - rng.uniform(0.05, 0.3) * r

    # Paper grain or fabric weave: the texture the analytic method cannot tell from a shadow.
    if rng.random() < 0.6:
        ruido = np.random.default_rng(rng.randrange(1 << 30)).normal(0, 1, (LADO, LADO)).astype(np.float32)
        escala = rng.choice([3, 7, 15, 31])
        ruido = cv2.GaussianBlur(ruido, (escala, escala), 0)
        ruido /= max(ruido.std(), 1e-6)
        img += ruido * rng.uniform(1.5, 9.0)

    # A horizon line: where the sweep leaves the floor and becomes the wall.
    if rng.random() < 0.35:
        corte = rng.randint(int(LADO * 0.25), int(LADO * 0.75))
        img[:corte] *= rng.uniform(0.86, 1.12)
        img[:corte + 1] = cv2.GaussianBlur(img[:corte + 1], (0, 0), rng.uniform(2, 14))

    cor = np.stack([img * rng.uniform(0.95, 1.0),
                    img * rng.uniform(0.95, 1.0),
                    img * rng.uniform(0.95, 1.0)], axis=2)
    return np.clip(cor, 0, 255)


def silhueta(rng: random.Random) -> np.ndarray:
    """The thing casting the shadow. Simple shapes: the network learns the cast, not the object."""
    m = np.zeros((LADO, LADO), np.float32)
    cx, cy = rng.randint(90, LADO - 90), rng.randint(110, LADO - 70)
    tipo = rng.random()
    if tipo < 0.3:
        cv2.circle(m, (cx, cy), rng.randint(30, 85), 1.0, -1)
    elif tipo < 0.55:
        w, h = rng.randint(40, 120), rng.randint(40, 140)
        cv2.rectangle(m, (cx - w // 2, cy - h // 2), (cx + w // 2, cy + h // 2), 1.0, -1)
    elif tipo < 0.75:
        lado = rng.randint(50, 130)
        pts = np.array([[cx, cy - lado], [cx - lado, cy + lado // 2], [cx + lado, cy + lado // 2]])
        cv2.fillPoly(m, [pts], 1.0)
    else:
        # Something with holes and thin parts: a chair, a ladder, a handle.
        for _ in range(rng.randint(3, 7)):
            x = cx + rng.randint(-70, 70)
            y = cy + rng.randint(-80, 80)
            cv2.line(m, (x, y), (x + rng.randint(-60, 60), y + rng.randint(-60, 60)),
                     1.0, rng.randint(4, 18))
    return m


def sombra_de(mascara: np.ndarray, rng: random.Random) -> np.ndarray:
    """Project the silhouette onto the floor: stretch, shear, soften, fade with distance.

    The falloff matters more than the shape. A contact shadow is dark and sharp where the object
    meets the floor, and it loses both density and definition as it travels — that gradient is the
    only thing separating a real cast from a decal.
    """
    alto = rng.uniform(0.6, 3.2)                 # how far the light stretches it
    inclina = rng.uniform(-1.4, 1.4)
    m = np.float32([[1, inclina, -inclina * LADO / 2], [0, alto, (1 - alto) * LADO * 0.75]])
    projetada = cv2.warpAffine(mascara, m, (LADO, LADO), flags=cv2.INTER_LINEAR)

    # Penumbra grows with distance from the contact point: blur a few copies and stack them.
    saida = np.zeros_like(projetada)
    passos = rng.randint(3, 6)
    for i in range(passos):
        raio = 1 + (i / passos) * rng.uniform(6, 40)
        camada = cv2.GaussianBlur(projetada, (0, 0), raio)
        peso = np.linspace(1.0, 0.25, LADO, dtype=np.float32)[:, None] ** rng.uniform(0.5, 2.5)
        saida = np.maximum(saida, camada * peso)

    densidade = rng.uniform(0.12, 0.55)          # how much light the object actually blocks
    return np.clip(saida, 0, 1) * densidade


def par(rng: random.Random) -> tuple[np.ndarray, np.ndarray]:
    limpo = fundo(rng)
    sombra = sombra_de(silhueta(rng), rng)[..., None]
    com = limpo * (1.0 - sombra)

    # The camera adds its own noise after the light, so it goes on last and differs between frames.
    for img in (limpo, com):
        img += np.random.default_rng(rng.randrange(1 << 30)).normal(0, rng.uniform(0.4, 2.2), img.shape)
    return np.clip(com, 0, 255).astype(np.uint8), np.clip(limpo, 0, 255).astype(np.uint8)


def escrever(raiz: Path, split: str, quantos: int, semente: int) -> None:
    rng = random.Random(semente)
    com_dir = raiz / split / f"{split}_A"
    sem_dir = raiz / split / f"{split}_C"
    com_dir.mkdir(parents=True, exist_ok=True)
    sem_dir.mkdir(parents=True, exist_ok=True)
    for i in range(quantos):
        com, sem = par(rng)
        nome = f"{i:04d}.png"
        cv2.imwrite(str(com_dir / nome), com)
        cv2.imwrite(str(sem_dir / nome), sem)
        if (i + 1) % 100 == 0:
            print(f"  {split}: {i + 1}/{quantos}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--out", type=Path, default=Path("data/synthetic"))
    p.add_argument("--train", type=int, default=900)
    p.add_argument("--test", type=int, default=120)
    args = p.parse_args()
    escrever(args.out, "train", args.train, 20261025)
    escrever(args.out, "test", args.test, 7)
    print(f"done: {args.out}")


if __name__ == "__main__":
    main()
