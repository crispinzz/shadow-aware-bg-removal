"""Rede de sombra (SHARP): prediz, por pixel, quanto o objeto escureceu o fundo.

É a parte que nenhum removedor de fundo tem — um fator contínuo em [0.3, 1], onde 1 é fundo
intocado e 0.6 é um pixel que o objeto baixou para 60%. Treinada em training/train_shadow.py (ISTD)
e exportada para ONNX; roda em ONNX Runtime na CPU, igual ao BiRefNet.

O analítico em src/backdrop.ts divide o fundo pela luz que ele teria; serve num ciclorama liso e
falha em fundo texturizado/colorido, sombra que sobe a parede, duas luzes ou objeto translúcido. A
rede aprende esses casos. Entrada: BGR / 255 em 256 px (como no treino, sem média/desvio). Saída: o
fator no tamanho da foto.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path

import cv2
import numpy as np

PASTA = Path(__file__).resolve().parents[2] / "modelos"
NOME = "shadow-matte"
LADO = 256  # lado do export; a sombra é um campo liso, resolve baixo e sobe sem perda visível
THREADS = max(1, (os.cpu_count() or 4) // 2)

_sessao = None
_trava = threading.Lock()


def caminho() -> Path:
    return PASTA / f"{NOME}.onnx"


def pronto() -> bool:
    return caminho().exists()


def carregado() -> bool:
    return _sessao is not None


def _carregar():
    global _sessao
    if _sessao is not None:
        return _sessao
    with _trava:
        if _sessao is not None:
            return _sessao
        import onnxruntime

        opcoes = onnxruntime.SessionOptions()
        opcoes.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
        opcoes.intra_op_num_threads = THREADS
        _sessao = onnxruntime.InferenceSession(
            str(caminho()), opcoes, providers=["CPUExecutionProvider"]
        )
        return _sessao


def prever_fator(bgr: np.ndarray) -> np.ndarray:
    """Mapa de fator da sombra (0.3..1, 1 = fundo intocado), no tamanho de `bgr`."""
    sessao = _carregar()
    altura, largura = bgr.shape[:2]
    # O treino alimentou BGR / 255 direto (cv2.imread), sem normalização; espelhamos isso aqui.
    pequena = cv2.resize(bgr, (LADO, LADO), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    tensor = pequena.transpose(2, 0, 1)[None]
    saida = sessao.run(None, {sessao.get_inputs()[0].name: tensor})[0]
    mapa = np.asarray(saida, dtype=np.float32).squeeze()
    return cv2.resize(mapa, (largura, altura), interpolation=cv2.INTER_LINEAR)
