"""Fila de trabalhos: estado, concorrência limitada e arquivos temporários.

Nada aqui conhece visão computacional. O pipeline entra como uma função, o que deixa as fases
seguintes trocarem o algoritmo sem tocar na fila, e deixa a fila ser testada sem OpenCV.
"""
from __future__ import annotations

import secrets
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable

from . import config


class Estado(str, Enum):
    AGUARDANDO = "aguardando"
    PREPARANDO = "preparando"
    PROCESSANDO = "processando"
    CONCLUIDO = "concluido"
    CONCLUIDO_COM_AVISO = "concluido_com_aviso"
    FALHOU = "falhou"
    CANCELADO = "cancelado"


FINAIS = {Estado.CONCLUIDO, Estado.CONCLUIDO_COM_AVISO, Estado.FALHOU, Estado.CANCELADO}


@dataclass
class Saida:
    """Um arquivo pronto. O id é o que o cliente usa; o caminho nunca sai daqui."""
    id: str
    caminho: Path
    tipo: str
    nome: str


@dataclass
class Trabalho:
    id: str
    nome_original: str
    estado: Estado = Estado.AGUARDANDO
    criado_em: float = field(default_factory=time.time)
    atualizado_em: float = field(default_factory=time.time)
    erro: str | None = None
    avisos: list[str] = field(default_factory=list)
    metricas: dict[str, Any] = field(default_factory=dict)
    saidas: dict[str, Saida] = field(default_factory=dict)
    cancelado: threading.Event = field(default_factory=threading.Event)
    pasta: Path | None = None

    def publico(self) -> dict[str, Any]:
        """O que vai para o cliente. Sem caminho de disco: o cliente só conhece ids."""
        return {
            "id": self.id,
            "nome": self.nome_original,
            "estado": self.estado.value,
            "criado_em": self.criado_em,
            "atualizado_em": self.atualizado_em,
            "erro": self.erro,
            "avisos": self.avisos,
            "metricas": self.metricas,
            "arquivos": {fmt: {"id": s.id, "nome": s.nome} for fmt, s in self.saidas.items()},
        }


class Cancelado(Exception):
    """O trabalho foi cancelado; o pipeline levanta isto para parar sem virar falha."""


class Fila:
    def __init__(self, trabalhadores: int = config.TRABALHADORES) -> None:
        self._trabalhos: dict[str, Trabalho] = {}
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=max(1, trabalhadores), thread_name_prefix="studio")
        self.raiz = Path(config.TEMP_RAIZ)
        self.raiz.mkdir(parents=True, exist_ok=True)

    # --- consulta

    def obter(self, trabalho_id: str) -> Trabalho | None:
        with self._lock:
            return self._trabalhos.get(trabalho_id)

    def saida(self, arquivo_id: str) -> Saida | None:
        """Procura um arquivo por id em todos os trabalhos. O id é imprevisível, então ele é a
        autorização — nenhum caminho vindo do cliente é usado para abrir arquivo."""
        with self._lock:
            for trabalho in self._trabalhos.values():
                for s in trabalho.saidas.values():
                    if s.id == arquivo_id:
                        return s
        return None

    def listar(self) -> list[Trabalho]:
        with self._lock:
            return sorted(self._trabalhos.values(), key=lambda t: t.criado_em)

    # --- ciclo de vida

    def criar(self, nome_original: str) -> Trabalho:
        self.limpar_expirados()
        trabalho_id = secrets.token_hex(16)
        pasta = self.raiz / trabalho_id
        pasta.mkdir(parents=True, exist_ok=True)
        trabalho = Trabalho(id=trabalho_id, nome_original=nome_original, pasta=pasta)
        with self._lock:
            self._trabalhos[trabalho_id] = trabalho
        return trabalho

    def _marcar(self, trabalho: Trabalho, estado: Estado) -> None:
        trabalho.estado = estado
        trabalho.atualizado_em = time.time()

    def enviar(self, trabalho: Trabalho, pipeline: Callable[[Trabalho], None]) -> None:
        """Põe o trabalho na fila. `pipeline` roda numa thread e preenche saídas e métricas."""
        def executar() -> None:
            if trabalho.cancelado.is_set():
                self._marcar(trabalho, Estado.CANCELADO)
                return
            self._marcar(trabalho, Estado.PROCESSANDO)
            try:
                pipeline(trabalho)
            except Cancelado:
                self._marcar(trabalho, Estado.CANCELADO)
                return
            except Exception as erro:  # noqa: BLE001 - a falha de uma foto não derruba a fila
                trabalho.erro = str(erro) or erro.__class__.__name__
                self._marcar(trabalho, Estado.FALHOU)
                return
            if trabalho.estado not in FINAIS:
                self._marcar(trabalho, Estado.CONCLUIDO_COM_AVISO if trabalho.avisos else Estado.CONCLUIDO)

        self._marcar(trabalho, Estado.PREPARANDO)
        self._executor.submit(executar)

    def cancelar(self, trabalho_id: str) -> bool:
        trabalho = self.obter(trabalho_id)
        if trabalho is None or trabalho.estado in FINAIS:
            return False
        trabalho.cancelado.set()
        if trabalho.estado in (Estado.AGUARDANDO, Estado.PREPARANDO):
            self._marcar(trabalho, Estado.CANCELADO)
        return True

    def registrar_saida(self, trabalho: Trabalho, formato: str, caminho: Path, tipo: str, nome: str) -> Saida:
        saida = Saida(id=secrets.token_hex(16), caminho=caminho, tipo=tipo, nome=nome)
        trabalho.saidas[formato] = saida
        return saida

    # --- temporários

    def limpar_expirados(self) -> int:
        """Remove trabalhos e pastas passados da retenção. A foto do cliente não fica guardada."""
        limite = time.time() - config.RETENCAO_SEGUNDOS
        removidos = 0
        with self._lock:
            vencidos = [t for t in self._trabalhos.values() if t.atualizado_em < limite and t.estado in FINAIS]
            for trabalho in vencidos:
                self._trabalhos.pop(trabalho.id, None)
        for trabalho in vencidos:
            if trabalho.pasta:
                shutil.rmtree(trabalho.pasta, ignore_errors=True)
            removidos += 1
        return removidos

    def encerrar(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)


fila = Fila()
