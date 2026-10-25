"""Refino da máscara em resolução cheia — só a máscara, nunca o produto.

A rede trabalha em 1024x1024. Numa foto de 3000x4000 isso é um fator de 3,5: a borda de um tubo de
20 px vira menos de 6 px na entrada da rede, e volta ampliada e mole. O refino existe para devolver
a borda à geometria real da fotografia.

Tudo aqui modifica ALFA. Nenhuma função deste módulo escreve um pixel RGB do produto (aditivo §4).

O filtro guiado é a peça central: ele reencosta a máscara nas bordas da imagem original. Está escrito
à mão com `boxFilter` porque é meia dúzia de linhas e evita depender do opencv-contrib, que nem
sempre tem roda para esta versão de Python.
"""
from __future__ import annotations

import cv2
import numpy as np

EPSILON = 1e-4        # tolerância do filtro guiado: baixa = cola mais na borda da foto
RAIO_RELATIVO = 0.002 # raio do filtro em fração do lado maior
FAIXA_DUVIDA = 0.15   # abaixo disto é fundo certo, acima de 1-isto é produto certo


def _filtro_guiado(guia: np.ndarray, alvo: np.ndarray, raio: int, eps: float) -> np.ndarray:
    """Filtro guiado de He et al., em cinza. `guia` e `alvo` em float32 0..1."""
    k = (max(3, int(raio) | 1),) * 2
    media_g = cv2.boxFilter(guia, cv2.CV_32F, k)
    media_a = cv2.boxFilter(alvo, cv2.CV_32F, k)
    cov = cv2.boxFilter(guia * alvo, cv2.CV_32F, k) - media_g * media_a
    var = cv2.boxFilter(guia * guia, cv2.CV_32F, k) - media_g * media_g
    a = cov / (var + eps)
    b = media_a - a * media_g
    return cv2.boxFilter(a, cv2.CV_32F, k) * guia + cv2.boxFilter(b, cv2.CV_32F, k)


def refinar(bgr: np.ndarray, alfa: np.ndarray) -> np.ndarray:
    """Encosta o alfa nas bordas da foto original, sem engrossar nem afinar o produto.

    Só a faixa de dúvida muda. O miolo do produto continua 1 e o fundo longe continua 0, para que
    nenhuma peça fina seja comida e nenhum resto de tecido seja promovido a produto.
    """
    altura, largura = bgr.shape[:2]
    raio = max(3, int(max(altura, largura) * RAIO_RELATIVO))
    guia = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0

    refinado = np.clip(_filtro_guiado(guia, alfa.astype(np.float32), raio, EPSILON), 0.0, 1.0)

    # Fora da faixa de dúvida a rede já decidiu, e o filtro guiado não tem o direito de desfazer:
    # é o que impede o tubo preto de ser comido pelo fundo claro em volta dele.
    certo_fundo = alfa < FAIXA_DUVIDA
    certo_produto = alfa > 1.0 - FAIXA_DUVIDA
    refinado[certo_fundo] = 0.0
    refinado[certo_produto] = 1.0
    return refinado


def diagnosticar(alfa: np.ndarray) -> dict:
    """Sinais de máscara ruim (aditivo §9). Números, não veredito."""
    forte = (alfa > 0.5).astype(np.uint8)
    fracao = float(forte.mean())
    n, _, st, _ = cv2.connectedComponentsWithStats(forte, 8)
    areas = sorted((int(st[i, cv2.CC_STAT_AREA]) for i in range(1, n)), reverse=True)
    maior = areas[0] if areas else 0
    # Fragmento solto: pedaço pequeno e longe do corpo principal costuma ser resto de cenário.
    soltos = sum(1 for a in areas[1:] if a > forte.size * 0.0002)
    # Borda mole demais: muita área com alfa no meio do caminho indica máscara sem geometria.
    meio = float(((alfa > 0.2) & (alfa < 0.8)).mean())
    return {
        "fracao_produto": round(fracao, 4),
        "componentes_soltos": soltos,
        "maior_componente": round(maior / max(1, int(forte.sum())), 4) if forte.any() else 0.0,
        "borda_indecisa": round(meio, 4),
    }


def confiavel(d: dict) -> tuple[bool, list[str]]:
    """Traduz os números em avisos. Não existe 'máscara perfeita' aqui, só ausência de sinal ruim."""
    avisos: list[str] = []
    if d["fracao_produto"] > 0.6:
        avisos.append("mascara_grande_demais")
    if d["fracao_produto"] < 0.005:
        avisos.append("mascara_pequena_demais")
    if d["maior_componente"] < 0.6:
        avisos.append("produto_fragmentado")
    if d["componentes_soltos"] > 6:
        avisos.append("fragmentos_soltos")
    if d["borda_indecisa"] > 0.08:
        avisos.append("borda_indecisa")
    return (not avisos), avisos
