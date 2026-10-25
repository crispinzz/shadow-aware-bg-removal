"""Composição: fundo branco recriado, sombra de contato sintética, pixels originais do produto.

Ordem, e o motivo dela (aditivo §4): compõe em resolução ORIGINAL, e só depois enquadra. Assim, no
momento da composição, todo pixel com alfa 1 sai byte a byte igual ao da fotografia — não há
reamostragem entre a foto e a saída da mistura. O enquadramento é a última etapa, e é o único ponto
onde o produto é reamostrado, sem deformar (mesma escala nos dois eixos).

    C_saida = alfa * C_original + (1 - alfa) * C_fundo

A sombra é sintética e discreta, derivada da própria máscara (§8). A sombra fotografada não é
transportada: ela vem grudada em ruga de tecido e na madeira do cenário.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

BRANCO = 255.0

MARGEM = 0.07          # folga em volta do produto no quadro de catálogo
SOMBRA_OPACIDADE = 0.30     # opacidade da sombra de contato sintética
SOMBRA_REAL_OPACIDADE = 0.55  # a sombra medida pode ser mais forte: ela tem a forma certa
SOMBRA_ACHATAMENTO = 0.14   # altura da sombra como fração da altura do produto
SOMBRA_BORRAO = 0.030       # desfoque como fração da largura do produto
SOMBRA_FATIA = 0.10         # fatia de baixo do produto que gera a sombra (os pontos de apoio)

# Sombra projetada: a silhueta inteira deitada no chão, como uma luz alta e de lado produz. É a
# forma REAL do produto — roda, vão do quadro e abertura do assento aparecem nela porque estão na
# máscara. O que é escolha nossa é só a direção e a altura da luz.
PROJ_ACHATA = 0.42   # quanto a silhueta encolhe na vertical ao deitar (altura da luz)
PROJ_INCLINA = 0.62  # deslocamento lateral por unidade de altura (direção da luz)
PROJ_OPACIDADE = 0.34
PROJ_BORRAO = 0.035  # desfoque na ponta, em fração da largura do produto; junto ao apoio é menor


@dataclass
class Composicao:
    bgr: np.ndarray
    caixa_produto: tuple[int, int, int, int]
    fracao_produto: float
    tem_sombra: bool
    sombra: str  # "real" ou "contato"


def _sombra_projetada(alfa: np.ndarray, caixa: tuple[int, int, int, int]) -> np.ndarray:
    """Deita a silhueta no chão: encolhe na vertical e inclina para o lado, ancorada na base.

    O desfoque cresce com a distância do ponto de apoio, que é como sombra real se comporta: nítida
    onde o objeto toca o chão e cada vez mais macia conforme se afasta.
    """
    altura, largura = alfa.shape[:2]
    x0, y0, x1, y1 = caixa
    base = float(y1)

    # (x, y) -> (x + inclina * (base - y), base - achata * (base - y))
    M = np.array(
        [[1.0, -PROJ_INCLINA, PROJ_INCLINA * base],
         [0.0, PROJ_ACHATA, base * (1.0 - PROJ_ACHATA)]], dtype=np.float32
    )
    deitada = cv2.warpAffine(
        alfa.astype(np.float32), M, (largura, altura),
        flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0,
    )

    # Desfoque por faixas: perto da base quase nada, longe bem macio. Três faixas bastam, e a soma
    # com peso evita a emenda visível entre elas.
    largura_produto = max(1, x1 - x0)
    alcance = max(2.0, PROJ_ACHATA * (y1 - y0))
    distancia = np.clip((base - np.arange(altura, dtype=np.float32)) / alcance, 0.0, 1.0)[:, None]
    suave = np.zeros_like(deitada)
    for fatia, (menor, maior) in enumerate(((0.0, 0.34), (0.34, 0.67), (0.67, 1.0))):
        sigma = max(1.5, largura_produto * PROJ_BORRAO * (0.25 + fatia))
        peso = np.clip((distancia - menor) / (maior - menor), 0.0, 1.0) * np.clip((maior + 0.33 - distancia) / 0.33, 0.0, 1.0)
        suave += cv2.GaussianBlur(deitada, (0, 0), sigma) * peso
    return np.clip(suave, 0.0, 1.0)


def _sombra_de_contato(alfa: np.ndarray, caixa: tuple[int, int, int, int]) -> np.ndarray:
    """Sombra no chão a partir dos pontos de apoio: achatada, desfocada e fraca.

    Sai da fatia de baixo do produto — rodas e pés — e não da silhueta inteira, senão a cadeira
    ganha um borrão com o formato do encosto, que nenhuma luz de estúdio produz.
    """
    x0, y0, x1, y1 = caixa
    altura_produto = max(1, y1 - y0)
    largura_produto = max(1, x1 - x0)

    apoio = np.zeros_like(alfa, dtype=np.float32)
    inicio = max(y0, int(y1 - altura_produto * SOMBRA_FATIA))
    apoio[inicio:y1, x0:x1] = alfa[inicio:y1, x0:x1]
    if apoio.max() <= 0:
        return np.zeros_like(alfa, dtype=np.float32)

    # Achata contra o chão: a mesma mancha, esmagada na vertical e ancorada na base do produto.
    altura_sombra = max(2, int(altura_produto * SOMBRA_ACHATAMENTO))
    faixa = apoio[inicio:y1, :]
    esmagada = cv2.resize(faixa, (alfa.shape[1], altura_sombra), interpolation=cv2.INTER_AREA)

    sombra = np.zeros_like(alfa, dtype=np.float32)
    topo = min(alfa.shape[0] - altura_sombra, max(0, y1 - altura_sombra // 2))
    sombra[topo:topo + altura_sombra, :] = esmagada

    borrao = max(3, int(largura_produto * SOMBRA_BORRAO)) | 1
    sombra = cv2.GaussianBlur(sombra, (borrao, borrao), 0)
    return np.clip(sombra / max(1e-6, sombra.max()), 0.0, 1.0)


def compor(
    bgr: np.ndarray,
    alfa: np.ndarray,
    sombra_real: np.ndarray | None = None,
    largura_saida: int = 1600,
    altura_saida: int = 2133,
) -> Composicao:
    """Compõe sobre branco. Com `sombra_real` usa a sombra medida; sem ela, a de contato sintética.

    A sombra medida é a que a foto de referência mostra: comprida, caindo para o lado, desenhando as
    rodas e os vãos do quadro. Nenhuma sombra derivada da silhueta produz isso, porque a forma vem da
    geometria da luz do estúdio, e essa informação só existe na fotografia.
    """
    forte = alfa > 0.5
    if not forte.any():
        raise ValueError("Não achei o produto nesta foto.")

    ys, xs = np.where(forte)
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1

    if sombra_real is not None:
        sombra, opacidade, tipo = sombra_real.astype(np.float32), SOMBRA_REAL_OPACIDADE, "real"
    else:
        sombra, opacidade, tipo = _sombra_projetada(alfa, (x0, y0, x1, y1)), PROJ_OPACIDADE, "projetada"
    sombra = np.clip(sombra, 0.0, 1.0)
    sombra[forte] = 0.0  # sombra nunca cai por cima do próprio produto

    # Fundo branco recriado, escurecido só pela sombra. Nada do cenário original sobrevive: a sombra
    # entra como fator multiplicativo medido, não como pedaço de tecido copiado.
    fundo = np.full(bgr.shape, BRANCO, dtype=np.float32)
    fundo *= (1.0 - opacidade * sombra)[:, :, None]

    cheio = misturar(bgr, alfa, fundo)

    # Enquadra pelo PRODUTO, não pelo conteúdo: a sombra real estica muito para um lado e puxaria a
    # cadeira para fora do centro. Ela entra no quadro se couber, e é cortada se não couber.
    recortada, caixa = _enquadrar(cheio, (x0, y0, x1, y1), largura_saida, altura_saida)
    return Composicao(
        bgr=recortada,
        caixa_produto=caixa,
        fracao_produto=float(forte.mean()),
        tem_sombra=bool(sombra.max() > 0.05),
        sombra=tipo,
    )


def misturar(bgr: np.ndarray, alfa: np.ndarray, fundo: np.ndarray) -> np.ndarray:
    """C_saida = alfa * C_original + (1 - alfa) * C_fundo.

    Com alfa 1 o resultado é o pixel original byte a byte: `a` vale exatamente 1.0, o termo do fundo
    zera, e o valor inteiro de entrada sobrevive ao ida e volta por float32. O teste de regressão
    `tests/test_composicao.py` existe para que isso continue verdade.
    """
    a = alfa.astype(np.float32)[:, :, None]
    return np.clip(bgr.astype(np.float32) * a + fundo * (1.0 - a), 0, 255).astype(np.uint8)


def _enquadrar(
    imagem: np.ndarray, caixa: tuple[int, int, int, int], largura_saida: int, altura_saida: int
) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    """Centraliza o produto no formato de catálogo. Mesma escala nos dois eixos: nada de esticar."""
    x0, y0, x1, y1 = caixa
    largura_produto, altura_produto = max(1, x1 - x0), max(1, y1 - y0)

    escala = min(
        largura_saida * (1 - 2 * MARGEM) / largura_produto,
        altura_saida * (1 - 2 * MARGEM) / altura_produto,
    )
    M = np.array(
        [[escala, 0.0, largura_saida / 2 - escala * (x0 + x1) / 2],
         [0.0, escala, altura_saida / 2 - escala * (y0 + y1) / 2]], dtype=np.float32
    )
    saida = cv2.warpAffine(
        imagem, M, (largura_saida, altura_saida),
        flags=cv2.INTER_AREA if escala < 1 else cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255),
    )
    nova = (
        int(largura_saida / 2 - escala * largura_produto / 2),
        int(altura_saida / 2 - escala * altura_produto / 2),
        int(largura_saida / 2 + escala * largura_produto / 2),
        int(altura_saida / 2 + escala * altura_produto / 2),
    )
    return saida, nova
