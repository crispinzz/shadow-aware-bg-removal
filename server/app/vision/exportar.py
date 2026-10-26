"""Gravação do resultado em PNG e JPEG, com conferência depois de gravar.

Gravar e confiar não basta: disco cheio e codec recusando produzem arquivo truncado que só falha na
mão do usuário. Aqui cada arquivo é relido e conferido antes de virar download.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

from ..core import config


class FalhaNaExportacao(RuntimeError):
    pass


def _conferir(caminho: Path, largura: int, altura: int) -> None:
    if not caminho.exists() or caminho.stat().st_size == 0:
        raise FalhaNaExportacao(f"O arquivo {caminho.name} saiu vazio.")
    with Image.open(caminho) as lido:
        lido.verify()
    with Image.open(caminho) as lido:
        if lido.size != (largura, altura):
            raise FalhaNaExportacao(
                f"O arquivo {caminho.name} saiu em {lido.size[0]}×{lido.size[1]}, esperava {largura}×{altura}."
            )


def gravar(bgr: np.ndarray, pasta: Path, base: str) -> dict[str, Path]:
    """Grava PNG e JPEG a partir de uma imagem BGR. Devolve {formato: caminho}."""
    if bgr.ndim != 3 or bgr.shape[2] != 3:
        raise FalhaNaExportacao("A imagem final precisa ter três canais.")
    altura, largura = bgr.shape[:2]
    rgb = Image.fromarray(np.ascontiguousarray(bgr[:, :, ::-1]), mode="RGB")

    pasta.mkdir(parents=True, exist_ok=True)
    caminhos: dict[str, Path] = {}

    png = pasta / f"{base}.png"
    rgb.save(png, format="PNG", optimize=True)
    _conferir(png, largura, altura)
    caminhos["png"] = png

    jpg = pasta / f"{base}.jpg"
    rgb.save(jpg, format="JPEG", quality=config.QUALIDADE_JPEG, subsampling=0, optimize=True)
    _conferir(jpg, largura, altura)
    caminhos["jpg"] = jpg

    return caminhos


def gravar_mascara(alfa: np.ndarray, pasta: Path, base: str) -> Path:
    """Grava o alfa como PNG em cinza, para diagnóstico. Nunca substitui a foto final."""
    altura, largura = alfa.shape[:2]
    cinza = (np.clip(alfa, 0.0, 1.0) * 255).astype(np.uint8)
    pasta.mkdir(parents=True, exist_ok=True)
    caminho = pasta / f"{base}.png"
    Image.fromarray(cinza, mode="L").save(caminho, format="PNG", optimize=True)
    _conferir(caminho, largura, altura)
    return caminho


def gravar_fator(fator: np.ndarray, pasta: Path, base: str) -> Path:
    """Grava o mapa de fator da sombra (0..1) como PNG em cinza. O frontend compõe com ele."""
    return gravar_mascara(fator, pasta, base)
