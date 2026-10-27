# 08 · Painel de status

## O que faz
Mostra se o backend está de pé e **o que ele vai processar**: o modelo do produto (BiRefNet) e o
motor da sombra.

## Onde mora
- Backend: `server/app/api/rotas.py` — rota `GET /api/health`.
- UI: `web/StudioPage.tsx` — componente `Status` (pino "Modelos", pergunta a cada 5 s).

## O que cada linha diz
- **Backend** — rodando / fora do ar.
- **Produto · BiRefNet** — nome do modelo e se está `instalado` / `rodando` / `não instalado`.
- **Sombra · analítica** — sempre **ativa**: a sombra sai da própria foto ([02](02-sombra-analitica.md)),
  não de um modelo. A rede SHARP não entra aqui ([06](06-rede-de-sombra.md)).

## Regra que não pode quebrar
`sombra_rede_ativa` é sempre `false`, mesmo com o peso instalado — o estúdio não compõe com a rede.
