"""Segmentação pelo Gemini: a máscara vem da API, e nada além dela.

Mesmo contrato de `modelo.py`: entra BGR, sai `Mascara` com alfa 0..1 no tamanho da foto. O resto do
pipeline (refino, sombra, composição, exportação) não sabe de onde veio o alfa, então nada mais muda.

AVISO: ao contrário do modelo local, isto ENVIA a foto para um servidor do Google. É por isso que
só liga com STUDIO_SEGMENTADOR=gemini e uma chave explícita; o padrão continua sendo o modelo local.

A API devolve, por objeto, uma caixa `box_2d` em coordenadas 0..1000 (y0, x0, y1, x1) e uma `mask`
PNG em base64 do tamanho da caixa. A máscara cheia é a união das caixas coladas no lugar certo.
"""
from __future__ import annotations

import base64
import io
import json
import urllib.error
import urllib.request

import cv2
import numpy as np
from PIL import Image

from ..core import config
from .modelo import Mascara

LADO = 1024          # a foto é reduzida antes de subir: menos banda, e a caixa vem em 0..1000 mesmo
TEMPO_LIMITE = 120   # segundos; a chamada é síncrona dentro do trabalhador da fila

PROMPT = (
    "Segmente apenas o produto principal desta foto de estúdio (um equipamento médico ou móvel). "
    "Não inclua o tecido de fundo, o chão, a sombra nem objetos do cenário. "
    "Preserve os vãos internos: se o produto tem buracos vazados (raios de roda, abertura de "
    "assento, vão do quadro), o fundo visto através deles NÃO faz parte do produto. "
    'Responda só com JSON: uma lista de objetos com "box_2d" ([y0, x0, y1, x1] de 0 a 1000) e '
    '"mask" (PNG em base64 com data URL).'
)


class FalhaNoGemini(RuntimeError):
    """A API não respondeu ou respondeu algo que não dá para usar. Quem chama cai no modelo local."""


def configurado() -> bool:
    return bool(config.GEMINI_CHAVE)


def _chamar(jpeg: bytes) -> list[dict]:
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{config.GEMINI_MODELO}:generateContent"
    )
    corpo = json.dumps(
        {
            "contents": [
                {
                    "parts": [
                        {"text": PROMPT},
                        {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(jpeg).decode()}},
                    ]
                }
            ],
            "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
        }
    ).encode()

    pedido = urllib.request.Request(
        url,
        data=corpo,
        headers={"Content-Type": "application/json", "x-goog-api-key": config.GEMINI_CHAVE},
        method="POST",
    )
    try:
        with urllib.request.urlopen(pedido, timeout=TEMPO_LIMITE) as resposta:
            dados = json.loads(resposta.read())
    except urllib.error.HTTPError as erro:
        # O corpo do erro traz a mensagem da API; a chave nunca aparece nele.
        raise FalhaNoGemini(f"O Gemini respondeu {erro.code}: {erro.read()[:300].decode(errors='replace')}") from erro
    except (urllib.error.URLError, TimeoutError) as erro:
        raise FalhaNoGemini(f"Não consegui falar com o Gemini: {erro}") from erro

    try:
        texto = dados["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError) as erro:
        raise FalhaNoGemini("O Gemini respondeu sem máscara.") from erro

    try:
        itens = json.loads(texto)
    except json.JSONDecodeError as erro:
        raise FalhaNoGemini("O Gemini respondeu num formato que não consegui ler.") from erro
    if not isinstance(itens, list) or not itens:
        raise FalhaNoGemini("O Gemini não achou produto nesta foto.")
    return itens


def _colar(itens: list[dict], altura: int, largura: int) -> np.ndarray:
    """Cola cada máscara de caixa no quadro cheio. A união é o alfa final."""
    alfa = np.zeros((altura, largura), dtype=np.float32)
    coladas = 0
    for item in itens:
        caixa = item.get("box_2d")
        png = item.get("mask") or ""
        if not isinstance(caixa, list) or len(caixa) != 4 or "base64," not in png:
            continue
        y0, x0, y1, x1 = (max(0, min(1000, int(v))) for v in caixa)
        topo, esquerda = round(y0 / 1000 * altura), round(x0 / 1000 * largura)
        baixo, direita = round(y1 / 1000 * altura), round(x1 / 1000 * largura)
        if baixo <= topo or direita <= esquerda:
            continue
        try:
            bruta = Image.open(io.BytesIO(base64.b64decode(png.split("base64,", 1)[1]))).convert("L")
        except (ValueError, OSError):
            continue
        pedaco = cv2.resize(
            np.asarray(bruta, dtype=np.float32) / 255.0,
            (direita - esquerda, baixo - topo),
            interpolation=cv2.INTER_LINEAR,
        )
        regiao = alfa[topo:baixo, esquerda:direita]
        alfa[topo:baixo, esquerda:direita] = np.maximum(regiao, pedaco)
        coladas += 1
    if not coladas:
        raise FalhaNoGemini("O Gemini respondeu sem nenhuma máscara utilizável.")
    return np.clip(alfa, 0.0, 1.0)


def inferir(bgr: np.ndarray) -> Mascara:
    """Máscara do produto pela API. Levanta FalhaNoGemini quando não dá para usar a resposta."""
    if not configurado():
        raise FalhaNoGemini("Falta a chave do Gemini (STUDIO_GEMINI_CHAVE).")

    altura, largura = bgr.shape[:2]
    escala = min(1.0, LADO / max(altura, largura))
    enviar = (
        cv2.resize(bgr, (round(largura * escala), round(altura * escala)), interpolation=cv2.INTER_AREA)
        if escala < 1.0
        else bgr
    )
    ok, jpeg = cv2.imencode(".jpg", enviar, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if not ok:
        raise FalhaNoGemini("Não consegui preparar a foto para enviar.")

    alfa = _colar(_chamar(jpeg.tobytes()), altura, largura)
    return Mascara(
        alfa=alfa,
        modelo=f"gemini:{config.GEMINI_MODELO}",
        passadas=1,
        ocupacao=float((alfa > 0.5).mean()),
    )
