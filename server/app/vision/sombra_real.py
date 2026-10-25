"""A sombra que o produto realmente lançou, medida — não inventada.

Por que isto existe: a rede devolve alfa e joga a sombra fora junto com o fundo. Sombra de contato
sintética resolve "não parecer flutuando", mas não é o que a foto de referência mostra. Naquela
imagem a sombra é comprida, cai para o lado e desenha as rodas e os vãos do quadro. Nenhuma sombra
sintética derivada da silhueta produz isso, porque a informação é a geometria da luz do estúdio.

A física que separa sombra de produto:

    sombra  = o tecido recebendo MENOS luz -> multiplicativa, suave, neutra, razão em [0,45; 0,97]
    produto = material opaco no lugar do tecido -> a rede já disse onde está

Antes, sem a rede, este módulo tinha de adivinhar as duas coisas ao mesmo tempo, e era aí que ele
engolia a cadeira. Agora o produto vem pronto, e sobra só a parte fácil: quanta luz falta em cada
pixel que não é produto.

O campo de luz — a luz que o tecido teria sem sombra — é estimado por iteração: estima, vê quem
ficou escuro demais, tira essa gente da conta e estima de novo. Sem isso a própria sombra entra no
divisor e se anula.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .cena import _borrao_mascarado

RAZAO_OPACO = 0.45     # abaixo disto nenhuma sombra de estúdio chega: é material
RAZAO_SOMBRA = 0.97    # acima disto o tecido está praticamente com a luz cheia
CROMA_NEUTRO = 14.0    # sombra de luz branca quase não muda a/b; objeto colorido muda
ITERACOES = 3
RAIO_CAMPO = 0.18      # raio do campo em fração do lado maior: tem de ser MAIOR que a sombra
GANHO = 1.0            # quanto da densidade medida vira escurecimento no fundo novo


@dataclass
class Sombra:
    densidade: np.ndarray   # float32 0..1, 1 = sombra cheia
    cobertura: float        # fração do quadro com sombra perceptível
    confiavel: bool
    motivo: str


def medir(bgr: np.ndarray, produto: np.ndarray) -> Sombra:
    """Densidade da sombra real. `produto` é o alfa da rede, 0..1, no mesmo tamanho de `bgr`."""
    altura, largura = bgr.shape[:2]
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    L = lab[:, :, 0]

    eh_produto = produto > 0.5
    # Uma folga em volta do produto: a borda tem mistura de produto e fundo, e ela entraria na conta
    # como "escuro", virando um contorno de sombra grudado na cadeira.
    folga = max(3, int(max(altura, largura) * 0.004)) | 1
    perto_do_produto = cv2.dilate(eh_produto.astype(np.uint8), np.ones((folga, folga), np.uint8)) > 0

    raio = max(9, int(max(altura, largura) * RAIO_CAMPO))
    peso = (~perto_do_produto).astype(np.float32)
    campo = _borrao_mascarado(L, peso, raio)

    # Iteração: quem está escuro demais é sombra, e sombra não pode ajudar a estimar a luz cheia.
    for _ in range(ITERACOES - 1):
        razao = L / np.maximum(campo, 1.0)
        peso = ((~perto_do_produto) & (razao > RAZAO_SOMBRA)).astype(np.float32)
        if peso.sum() < peso.size * 0.02:
            break  # quase tudo é sombra: a estimativa anterior é a melhor que dá
        campo = _borrao_mascarado(L, peso, raio)

    campo = np.maximum(cv2.GaussianBlur(campo, (0, 0), max(2.0, raio * 0.25)), 1.0)
    razao = L / campo

    # Neutra: sombra de luz branca não tinge. A ripa de madeira do fundo é amarelada e cai fora aqui.
    campo_ab = cv2.GaussianBlur(lab[:, :, 1:], (0, 0), max(3.0, min(altura, largura) * 0.05))
    croma = np.linalg.norm(lab[:, :, 1:] - campo_ab, axis=2)

    densidade = np.clip((1.0 - razao) / (1.0 - RAZAO_OPACO), 0.0, 1.0).astype(np.float32)
    densidade[perto_do_produto] = 0.0        # onde há produto não há o que escurecer
    densidade[razao > RAZAO_SOMBRA] = 0.0    # tecido com luz cheia não lança nada
    densidade[croma >= CROMA_NEUTRO] = 0.0   # colorido: é objeto no cenário, não sombra
    densidade = cv2.GaussianBlur(densidade, (0, 0), max(1.5, min(altura, largura) * 0.003))
    densidade = np.clip(densidade * GANHO, 0.0, 1.0)

    cobertura = float((densidade > 0.05).mean())
    confiavel, motivo = _avaliar(densidade, cobertura, eh_produto)
    return Sombra(densidade=densidade, cobertura=cobertura, confiavel=confiavel, motivo=motivo)


def _avaliar(densidade: np.ndarray, cobertura: float, produto: np.ndarray) -> tuple[bool, str]:
    """A sombra real só entra se der para confiar. Senão o §8 manda preferir a sintética discreta."""
    if cobertura < 0.002:
        return False, "quase nenhuma sombra encontrada"
    if cobertura > 0.45:
        return False, "sombra grande demais: provavelmente é o cenário inteiro"

    # Sombra encosta no produto. Mancha longe de tudo é ruga de tecido ou objeto, não sombra.
    if produto.any():
        ys, xs = np.where(produto)
        altura, largura = densidade.shape
        margem_y = int(altura * 0.12)
        margem_x = int(largura * 0.12)
        perto = np.zeros_like(densidade, dtype=bool)
        perto[max(0, ys.min() - margem_y):min(altura, ys.max() + margem_y),
              max(0, xs.min() - margem_x):min(largura, xs.max() + margem_x)] = True
        forte = densidade > 0.08
        if forte.any() and float(forte[perto].sum()) / float(forte.sum()) < 0.6:
            return False, "a sombra encontrada está espalhada longe do produto"

    return True, "sombra real medida"
