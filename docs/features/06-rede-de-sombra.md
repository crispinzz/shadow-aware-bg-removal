# 06 · Rede de sombra (SHARP)

## O que é
Uma U-Net pequena (1,9M de parâmetros) que prevê, por pixel, **quanto o objeto escureceu o fundo** —
um fator contínuo em [0.3, 1], não uma máscara binária. A ideia: aprender os casos que o analítico
([02](02-sombra-analitica.md)) não dá conta — fundo texturizado/colorido, sombra que sobe a parede,
duas luzes, objeto translúcido.

## Onde mora
- Treino: `training/train_shadow.py` (ISTD) e `training/make_synthetic.py` (pares sintéticos).
- Export: `training/export_onnx.py` → `server/modelos/shadow-matte.onnx`.
- Inferência: `server/app/vision/sombra_rede.py` (ONNX Runtime na CPU, 256 px).

## Por que NÃO roda no estúdio
Os dados de treino **nunca têm o objeto no quadro** — só fundo + sombra
(`make_synthetic.py`: *"the network never sees the object's pixels"*; o ISTD é cena natural, outro
domínio). A única coisa escura que a rede aprendeu é *sombra*. Numa foto de produto no branco ela lê
o **objeto** como sombra e devolve um borrão grande e mole (o prior que aprendeu: esticar e borrar a
silhueta).

Num fundo liso de estúdio a sombra real **já está nos pixels**, e o analítico a extrai certa. Então
o estúdio usa o analítico e a rede fica fora do caminho do frontend (`web/StudioPage.tsx` não pede
mais o mapa de fator).

## Quando ela valeria
Fundo texturizado ou colorido, onde "dividir pela luz do fundo" também divide a textura. Para isso a
rede precisa primeiro ser **retreinada com o objeto no quadro** (compor uma silhueta opaca sobre o
fundo sintético, ou usar fotos reais de produto). Enquanto isso não acontece, ela é peça de treino,
não de produção.

## Estado atual
Os pesos ainda podem ser baixados e o backend ainda sabe rodá-los, mas o resultado do estúdio não
depende deles. O painel de status mostra a sombra como **analítica**.
