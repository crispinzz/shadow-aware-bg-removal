"""Orquestração: da foto recebida ao arquivo pronto.

    modelo local -> alfa -> refino em alta resolução -> sombra medida -> composição com pixels
    originais -> fundo branco -> exportação

A rede só decide ONDE está o produto. Os pixels do produto saem da fotografia original, sempre.
Nenhuma etapa gera, redesenha ou retoca material (aditivo §4).
"""
from __future__ import annotations

import time
from typing import Any

import cv2

from ..core import config
from ..core.trabalhos import Cancelado, Trabalho
from ..core.trabalhos import fila as fila_padrao
from . import compor, entrada, exportar, gemini, modelo, refino, sombra_real


def _base_do_nome(nome: str) -> str:
    """Nome de arquivo seguro para a saída. O nome enviado nunca vira caminho; só inspira o rótulo."""
    limpo = "".join(c for c in nome.rsplit(".", 1)[0] if c.isalnum() or c in "-_")[:40]
    return f"{limpo or 'foto'}_tratada"


def processar(trabalho: Trabalho, dados: bytes, fila=fila_padrao) -> None:
    """Roda o pipeline inteiro. Levanta Cancelado se o trabalho foi cancelado no caminho."""
    inicio = time.perf_counter()

    def checar_cancelamento() -> None:
        if trabalho.cancelado.is_set():
            raise Cancelado()

    checar_cancelamento()
    foto = entrada.decodificar(dados)
    if foto.girada_por_exif:
        trabalho.metricas["girada_por_exif"] = True

    checar_cancelamento()
    comeco_rede = time.perf_counter()
    mascara, alfa, diagnostico, avisos, recuperou = _mascara_com_recuperacao(
        foto.bgr, checar_cancelamento
    )
    ms_rede = round((time.perf_counter() - comeco_rede) * 1000)
    trabalho.avisos.extend(avisos)
    if recuperou:
        trabalho.avisos.append("recuperado_com_modelo_alternativo")

    checar_cancelamento()
    # A sombra real é medida numa versão reduzida: ela varia devagar, e medir em 12 MP custa caro
    # sem mudar a decisão. O que volta ampliado é a densidade, não pixel de tecido.
    # Medimos a sombra real para registrar o que a foto tem, mas ela só entra na composição quando
    # o avaliador confia nela. Neste set há DUAS luzes: as sombras saem fracas, cruzadas e grudadas
    # na ruga do tecido, e o avaliador recusa. Aí vale a projetada, cuja forma é a silhueta real.
    sombra = _medir_sombra(foto.bgr, alfa)
    usar_real = sombra.confiavel and config.SOMBRA_REAL
    composicao = compor.compor(foto.bgr, alfa, sombra.densidade if usar_real else None)

    checar_cancelamento()
    assert trabalho.pasta is not None
    caminhos = exportar.gravar(composicao.bgr, trabalho.pasta, _base_do_nome(trabalho.nome_original))
    # Máscara para diagnóstico, nunca no lugar da foto: é o que mostra se o erro foi da inferência,
    # do refino ou da composição (aditivo §11).
    caminhos["mascara"] = exportar.gravar_mascara(
        alfa, trabalho.pasta, _base_do_nome(trabalho.nome_original) + "_mascara"
    )
    for formato, caminho in caminhos.items():
        fila.registrar_saida(
            trabalho,
            formato,
            caminho,
            tipo="image/jpeg" if formato == "jpg" else "image/png",
            nome=caminho.name,
        )

    trabalho.metricas.update(
        {
            "largura": foto.largura,
            "altura": foto.altura,
            "megapixels": round(foto.largura * foto.altura / 1e6, 2),
            "formato_entrada": foto.formato,
            "tinha_alfa": foto.tinha_alfa,
            "motor": config.MOTOR,
            "modelo": mascara.modelo,
            "recuperacao_usada": recuperou,
            "passadas_do_modelo": mascara.passadas,
            "ms_inferencia": ms_rede,
            "etapas": ["entrada", "modelo", "refino", "composicao", "exportacao"],
            "segmentacao_aplicada": True,
            "tem_sombra": composicao.tem_sombra,
            "sombra": composicao.sombra,
            "sombra_cobertura": round(sombra.cobertura, 4),
            "sombra_motivo": sombra.motivo,
            **diagnostico,
            "ms": round((time.perf_counter() - inicio) * 1000),
        }
    )


