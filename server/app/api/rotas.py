"""Endpoints do Shadow Studio.

Regra que vale em todas: o cliente só conhece ids opacos. Nenhum caminho de disco sai daqui, e
nenhum caminho vindo do cliente é usado para abrir arquivo — é o que fecha travessia de diretório.
"""
from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from ..core import config
from ..core.trabalhos import Estado, fila
from ..vision import entrada, pipeline

rotas = APIRouter(prefix="/api")


@rotas.get("/health")
def health() -> dict:
    """Diz se o backend está de pé e com o que ele vai processar. A interface mostra isso."""
    return {
        "ok": True,
        **pipeline.metadados_do_motor(),
        "limites": {
            "max_bytes": config.MAX_BYTES,
            "max_pixels": config.MAX_PIXELS,
            "min_lado": config.MIN_LADO,
        },
        "trabalhadores": config.TRABALHADORES,
    }


@rotas.post("/process", status_code=202)
async def processar(arquivo: UploadFile = File(...)) -> dict:
    dados = await arquivo.read()
    if len(dados) > config.MAX_BYTES:
        raise HTTPException(413, "Arquivo grande demais.")

    # Valida antes de criar o trabalho: erro de entrada é resposta direta, não trabalho que falha.
    try:
        entrada.decodificar(dados)
    except entrada.EntradaInvalida as erro:
        raise HTTPException(422, str(erro)) from erro

    trabalho = fila.criar(nome_original=arquivo.filename or "foto")
    fila.enviar(trabalho, lambda t: pipeline.processar(t, dados))
    return trabalho.publico()


@rotas.get("/jobs/{trabalho_id}")
def obter_trabalho(trabalho_id: str) -> dict:
    trabalho = fila.obter(trabalho_id)
    if trabalho is None:
        raise HTTPException(404, "Trabalho não encontrado.")
    return trabalho.publico()


@rotas.get("/jobs")
def listar_trabalhos() -> dict:
    return {"trabalhos": [t.publico() for t in fila.listar()]}


@rotas.post("/cancel/{trabalho_id}")
def cancelar(trabalho_id: str) -> dict:
    if fila.obter(trabalho_id) is None:
        raise HTTPException(404, "Trabalho não encontrado.")
    return {"cancelado": fila.cancelar(trabalho_id)}


@rotas.get("/files/{arquivo_id}")
def baixar(arquivo_id: str) -> FileResponse:
    saida = fila.saida(arquivo_id)
    if saida is None or not saida.caminho.exists():
        raise HTTPException(404, "Arquivo não encontrado.")
    return FileResponse(saida.caminho, media_type=saida.tipo, filename=saida.nome)
