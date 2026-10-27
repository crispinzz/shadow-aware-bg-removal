# 01 · Matte do produto

## O que faz
Decide **onde está o produto** no quadro — devolve um alfa 0..1, não uma caixa. Esse alfa é a única
coisa que a rede produz; os pixels RGB do produto continuam vindo da fotografia original.

## Onde mora
- `server/app/vision/modelo.py` — BiRefNet em ONNX Runtime na CPU, entrada 1024×1024.
- `server/app/vision/refino.py` — devolve a borda fina que os 1024 px perderam (filtro guiado).
- `server/app/vision/pipeline.py` — `_mascara_com_recuperacao`: se o diagnóstico acusa máscara ruim,
  tenta o modelo grande (`birefnet-general`) e fica com o de menos sinais de erro (§9).
- `server/baixar_modelo.py` — baixa os pesos uma vez, na instalação, nunca no processamento.

## Como funciona
1. Reduz a foto para 1024², normaliza (média/desvio de ImageNet) e roda a rede.
2. Produto pequeno no quadro (< 33%) → segunda passada no recorte, para não gastar os 1024 px em
   tecido (`modelo.py`, `OCUPACAO_PARA_SEGUNDA`).
3. O refino em alta resolução recupera a borda; fora da faixa de dúvida ele não desfaz o que a rede
   já decidiu.

## Regra que não pode quebrar
A rede diz **ONDE**, nunca **O QUÊ**: nenhum pixel dela chega à imagem final. Licença dos pesos: MIT
(ZhengPeng7/BiRefNet).
