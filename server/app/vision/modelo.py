"""Segmentador local: a rede diz ONDE está o produto, e nada além disso.

A rede não produz nenhum pixel que chegue à imagem final. A saída daqui é só um alfa; os pixels RGB
do produto continuam vindo da fotografia original (aditivo §4).

Modelo: BiRefNet-general, entrada 1024x1024, ONNX Runtime em CPU.
Licença dos pesos: MIT, de ZhengPeng7/BiRefNet. Fonte, versão e md5 ficam em `baixar_modelo.py` —
é o único lugar que baixa qualquer coisa, e ele roda na instalação, nunca no processamento (§13).

Medido antes disto, na foto real `fotos-catalogo/2026-10-23/002-frente.jpg`:

    motor clássico (cor + conectividade)  fração do produto 0,0996   assento coberto 0,843
    real                                                    0,066                    1,0

O clássico marcava 50% de quadro a mais do que existe de cadeira e perdia 16% do assento branco.
É por isso que a máscara passou a ser de rede. A sombra continua clássica, em `sombra.py`: a rede
devolve alfa e joga a sombra fora junto com o fundo.
"""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

LADO = 1024
MEDIA = np.array([0.485, 0.456, 0.406], dtype=np.float32)
DESVIO = np.array([0.229, 0.224, 0.225], dtype=np.float32)

PASTA = Path(__file__).resolve().parents[2] / "modelos"

# Dois modelos da mesma família e da mesma licença. O leve é o padrão porque mede igual ao grande
# nesta foto (fração do produto 0,071 contra 0,0705) com 224 MB em vez de 973 MB e cerca de metade
# do tempo. O grande é a recuperação do §9: quando o diagnóstico do leve acusa máscara ruim, vale a
# pena pagar o tempo dele e comparar as duas.
NOME = os.environ.get("STUDIO_MODELO", "birefnet-general-lite")
RECUPERACAO = "birefnet-general"

# Oversubscrever as threads lógicas piora: medido 84 s com 16 contra 23 s com 8 nesta máquina.
THREADS = max(1, (os.cpu_count() or 4) // 2)

# Segunda passada: só vale a pena quando o produto é pequeno no quadro, porque aí a primeira passada
# gastou a maior parte dos 1024 px em tecido. Acima disto a primeira passada já viu o produto grande.
OCUPACAO_PARA_SEGUNDA = 0.33
FOLGA_RECORTE = 0.12  # margem em volta da caixa, para não cortar peça fina na borda do recorte (§5-B)

_sessoes: dict[str, object] = {}
_trava = threading.Lock()


class ModeloAusente(RuntimeError):
    pass


@dataclass
class Mascara:
    alfa: np.ndarray       # float32 0..1, resolução da imagem recebida
    modelo: str
    passadas: int
    ocupacao: float        # fração do quadro com alfa acima de 0,5


def caminho(nome: str = NOME) -> Path:
    return PASTA / f"{nome}.onnx"


def carregar(nome: str = NOME):
    """Carrega os pesos uma vez por modelo e reusa em todos os trabalhos (§13).

    Seguro entre as threads da fila: a trava cobre a criação, e depois é só leitura do dicionário.
    """
    pronta = _sessoes.get(nome)
    if pronta is not None:
        return pronta
    with _trava:
        if nome in _sessoes:
            return _sessoes[nome]
        arquivo = caminho(nome)
        if not arquivo.exists():
            raise ModeloAusente(
                f"Pesos de {nome} não encontrados em {arquivo}. "
                f"Rode `python baixar_modelo.py {nome}` uma vez."
            )
        import onnxruntime

        opcoes = onnxruntime.SessionOptions()
        opcoes.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
        opcoes.intra_op_num_threads = THREADS
        _sessoes[nome] = onnxruntime.InferenceSession(
            str(arquivo), opcoes, providers=["CPUExecutionProvider"]
        )
        return _sessoes[nome]


def pronto(nome: str = NOME) -> bool:
    return caminho(nome).exists()


def carregado(nome: str = NOME) -> bool:
    return nome in _sessoes


def _inferir_bloco(bgr: np.ndarray, nome: str) -> np.ndarray:
    """Uma passada da rede. Devolve alfa 0..1 no tamanho de `bgr`."""
    sessao = carregar(nome)
    altura, largura = bgr.shape[:2]
    pequena = cv2.resize(bgr, (LADO, LADO), interpolation=cv2.INTER_AREA)
    rgb = cv2.cvtColor(pequena, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    tensor = ((rgb - MEDIA) / DESVIO).transpose(2, 0, 1)[None]

    saida = sessao.run(None, {sessao.get_inputs()[0].name: tensor})
    # A rede devolve uma pilha de mapas em várias escalas; o primeiro é o de maior resolução.
    mapa = saida[0] if not isinstance(saida[0], list) else saida[0][0]
    mapa = np.asarray(mapa, dtype=np.float32).squeeze()
    if mapa.ndim == 3:
        mapa = mapa[0]
    # Alguns exports já saem com sigmoide aplicada; detecta pelo intervalo em vez de supor.
    if mapa.min() < 0.0 or mapa.max() > 1.0:
        mapa = 1.0 / (1.0 + np.exp(-mapa))
    return cv2.resize(mapa, (largura, altura), interpolation=cv2.INTER_LINEAR)


def inferir(bgr: np.ndarray, nome: str = NOME) -> Mascara:
    """Máscara da rede, com segunda passada no recorte quando o produto é pequeno no quadro."""
    altura, largura = bgr.shape[:2]
    alfa = _inferir_bloco(bgr, nome)
    passadas = 1

    forte = alfa > 0.5
    if not forte.any():
        return Mascara(alfa=alfa, modelo=nome, passadas=1, ocupacao=0.0)

    ys, xs = np.where(forte)
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    ocupacao = max((x1 - x0) / largura, (y1 - y0) / altura)

    if ocupacao < OCUPACAO_PARA_SEGUNDA:
        folga_x = int((x1 - x0) * FOLGA_RECORTE) + 8
        folga_y = int((y1 - y0) * FOLGA_RECORTE) + 8
        cx0, cx1 = max(0, x0 - folga_x), min(largura, x1 + folga_x)
        cy0, cy1 = max(0, y0 - folga_y), min(altura, y1 + folga_y)
        recorte = _inferir_bloco(bgr[cy0:cy1, cx0:cx1], nome)
        passadas = 2
        # A segunda passada manda dentro do recorte; fora dele a primeira continua valendo, e com
        # isso um pedaço do produto que ficou fora da caixa não é apagado pelo recorte.
        alfa = alfa.copy()
        alfa[cy0:cy1, cx0:cx1] = np.maximum(alfa[cy0:cy1, cx0:cx1] * 0.25, recorte)

    return Mascara(
        alfa=np.clip(alfa, 0.0, 1.0),
        modelo=nome,
        passadas=passadas,
        ocupacao=float((alfa > 0.5).mean()),
    )
