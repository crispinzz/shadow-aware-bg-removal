"""Análise da cena: onde é tecido, e qual seria a luz dele sem produto e sem sombra.

A medição que orientou este módulo, feita na foto real `fotos-catalogo/2026-10-23/002-frente.jpg`:

    parede no alto  Lab L ~ 155
    chão            Lab L ~ 188
    assento branco  a 33 de distância do chão que o cerca

O fundo varia 136 dentro de si mesmo enquanto a peça branca está a 33 do fundo ao redor. Por isso
não existe "a cor do fundo": existe um CAMPO de luz que varia pelo quadro. Tudo aqui trabalha com
esse campo, nunca com uma cor média única.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class Cena:
    lab: np.ndarray            # float32, Lab
    campo_L: np.ndarray        # float32: luz que o tecido teria, sem produto e sem sombra
    fundo_certo: np.ndarray    # uint8 0/1: tecido alcançado a partir da borda do quadro
    tolerancia: float
    consistencia_cantos: float # 0 = cantos idênticos; alto = cenário desigual


def _borrao_mascarado(valor: np.ndarray, peso: np.ndarray, raio: int) -> np.ndarray:
    """Média de `valor` numa janela, contando só onde `peso` vale 1.

    É o que permite estimar a luz do tecido POR BAIXO do produto: o produto entra com peso zero, e a
    janela grande puxa o valor do tecido em volta. Sem isso, o escuro do produto vazaria para o campo
    e viraria halo na borda.
    """
    k = max(3, int(raio) | 1)
    soma = cv2.boxFilter(valor * peso, cv2.CV_32F, (k, k), normalize=False)
    conta = cv2.boxFilter(peso, cv2.CV_32F, (k, k), normalize=False)
    return soma / np.maximum(conta, 1e-6)


def _fundo_da_borda(dist: np.ndarray, tol: float) -> np.ndarray:
    """Tecido é o que se ALCANÇA a partir da borda do quadro andando por pixel com cor de tecido.

    Conectividade, e não só cor: uma peça branca do produto tem a cor do tecido, mas está cercada
    pelo produto e não chega à borda.
    """
    parecido = (dist < tol).astype(np.uint8)
    # moldura de 1 px com valor 1 para o componente da borda existir mesmo se o tecido encostar nela
    com_moldura = cv2.copyMakeBorder(parecido, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=1)
    _, rotulos = cv2.connectedComponents(com_moldura, connectivity=4)
    da_borda = np.unique(np.concatenate([rotulos[0], rotulos[-1], rotulos[:, 0], rotulos[:, -1]]))
    alcancado = np.isin(rotulos, da_borda)[1:-1, 1:-1]
    return alcancado.astype(np.uint8)


def analisar(bgr: np.ndarray) -> Cena:
    altura, largura = bgr.shape[:2]
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)

    # Amostra da borda. O PRD avisa, com razão, que canto não é fundo por definição: aqui os quatro
    # cantos são comparados entre si, e o quanto discordam vira um sinal de cenário desigual.
    faixa = max(4, int(min(altura, largura) * 0.02))
    anel = np.vstack([
        lab[:faixa].reshape(-1, 3), lab[-faixa:].reshape(-1, 3),
        lab[:, :faixa].reshape(-1, 3), lab[:, -faixa:].reshape(-1, 3),
    ])
    referencia = np.median(anel, axis=0)
    cantos = [
        np.median(lab[:faixa, :faixa].reshape(-1, 3), axis=0),
        np.median(lab[:faixa, -faixa:].reshape(-1, 3), axis=0),
        np.median(lab[-faixa:, :faixa].reshape(-1, 3), axis=0),
        np.median(lab[-faixa:, -faixa:].reshape(-1, 3), axis=0),
    ]
    consistencia = float(np.max([np.linalg.norm(c - referencia) for c in cantos]))

    dist = np.linalg.norm(lab - referencia, axis=2)

    # Tolerância pela variação real do próprio fundo, não por número fixo: um ciclorama com queda de
    # luz forte precisa de mais folga que um parelho. O teto evita engolir o produto.
    espalhamento = float(np.percentile(dist[np.vstack([
        np.ones((faixa, largura), bool), np.zeros((altura - 2 * faixa, largura), bool), np.ones((faixa, largura), bool),
    ])], 90))
    tol = float(np.clip(max(espalhamento, consistencia) * 1.6, 25.0, 75.0))

    fundo_certo = _fundo_da_borda(dist, tol)

    # Campo de luz: a luz do tecido estendida por baixo do produto e da sombra. Raio grande de
    # propósito — precisa ser MAIOR que a sombra, senão a sombra entra no próprio divisor e se anula.
    raio = max(9, int(max(altura, largura) * 0.18))
    L = lab[:, :, 0]
    peso = fundo_certo.astype(np.float32)
    campo = _borrao_mascarado(L, peso, raio)
    # Onde não havia nenhum tecido na janela, a conta não tem base; cai para a referência.
    vazio = cv2.boxFilter(peso, cv2.CV_32F, (max(3, raio | 1),) * 2, normalize=False) < 1e-6
    campo[vazio] = referencia[0]
    campo = cv2.GaussianBlur(campo, (0, 0), max(2.0, raio * 0.25))

    return Cena(
        lab=lab,
        campo_L=np.maximum(campo, 1.0),
        fundo_certo=fundo_certo,
        tolerancia=tol,
        consistencia_cantos=consistencia,
    )