def _medir_sombra(bgr, alfa):
    """Mede a sombra real em resolução de análise e devolve a densidade no tamanho da foto."""
    altura, largura = bgr.shape[:2]
    escala = min(1.0, config.LADO_ANALISE / max(altura, largura))
    if escala < 1.0:
        destino = (max(1, round(largura * escala)), max(1, round(altura * escala)))
        pequena = cv2.resize(bgr, destino, interpolation=cv2.INTER_AREA)
        alfa_pequeno = cv2.resize(alfa, destino, interpolation=cv2.INTER_AREA)
    else:
        pequena, alfa_pequeno = bgr, alfa

    medida = sombra_real.medir(pequena, alfa_pequeno)
    if escala < 1.0:
        medida.densidade = cv2.resize(medida.densidade, (largura, altura), interpolation=cv2.INTER_LINEAR)
    return medida


def _mascara_com_recuperacao(bgr, checar_cancelamento):
    """Infere, diagnostica e, se houver sinal de máscara ruim, tenta o modelo alternativo (§9).

    Nenhum dos dois é declarado correto por passar nas verificações: elas só detectam sinal RUIM.
    Quando os dois acusam problema, entrega o de menos sinais e o trabalho sai com aviso — a
    aplicação continua automática e nunca pede máscara pintada à mão.
    """
    mascara, avisos_do_segmentador = _segmentar(bgr)
    alfa = refino.refinar(bgr, mascara.alfa)
    diagnostico = refino.diagnosticar(alfa)
    ok, avisos = refino.confiavel(diagnostico)
    avisos = avisos_do_segmentador + avisos
    if ok or not modelo.pronto(modelo.RECUPERACAO):
        return mascara, alfa, diagnostico, avisos, False

    checar_cancelamento()
    outra = modelo.inferir(bgr, modelo.RECUPERACAO)
    alfa_outra = refino.refinar(bgr, outra.alfa)
    diag_outra = refino.diagnosticar(alfa_outra)
    _, avisos_outra = refino.confiavel(diag_outra)
    avisos_outra = avisos_do_segmentador + avisos_outra
    if len(avisos_outra) < len(avisos):
        return outra, alfa_outra, diag_outra, avisos_outra, True
    return mascara, alfa, diagnostico, avisos, False


def _segmentar(bgr) -> tuple[modelo.Mascara, list[str]]:
    """A máscara, pelo segmentador configurado. O Gemini é opt-in e cai no local quando falha."""
    if config.SEGMENTADOR != "gemini":
        return modelo.inferir(bgr), []
    try:
        return gemini.inferir(bgr), []
    except gemini.FalhaNoGemini:
        # Falha de rede ou resposta inútil não derruba a foto: o modelo local continua aqui.
        return modelo.inferir(bgr), ["gemini_falhou_usei_o_modelo_local"]


def metadados_do_motor() -> dict[str, Any]:
    import cv2

    return {
        "motor": config.MOTOR,
        "segmentador": config.SEGMENTADOR,
        "gemini_configurado": gemini.configurado(),
        "modelo": modelo.NOME,
        "modelo_de_recuperacao": modelo.RECUPERACAO,
        "modelo_pronto": modelo.pronto(),
        "modelo_carregado": modelo.carregado(),
        "licenca_dos_pesos": "MIT (ZhengPeng7/BiRefNet)",
        "opencv": cv2.__version__,
        "segmentacao_aplicada": True,
    }
