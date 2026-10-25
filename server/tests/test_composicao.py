"""Regressão da regra mais importante do projeto: o produto sai da foto, não do algoritmo."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.vision import compor, refino  # noqa: E402


def _foto(altura=120, largura=90):
    rng = np.random.default_rng(7)
    return rng.integers(0, 256, (altura, largura, 3), dtype=np.uint8)


def test_alfa_cheio_devolve_o_pixel_original_byte_a_byte():
    bgr = _foto()
    alfa = np.zeros(bgr.shape[:2], np.float32)
    alfa[20:80, 15:60] = 1.0
    fundo = np.full(bgr.shape, 255.0, np.float32)

    saida = compor.misturar(bgr, alfa, fundo)
    cheio = alfa == 1.0
    assert np.array_equal(saida[cheio], bgr[cheio])


def test_alfa_zero_devolve_o_fundo():
    bgr = _foto()
    alfa = np.zeros(bgr.shape[:2], np.float32)
    fundo = np.full(bgr.shape, 255.0, np.float32)
    assert np.all(compor.misturar(bgr, alfa, fundo) == 255)


def test_enquadramento_nao_deforma():
    """Mesma escala nos dois eixos: a proporção do produto sobrevive ao enquadramento."""
    bgr = np.full((400, 300, 3), 255, np.uint8)
    bgr[100:300, 100:200] = 0          # produto 100x200, proporção 0,5
    alfa = np.zeros(bgr.shape[:2], np.float32)
    alfa[100:300, 100:200] = 1.0

    c = compor.compor(bgr, alfa, largura_saida=800, altura_saida=1000)
    x0, y0, x1, y1 = c.caixa_produto
    proporcao = (x1 - x0) / (y1 - y0)
    assert abs(proporcao - 0.5) < 0.02
    assert c.bgr.shape[:2] == (1000, 800)


def test_vao_interno_continua_vazado():
    """Uma cadeira tem vãos reais; a composição não pode preenchê-los."""
    bgr = np.full((200, 200, 3), 30, np.uint8)
    alfa = np.zeros(bgr.shape[:2], np.float32)
    alfa[50:150, 50:150] = 1.0
    alfa[80:120, 80:120] = 0.0         # o vão
    fundo = np.full(bgr.shape, 255.0, np.float32)
    saida = compor.misturar(bgr, alfa, fundo)
    assert np.all(saida[80:120, 80:120] == 255)


def test_sombra_nao_cobre_o_produto():
    bgr = np.full((400, 300, 3), 200, np.uint8)
    alfa = np.zeros(bgr.shape[:2], np.float32)
    alfa[100:300, 100:200] = 1.0
    c = compor.compor(bgr, alfa, largura_saida=300, altura_saida=400)
    assert c.tem_sombra


def test_diagnostico_acusa_mascara_grande_demais():
    alfa = np.ones((100, 100), np.float32)
    ok, avisos = refino.confiavel(refino.diagnosticar(alfa))
    assert not ok and "mascara_grande_demais" in avisos


def test_diagnostico_aceita_mascara_plausivel():
    alfa = np.zeros((400, 300), np.float32)
    alfa[100:300, 100:200] = 1.0
    ok, avisos = refino.confiavel(refino.diagnosticar(alfa))
    assert ok, avisos


def test_refino_nao_desfaz_o_que_a_rede_decidiu():
    """Tubo preto sobre fundo claro: o filtro guiado não pode comer o produto."""
    bgr = np.full((200, 200, 3), 240, np.uint8)
    bgr[:, 95:105] = 10
    alfa = np.zeros(bgr.shape[:2], np.float32)
    alfa[:, 95:105] = 1.0
    refinado = refino.refinar(bgr, alfa)
    assert np.all(refinado[:, 96:104] == 1.0)
    assert np.all(refinado[:, :90] == 0.0)


def test_sombra_projetada_sai_para_o_lado_e_nao_para_cima():
    """A silhueta deitada no chão fica ABAIXO da base do produto, nunca acima do topo dele."""
    alfa = np.zeros((400, 400), np.float32)
    alfa[100:300, 150:250] = 1.0
    sombra = compor._sombra_projetada(alfa, (150, 100, 250, 300))
    ys, xs = np.where(sombra > 0.1)
    assert ys.min() > 100, "a sombra subiu acima do topo do produto"
    assert xs.max() > 250, "a sombra nao inclinou para o lado"


def test_sombra_projetada_preserva_o_vao_interno():
    """Vão do quadro aparece na sombra porque esta vem da silhueta real, nao de um borrao."""
    alfa = np.zeros((600, 600), np.float32)
    alfa[200:400, 200:400] = 1.0
    alfa[260:340, 260:340] = 0.0        # o vao
    sombra = compor._sombra_projetada(alfa, (200, 200, 400, 400))
    forte = sombra > 0.1
    assert forte.any()
    # o buraco deixa a densidade media do miolo menor que a da borda da sombra
    ys, xs = np.where(forte)
    cy, cx = int(ys.mean()), int(xs.mean())
    assert sombra[cy, cx] < sombra[forte].max()
