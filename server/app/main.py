"""Shadow Studio — backend local de tratamento de foto de produto.

Escuta só em 127.0.0.1: as fotos não saem da máquina e o serviço não fica exposto na rede.
Sobe com `studio.bat`, ou direto:
    studio/.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.rotas import rotas
from .core import config
from .core.trabalhos import fila


@asynccontextmanager
async def ciclo(_: FastAPI):
    fila.limpar_expirados()
    yield
    fila.encerrar()


app = FastAPI(title="Shadow Studio", version="0.1.0", lifespan=ciclo)

# Só o servidor de desenvolvimento do site, que é quem hospeda a aba do realçador.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.include_router(rotas)


def main() -> None:
    import uvicorn

    uvicorn.run(app, host=config.HOST, port=config.PORTA, log_level="info")


if __name__ == "__main__":
    main()
