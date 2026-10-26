"""Baixa os pesos do segmentador, uma vez, com verificacao de integridade.

Rode na instalacao: `python baixar_modelo.py`. O processamento nunca baixa nada (PRD aditivo §13).
"""
from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

PASTA = Path(__file__).parent / "modelos"

# Fonte, versao e checksum ficam registrados aqui junto da licenca (PRD aditivo §3).
MODELOS = {
    "birefnet-general": {
        "url": "https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-epoch_244.onnx",
        "md5": "7a35a0141cbbc80de11d9c9a28f52697",
        "licenca": "MIT — codigo e pesos de ZhengPeng7/BiRefNet (Copyright (c) 2024 ZhengPeng); ONNX convertido redistribuido pelo rembg, tambem MIT.",
        "origem_pesos": "https://huggingface.co/ZhengPeng7/BiRefNet",
    },
    "birefnet-general-lite": {
        "url": "https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
        "md5": "4fab47adc4ff364be1713e97b7e66334",
        "licenca": "MIT — mesma origem do birefnet-general, espinha dorsal Swin-tiny.",
        "origem_pesos": "https://huggingface.co/ZhengPeng7/BiRefNet",
    },
    # Nossa rede de sombra (U-Net 1,9M, treinada no ISTD). Pesos proprios, nao MIT.
    "shadow-matte": {
        "url": "https://github.com/crispinzz/shadow-aware-bg-removal/releases/download/weights-v1/shadow-matte.onnx",
        "md5": "037e60e5d28840c02224d26b7d2351a5",
        "licenca": "Proprietaria — todos os direitos reservados (ver LICENSE).",
        "origem_pesos": "training/train_shadow.py neste repositorio.",
    },
}


def baixar(nome: str = "birefnet-general") -> Path:
    info = MODELOS[nome]
    PASTA.mkdir(exist_ok=True)
    destino = PASTA / f"{nome}.onnx"
    if destino.exists() and _md5(destino) == info["md5"]:
        print(f"{nome}: ja esta aqui e o md5 confere.")
        return destino

    print(f"{nome}: baixando de {info['url']}")
    temporario = destino.with_suffix(".parcial")
    with urllib.request.urlopen(info["url"]) as resposta, open(temporario, "wb") as saida:
        total = int(resposta.headers.get("content-length") or 0)
        lido = 0
        while bloco := resposta.read(1 << 20):
            saida.write(bloco)
            lido += len(bloco)
            if total:
                print(f"\r  {lido / 1e6:.0f} / {total / 1e6:.0f} MB", end="", flush=True)
    print()

    obtido = _md5(temporario)
    if obtido != info["md5"]:
        temporario.unlink()
        raise SystemExit(f"md5 nao confere: esperava {info['md5']}, veio {obtido}. Nada foi instalado.")
    temporario.replace(destino)
    print(f"{nome}: ok. Licenca: {info['licenca']}")
    return destino


def _md5(caminho: Path) -> str:
    h = hashlib.md5()
    with open(caminho, "rb") as f:
        while bloco := f.read(1 << 20):
            h.update(bloco)
    return h.hexdigest()


if __name__ == "__main__":
    baixar(sys.argv[1] if len(sys.argv) > 1 else "birefnet-general")
