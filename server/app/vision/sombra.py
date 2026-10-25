"""Separar sombra de produto — o nó do problema, e o motivo deste módulo existir sozinho.

Medido na foto real antes de escrever qualquer linha daqui: todo método por distância de cor adota
a sombra como se fosse peça, porque sombra é escura e portanto "longe do branco da parede".

    GrabCut, retângulo automático   sombra absorvida = 1,000
    borda conectada em Lab, t=45    sombra absorvida = 0,345
    alvo deste módulo                             < 0,05

O que separa os dois não é cor, é FÍSICA:

    sombra  = o tecido recebendo menos luz   -> multiplicativa, suave, neutra, razão em [0,45; 0,97]
    produto = material opaco no lugar do tecido -> razão baixa, ou cor própria, ou MAIS claro

A peça branca do produto cai pelo último caso: nenhuma sombra deixa o tecido mais claro do que ele
seria sem ela, então razão acima de 1 só pode ser objeto. É assim que o assento branco é recuperado
sem nenhum modelo.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .cena import Cena

# Faixas da razão L/campo. Calibráveis, e a bancada é quem move.
RAZAO_OPACO = 0.45    # abaixo disto nenhuma sombra de estúdio chega: é material
RAZAO_SOMBRA = 0.97   # acima disto o tecido está praticamente com a luz cheia
RAZAO_CLARO = 1.03    # acima disto o pixel é MAIS claro que o tecido seria: só objeto faz isso
CROMA_NEUTRO = 12.0   # sombra de luz branca quase não muda a/b; objeto colorido muda


@dataclass
class Separacao:
    produto: np.ndarray   # uint8 0/1
    sombra: np.ndarray    # float32 0..1, densidade (1 = sombra cheia)
    estranhos: np.ndarray # uint8 0/1: objeto solto no cenário, colorido e alongado
    razao: np.ndarray


def _croma(lab: np.ndarray, campo_ab: np.ndarray) -> np.ndarray:
    return np.linalg.norm(lab[:, :, 1:] - campo_ab, axis=2)


def separar(cena: Cena) -> Separacao:
    L = cena.lab[:, :, 0]
    razao = L / cena.campo_L

    # a/b do tecido, estendidos como o campo de luz: a referência do que é "neutro aqui".
    campo_ab = cv2.GaussianBlur(cena.lab[:, :, 1:], (0, 0), max(3.0, min(L.shape) * 0.05))
    croma = _croma(cena.lab, campo_ab)

    resto = cena.fundo_certo == 0  # produto e sombra; o tecido alcançado pela borda já saiu

    neutro = croma < CROMA_NEUTRO
    eh_sombra = resto & neutro & (razao >= RAZAO_OPACO) & (razao <= RAZAO_SOMBRA)
    # tecido que o preenchimento não alcançou porque a sombra bloqueou o caminho
    eh_tecido = resto & neutro & (razao > RAZAO_SOMBRA) & (razao < RAZAO_CLARO)
    eh_produto = resto & ~eh_sombra & ~eh_tecido

    # Sombra é suave por natureza: o que é escuro e tem borda dura é material, não sombra.
    # Abertura remove o fiapo escuro que entrou como sombra na borda do produto.
    nucleo = np.ones((3, 3), np.uint8)
    sombra_bin = cv2.morphologyEx(eh_sombra.astype(np.uint8), cv2.MORPH_OPEN, nucleo, iterations=1)
    produto_bin = (eh_produto | (eh_sombra & ~sombra_bin.astype(bool))).astype(np.uint8)

    # Objeto estranho: colorido E alongado E fino. A ripa de madeira atravessa o quadro atrás do
    # produto; ela é amarelada, enquanto a cadeira é preta e branca. Sem o teste de cor, qualquer
    # peça fina do produto cairia aqui junto.
    estranhos = np.zeros_like(produto_bin)
    colorido = (croma >= CROMA_NEUTRO * 1.6).astype(np.uint8) * produto_bin
    n, rot, st, _ = cv2.connectedComponentsWithStats(colorido, 8)
    diagonal = float(np.hypot(*L.shape))
    for i in range(1, n):
        x, y, w, h, area = st[i]
        comprimento, espessura = max(w, h), max(1, min(w, h))
        if comprimento > diagonal * 0.25 and comprimento / espessura > 6 and area < diagonal * diagonal * 0.02:
            estranhos[rot == i] = 1
    produto_bin[estranhos == 1] = 0

    # Densidade da sombra: quanto de luz falta, em TODO pixel que não é produto.
    #
    # Medido: a sombra desta foto cai dentro de `fundo_certo` — com tolerância 52,8 o preenchimento
    # pela borda atravessa ela, porque sombra em tecido branco continua perto do branco da parede.
    # A primeira versão deste módulo só olhava `resto` e por isso NUNCA via a sombra: ela saía como
    # fundo comum e seria apagada na composição. A densidade tem de varrer o quadro inteiro.
    fora_do_produto = (produto_bin == 0) & neutro
    densidade = np.clip((1.0 - razao) / (1.0 - RAZAO_OPACO), 0.0, 1.0).astype(np.float32)
    densidade[~fora_do_produto] = 0.0
    densidade[razao > RAZAO_SOMBRA] = 0.0  # tecido com luz cheia não lança nada
    densidade = cv2.GaussianBlur(densidade, (0, 0), max(1.5, min(L.shape) * 0.004))

    return Separacao(produto=produto_bin, sombra=densidade, estranhos=estranhos, razao=razao)


def limpar(produto: np.ndarray, min_fracao: float = 0.004) -> np.ndarray:
    """Tira fragmento solto, sem comer peça fina.

    Mantém o maior componente e todo componente que encosta nele ou tem tamanho relevante — cadeira
    e andador têm partes que, em duas dimensões, aparecem separadas, então exigir um componente só
    destruiria roda e apoio.
    """
    n, rot, st, _ = cv2.connectedComponentsWithStats(produto, 8)
    if n < 2:
        return produto
    areas = st[1:, cv2.CC_STAT_AREA]
    principal = 1 + int(np.argmax(areas))
    total = produto.size
    perto = cv2.dilate((rot == principal).astype(np.uint8), np.ones((9, 9), np.uint8), iterations=3)
    saida = np.zeros_like(produto)
    for i in range(1, n):
        fatia = rot == i
        if i == principal or st[i, cv2.CC_STAT_AREA] / total >= min_fracao or np.any(fatia & (perto == 1)):
            saida[fatia] = 1
    return saida


def densidade_medida(cena: Cena, produto: np.ndarray) -> np.ndarray:
    """Quanta luz falta em cada pixel de tecido, dado um produto JÁ conhecido.

    É a metade deste módulo que sobreviveu à troca do motor. A outra metade — adivinhar o produto
    por razão e croma — saiu, porque a rede faz isso melhor (0,0705 do quadro contra 0,0996). O que
    a rede NÃO faz é isto: ela devolve alfa e joga a sombra fora junto com o fundo.

    A conta é a mesma que já estava medida: `razao = L / campo_L`, onde `campo_L` é a luz que o
    tecido teria sem produto e sem sombra. Abaixo de RAZAO_SOMBRA falta luz, e o quanto falta é a
    densidade. Varre o quadro inteiro de propósito: a sombra desta foto cai DENTRO de `fundo_certo`,
    porque sombra em tecido branco continua perto do branco da parede.
    """
    L = cena.lab[:, :, 0]
    razao = L / cena.campo_L

    campo_ab = cv2.GaussianBlur(cena.lab[:, :, 1:], (0, 0), max(3.0, min(L.shape) * 0.05))
    neutro = _croma(cena.lab, campo_ab) < CROMA_NEUTRO

    densidade = np.clip((1.0 - razao) / (1.0 - RAZAO_OPACO), 0.0, 1.0).astype(np.float32)
    densidade[produto > 0] = 0.0          # sombra não cai sobre o próprio produto
    densidade[~neutro] = 0.0              # mancha colorida é objeto do cenário, não sombra
    densidade[razao > RAZAO_SOMBRA] = 0.0 # tecido com luz cheia não lança nada
    return cv2.GaussianBlur(densidade, (0, 0), max(1.5, min(L.shape) * 0.004))
