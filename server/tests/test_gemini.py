"""O que o Gemini devolve vira alfa no lugar certo, e resposta ruim não passa."""
from __future__ import annotations

import base64
import io

import numpy as np
import pytest
from PIL import Image

from app.vision import gemini


def _mascara_png(largura: int, altura: int, valor: int = 255) -> str:
    buffer = io.BytesIO()
    Image.fromarray(np.full((altura, largura), valor, dtype=np.uint8), mode="L").save(buffer, "PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


def test_cola_a_caixa_no_lugar_certo():
    # metade de baixo do quadro, cheia
    itens = [{"box_2d": [500, 0, 1000, 1000], "mask": _mascara_png(50, 50)}]
    alfa = gemini._colar(itens, altura=100, largura=100)
    assert alfa.shape == (100, 100)
    assert alfa[75, 50] == pytest.approx(1.0)
    assert alfa[25, 50] == pytest.approx(0.0)


def test_une_duas_caixas():
    itens = [
        {"box_2d": [0, 0, 500, 1000], "mask": _mascara_png(20, 20)},
        {"box_2d": [500, 0, 1000, 1000], "mask": _mascara_png(20, 20)},
    ]
    alfa = gemini._colar(itens, altura=100, largura=100)
    assert alfa.min() == pytest.approx(1.0)


def test_item_sem_mascara_ou_caixa_invalida_e_ignorado():
    itens = [
        {"box_2d": [0, 0, 100, 100]},                      # sem mask
        {"mask": _mascara_png(10, 10)},                    # sem box_2d
        {"box_2d": [900, 0, 100, 100], "mask": _mascara_png(10, 10)},  # caixa invertida
        {"box_2d": [0, 0, 500, 500], "mask": _mascara_png(10, 10)},    # esta vale
    ]
    alfa = gemini._colar(itens, altura=100, largura=100)
    assert alfa[25, 25] == pytest.approx(1.0)
    assert alfa[75, 75] == pytest.approx(0.0)


def test_resposta_sem_nada_utilizavel_falha():
    with pytest.raises(gemini.FalhaNoGemini):
        gemini._colar([{"box_2d": [0, 0, 100, 100]}], altura=100, largura=100)


def test_sem_chave_nao_tenta_chamar(monkeypatch):
    monkeypatch.setattr(gemini.config, "GEMINI_CHAVE", "")
    with pytest.raises(gemini.FalhaNoGemini, match="chave"):
        gemini.inferir(np.zeros((40, 40, 3), dtype=np.uint8))
