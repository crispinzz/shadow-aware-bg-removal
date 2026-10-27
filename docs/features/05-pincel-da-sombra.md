# 05 · Pincel da sombra

## O que faz
Deixa você **pintar por cima de uma sombra fraca demais** para o corte automático pegar. No que você
pintar, a sombra volta sem o corte de ruga.

## Onde mora
- UI: `web/StudioPage.tsx` — componente `Pincel` (canvas por cima da foto, controle de grossura).
- Uso: `src/backdrop.ts` — `opts.sombra` entra como peso 0..1 por pixel.

## Como funciona
1. O traço vira um mapa de alfa; a borda da ponta é borrada (`PENA_PINCEL`) porque sombra não tem
   contorno de caneta.
2. Traço pequeno demais (< 0,2% do quadro) é ignorado: foi toque sem querer.
3. Onde você pintou, o fator usa a densidade medida **sem** o corte de ruga — a sombra fraca passa.
4. Depois de aplicar, a foto é reprocessada com o traço no `marcas.current.sombra`.

## Regra que não pode quebrar
O pincel só **insiste** numa sombra que a foto tem; ele não inventa densidade onde o fundo está
limpo (o fator pintado nunca fica mais escuro que o medido ali).
