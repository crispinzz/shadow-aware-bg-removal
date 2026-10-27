# 04 · Modos de fundo

## O que faz
Escolhe o fundo da saída e o formato do arquivo.

| Fundo | O que sai | Formato |
|-------|-----------|---------|
| Branco | Catálogo clássico: fundo branco limpo, sombra em Multiply | JPG (padrão), PNG, WEBP |
| Cor | Fundo numa cor RGB escolhida, sombra em Multiply sobre ela | JPG, PNG, WEBP |
| Transparente | Objeto + sombra sobre o vazio ([03](03-recorte-com-sombra.md)) | PNG sempre |

## Onde mora
- UI: `web/StudioPage.tsx` — componente `Opcoes` (botões de fundo, seletor de cor, formato).
- Composição: `src/backdrop.ts` — `opts.fundo` (`"transparente"` ou `{r,g,b}`) e `opts.formato`.

## Como funciona
Fundo branco/cor: `C_saida = produto · original + (1 - produto) · (cor · fator)`. O fator é a sombra
([02](02-sombra-analitica.md)); fator 1 é a cor pura, abaixo de 1 é sombra. Transparente segue o
caminho do [03](03-recorte-com-sombra.md).

## Regra que não pode quebrar
Com o produto opaco, o pixel de saída é o **original byte a byte**. Transparente trava o formato em
PNG na própria UI (`Opcoes`, botões de formato desabilitados).
