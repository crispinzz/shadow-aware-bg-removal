"""Render the documentation figures: what the pipeline sees at each stage.

Run it from the repository root, with the segmentation weights already in place:

    python docs/make_figures.py examples/input.jpg

It writes four PNGs into docs/figures/, which is exactly what the README shows:

    01-input.png        the photo as it came out of the camera
    02-matte.png        the alpha matte from BiRefNet: white is product
    03-shadow-map.png   how much each background pixel darkens the backdrop
    04-output.png       the composite: pure white, product untouched, shadow kept

The maths here mirrors src/backdrop.ts on purpose. The browser does the compositing at
full resolution; this script exists so the figures in the README are generated, never
drawn by hand.
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ / "server"))

from app.vision import modelo  # noqa: E402  (needs the path above)

SAIDA = RAIZ / "docs" / "figures"
LADO = 1400          # the network works at 1024; more than this only costs time
SOMBRA_MIN = 0.55    # a shadow never darkens past this, or it reads as a hole
RUGA = 0.18          # up to 18% darker than the clean backdrop is a fabric fold
ALFA_PRODUTO = 0.22  # above this the matte already counts as product


def escala(bgr: np.ndarray) -> np.ndarray:
    fator = min(1.0, LADO / max(bgr.shape[:2]))
    if fator == 1.0:
        return bgr
    return cv2.resize(bgr, None, fx=fator, fy=fator, interpolation=cv2.INTER_AREA)


def luz_do_fundo(luz: np.ndarray, fundo: np.ndarray) -> np.ndarray:
    """Light the backdrop would have with no shadow on it, read only on the lit background."""
    claro = luz[fundo]
    referencia = float(np.percentile(claro, 75)) if claro.size else 255.0
    limpo = fundo & (luz > referencia * 0.82)
    valores = np.where(limpo, luz, 0).astype(np.float32)
    pesos = limpo.astype(np.float32)
    raio = max(8, int(max(luz.shape) / 22) | 1)
    soma = cv2.blur(valores, (raio, raio))
    peso = cv2.blur(pesos, (raio, raio))
    base = np.where(peso > 0.004, soma / np.maximum(peso, 1e-6), referencia)
    return base.astype(np.float32)


def so_o_produto(fundo: np.ndarray) -> np.ndarray:
    """Everything but the largest piece goes back to the background.

    The network keeps real objects it finds at the edge of the frame — a tripod, the corner of a
    table. A catalogue photo is of the object in the middle, so only the biggest piece and whatever
    touches its bounding box survive.
    """
    quantos, etiquetas, caixas, _ = cv2.connectedComponentsWithStats((~fundo).astype(np.uint8), 8)
    if quantos <= 2:
        return fundo
    areas = caixas[1:, cv2.CC_STAT_AREA]
    produto = int(np.argmax(areas)) + 1
    px, py, pw, ph = caixas[produto, :4]
    folga = int(max(fundo.shape) * 0.04)
    limpo = fundo.copy()
    for i in range(1, quantos):
        if i == produto:
            continue
        x, y, w, h = caixas[i, :4]
        perto = x <= px + pw + folga and x + w >= px - folga and y <= py + ph + folga and y + h >= py - folga
        if not perto:
            limpo[etiquetas == i] = True
    return limpo


def perto_do_produto(produto: np.ndarray) -> np.ndarray:
    """A studio shadow falls on the floor: from the middle of the product downwards, and close by.

    Without this the multiply keeps any dark patch in the frame, not just the shadow.
    """
    ys, xs = np.where(produto)
    if not ys.size:
        return np.ones_like(produto)
    alcance = int(max(produto.shape) * 0.06)
    meio = (ys.min() + ys.max()) // 2
    faixa = np.zeros_like(produto)
    faixa[meio:min(produto.shape[0], ys.max() + alcance),
          max(0, xs.min() - alcance):min(produto.shape[1], xs.max() + alcance)] = True
    return faixa


def main(entrada: Path) -> None:
    bgr = escala(cv2.imread(str(entrada), cv2.IMREAD_COLOR))
    altura, largura = bgr.shape[:2]
    SAIDA.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(SAIDA / "01-input.png"), bgr)

    mascara = modelo.inferir(bgr)
    alfa = mascara.alfa.astype(np.float32)
    cv2.imwrite(str(SAIDA / "02-matte.png"), (alfa * 255).astype(np.uint8))

    luz = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    fundo = so_o_produto(alfa <= ALFA_PRODUTO)
    base = luz_do_fundo(luz, fundo)

    fator = np.clip(luz / np.maximum(base, 1.0), SOMBRA_MIN, 1.0)
    fator = np.where(fator > 1 - RUGA, 1.0, fator)          # fabric fold -> white
    fator = cv2.blur(fator, (7, 7))                          # the shadow has no grain
    mapa = np.where(fundo & perto_do_produto(~fundo), fator, 1.0)
    cv2.imwrite(str(SAIDA / "03-shadow-map.png"), (mapa * 255).astype(np.uint8))

    # Composite: white times the shadow factor outside the product, original bytes inside.
    peso = np.where(fundo, np.clip(1.0 - alfa / ALFA_PRODUTO, 0.0, 1.0), 0.0)[..., None]
    branco = (255.0 * mapa)[..., None].repeat(3, axis=2)
    saida = bgr.astype(np.float32) * (1 - peso) + branco * peso
    cv2.imwrite(str(SAIDA / "04-output.png"), np.clip(saida, 0, 255).astype(np.uint8))

    print(f"figures written to {SAIDA} ({largura}x{altura}, model {mascara.modelo})")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else RAIZ / "examples" / "input.jpg"))
