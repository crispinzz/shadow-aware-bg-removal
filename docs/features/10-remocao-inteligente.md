# 10 · Remoção inteligente (lápis mágico)

## O que faz
Deixa você **tirar na mão o que saiu errado** — uma sombra que o automático não devia ter mantido,
lixo do fundo, um reflexo. Você pinta por cima, e a **região conectada** dali some. Fundo
texturizado ou colorido, onde o analítico não separa a sombra sozinho, é o caso de usar isto.

## Onde mora
- UI: `web/StudioPage.tsx` — botão **Remoção** (ícone borracha); reusa o componente `Pincel` com
  cor vermelha e outro rótulo. O traço vira `marcas.current.apagar`.
- Lógica: `src/backdrop.ts` — flood a partir do traço (`opts.apagar`), constante `MAGICO_PASSO`.

## Como funciona
1. **Semente** — só o traço que caiu **fora do produto**. Pincelada em cima da peça é descartada.
2. **Flood por continuidade de luz** — a partir da semente, anda para o vizinho enquanto a luz muda
   pouco (`MAGICO_PASSO`). A sombra é um campo suave, então uma passada pega ela inteira; o flood
   para no degrau do produto e no contraste com o fundo claro.
3. **Produto é parede** — o flood nunca entra na máscara do produto. Mesmo um traço que escorrega por
   cima da peça não a come: foca no que importa.
4. **Fundo limpo** — a região removida vira fundo e tem o fator da sombra forçado a `1`: some sem
   deixar meia-sombra. No modo transparente, fica totalmente transparente.

## O que NÃO faz
Não adivinha o que você quer tirar. É manual, seedado pelo traço — por isso é previsível e não erra
removendo o produto.

## Calibração
`MAGICO_PASSO` (0..255): maior = o flood anda mais longe e pega mais de uma vez; menor = mais preso
ao que você pintou. Ver também o [05 · Pincel da sombra](05-pincel-da-sombra.md), que é o mesmo
componente no sentido oposto (trazer sombra em vez de tirar).
