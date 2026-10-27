# 03 · Recorte com sombra

## O que faz
Exporta um **PNG transparente com o objeto recortado E a sombra junto**: o produto opaco, a sombra
real como preto semi-transparente, e o fundo limpo totalmente transparente. O produto cai em
qualquer página levando a sombra que ele realmente lançou.

## Onde mora
`src/backdrop.ts`, ramo `if (transparente)` dentro de `smoothBackdrop`. Ligado pelo modo de fundo
**Transparente** ([04 · Modos de fundo](04-modos-de-fundo.md)).

## Como funciona
Mesmo matte ([01](01-matte-do-produto.md)) e mesma sombra ([02](02-sombra-analitica.md)), compostos
sobre o vazio em vez de sobre branco:

- `s = 1 - fator` — a força da sombra, 0 no fundo limpo.
- `cobre = (1 - t) + t · s` — quanto aquele pixel tapa o xadrez: cheio no produto, parcial na
  sombra, zero no fundo limpo.
- A cor é dividida pela cobertura, para a borda macia do produto manter a cor em vez de escurecer
  num halo.
- O alfa do PNG é `255 · cobre`.

## Regra que não pode quebrar
A sombra nunca cai por cima do próprio produto (`sombra[forte] = 0`). Transparente **exporta sempre
em PNG** — JPG não tem canal alfa.
