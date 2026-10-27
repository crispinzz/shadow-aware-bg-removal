# 02 · Sombra analítica

## O que faz
Traz a sombra de volta no fundo novo — **a sombra real, tirada da própria foto**, com a forma e a
suavidade que ela tem. Nenhum modelo, nenhuma elipse desenhada.

## Onde mora
`src/backdrop.ts`, dentro de `smoothBackdrop` (roda no navegador, sem dependência).

## Como funciona
É o inverso de um Multiply, o mesmo que o Photoshop faz:

1. **Luz do fundo** — para cada pixel, estima a luz que o fundo teria ali *sem sombra*: uma média
   local larga tomada **só sobre os pixels de fundo iluminados**, para a própria sombra não puxar a
   referência para baixo (`base`, raio `RAIO_LUZ`).
2. **Densidade medida** — `fator = luz / base`. Fundo liso dá 1 (vira cor pura); sombra dá menos de
   1 e volta com o degradê exato da foto.
3. **Corte de ruga** — dobra de tecido fica dentro de `RUGA` (18%) e é arredondada para fundo limpo;
   a sombra passa disso e sobrevive inteira.
4. O fator é chaveado pela **escuridão medida**, sem corte por distância — por isso a sombra comprida
   do produto não é truncada numa caixa.

## Constantes de calibração
- `SOMBRA_MIN` — piso do fator (quão escura a sombra pode ficar antes de virar buraco).
- `RUGA` — até quanto mais escuro que o fundo liso ainda é ruga, não sombra.
- `RAIO_LUZ`, `SUAVE_SOMBRA` — raio da leitura da luz e do alisamento final do grão.

## Regra que não pode quebrar
A referência de luz sai **só do fundo claro**. Se a sombra entrar no divisor, ela se anula. Ver
também [03 · Recorte com sombra](03-recorte-com-sombra.md) e, para o porquê de não usarmos a rede
aqui, [06 · Rede de sombra](06-rede-de-sombra.md).
