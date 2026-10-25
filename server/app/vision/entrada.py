"""Decodificação segura da foto enviada.

O arquivo que chega é dado não confiável: a extensão não prova nada, e uma imagem pequena no disco
pode virar gigante na memória (bomba de descompressão). Por isso o tipo é decidido pelo conteúdo,
o número de pixels tem teto, e o teto é aplicado ANTES de decodificar de verdade.
"""
from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from ..core import config

# O padrão do Pillow avisa com ~89 Mpx; aqui o limite é nosso, e aplicado explicitamente abaixo.
Image.MAX_IMAGE_PIXELS = None

# Assinaturas aceitas. TIFF tem as duas ordens de byte.
ASSINATURAS: tuple[tuple[bytes, str], ...] = (
    (b"\xff\xd8\xff", "jpeg"),
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"BM", "bmp"),
    (b"II*\x00", "tiff"),
    (b"MM\x00*", "tiff"),
)


class EntradaInvalida(ValueError):
    """Problema no arquivo recebido, com mensagem que pode ser mostrada ao usuário."""


@dataclass
class Foto:
    """A foto pronta para o pipeline, em BGR (convenção do OpenCV), mais o que veio do arquivo."""
    bgr: np.ndarray
    largura: int
    altura: int
    formato: str
    tinha_alfa: bool
    girada_por_exif: bool


def _formato(dados: bytes) -> str | None:
    for assinatura, nome in ASSINATURAS:
        if dados.startswith(assinatura):
            return nome
    # WebP: "RIFF" .... "WEBP"
    if dados[:4] == b"RIFF" and dados[8:12] == b"WEBP":
        return "webp"
    return None


def decodificar(dados: bytes) -> Foto:
    if not dados:
        raise EntradaInvalida("O arquivo chegou vazio.")
    if len(dados) > config.MAX_BYTES:
        raise EntradaInvalida(
            f"Arquivo grande demais: {len(dados) / 1e6:.1f} MB, o limite é {config.MAX_BYTES / 1e6:.0f} MB."
        )

    formato = _formato(dados[:16])
    if formato is None:
        raise EntradaInvalida("Não reconheci o formato. Aceito JPEG, PNG, WebP, BMP e TIFF.")

    try:
        imagem = Image.open(io.BytesIO(dados))
        largura, altura = imagem.size
        # O teto vale sobre o tamanho declarado no cabeçalho, antes de alocar os pixels.
        if largura * altura > config.MAX_PIXELS:
            raise EntradaInvalida(
                f"Foto grande demais: {largura}×{altura}, o limite é {config.MAX_PIXELS / 1e6:.0f} megapixels."
            )
        if min(largura, altura) < config.MIN_LADO:
            raise EntradaInvalida(f"Foto pequena demais: {largura}×{altura}.")

        original = imagem.size
        imagem = ImageOps.exif_transpose(imagem)  # foto de celular costuma vir deitada
        girada = imagem.size != original

        tinha_alfa = imagem.mode in ("RGBA", "LA", "PA") or "transparency" in imagem.info
        if tinha_alfa:
            # Achata sobre branco: o destino é fundo branco, e deixar alfa aqui só espalha o caso
            # especial pelo pipeline inteiro.
            fundo = Image.new("RGBA", imagem.size, (255, 255, 255, 255))
            imagem = Image.alpha_composite(fundo, imagem.convert("RGBA"))
        imagem = imagem.convert("RGB")
    except EntradaInvalida:
        raise
    except UnidentifiedImageError as erro:
        raise EntradaInvalida("Não consegui abrir essa imagem.") from erro
    except OSError as erro:
        raise EntradaInvalida(f"A imagem parece corrompida: {erro}") from erro

    rgb = np.asarray(imagem, dtype=np.uint8)
    bgr = np.ascontiguousarray(rgb[:, :, ::-1])
    altura, largura = bgr.shape[:2]
    return Foto(
        bgr=bgr,
        largura=largura,
        altura=altura,
        formato=formato,
        tinha_alfa=tinha_alfa,
        girada_por_exif=girada,
    )
