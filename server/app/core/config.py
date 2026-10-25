"""Configuração do Shadow Studio, toda por variável de ambiente, com padrão seguro.

O serviço escuta só em 127.0.0.1 de propósito: é ferramenta local, e as fotos não saem da máquina.
"""
from __future__ import annotations

import os
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]


def _inteiro(nome: str, padrao: int) -> int:
    try:
        return int(os.environ.get(nome, padrao))
    except ValueError:
        return padrao


HOST = os.environ.get("STUDIO_HOST", "127.0.0.1")
PORTA = _inteiro("STUDIO_PORTA", 8000)

# "hibrido" usa o motor clássico e só recorre ao modelo quando o avaliador acusa baixa confiança.
# "classico" proíbe qualquer recurso a modelo, que é o comportamento estrito do PRD.
MOTOR = os.environ.get("STUDIO_MOTOR", "hibrido").strip().lower()

# Limites de entrada. Existem para o serviço não cair de memória com uma foto absurda, e para um
# arquivo mentindo na extensão não virar carga de trabalho.
MAX_BYTES = _inteiro("STUDIO_MAX_BYTES", 80 * 1024 * 1024)
MAX_PIXELS = _inteiro("STUDIO_MAX_PIXELS", 60_000_000)
MIN_LADO = _inteiro("STUDIO_MIN_LADO", 32)

# Fila. Processar tudo ao mesmo tempo numa máquina comum só faz todas as fotos ficarem lentas.
TRABALHADORES = _inteiro("STUDIO_TRABALHADORES", 2)

# Temporários: pasta própria desta execução, limpa por idade.
TEMP_RAIZ = Path(os.environ.get("STUDIO_TEMP", RAIZ / ".temp"))
RETENCAO_SEGUNDOS = _inteiro("STUDIO_RETENCAO", 2 * 60 * 60)

# Lado maior usado na análise. A segmentação varia devagar, então medir em resolução cheia custa
# caro sem melhorar a decisão; a máscara escolhida é projetada de volta para o tamanho original.
LADO_ANALISE = _inteiro("STUDIO_LADO_ANALISE", 1200)

QUALIDADE_JPEG = _inteiro("STUDIO_QUALIDADE_JPEG", 94)


def motor_permite_modelo() -> bool:
    """False no modo estrito do PRD, onde nenhum peso de modelo pode ser carregado."""
    return MOTOR != "classico"

# Segmentador: "local" (BiRefNet nesta máquina) ou "gemini" (a máscara vem da API do Google).
#
# AVISO: "gemini" ENVIA a foto para um servidor do Google, o que contraria o padrão desta ferramenta
# — todo o resto roda offline. Por isso é opt-in e precisa de chave explícita. Quando a API falha, o
# pipeline cai sozinho no modelo local em vez de derrubar o trabalho.
SEGMENTADOR = os.environ.get("STUDIO_SEGMENTADOR", "local").strip().lower()
GEMINI_CHAVE = os.environ.get("STUDIO_GEMINI_CHAVE", "").strip()
GEMINI_MODELO = os.environ.get("STUDIO_GEMINI_MODELO", "gemini-2.5-flash").strip()

# Sombra real (medida da foto) em vez da projetada. Desligada por padrão: medido no set de duas
# luzes do estúdio, a sombra real sai fraca, dupla e misturada com a ruga do tecido.
SOMBRA_REAL = os.environ.get("STUDIO_SOMBRA_REAL", "").lower() in ("1", "true", "sim")
