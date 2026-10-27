# Features do SHARP

Um documento por feature. Cada um diz **o que faz**, **onde mora no código** e **a regra que não pode quebrar**.

| # | Feature | Arquivo | Resumo |
|---|---------|---------|--------|
| 01 | Matte do produto | [01-matte-do-produto.md](01-matte-do-produto.md) | Onde está o produto, pela rede BiRefNet no backend local |
| 02 | Sombra analítica | [02-sombra-analitica.md](02-sombra-analitica.md) | A sombra real tirada da própria foto, sem modelo |
| 03 | Recorte com sombra | [03-recorte-com-sombra.md](03-recorte-com-sombra.md) | PNG transparente = objeto + sombra real semi-transparente |
| 04 | Modos de fundo | [04-modos-de-fundo.md](04-modos-de-fundo.md) | Branco, cor sólida ou transparente, e o formato de saída |
| 05 | Pincel da sombra | [05-pincel-da-sombra.md](05-pincel-da-sombra.md) | Insistir numa sombra fraca demais para o corte automático |
| 06 | Rede de sombra (SHARP) | [06-rede-de-sombra.md](06-rede-de-sombra.md) | O que é, e por que NÃO roda no estúdio |
| 07 | Galeria local | [07-galeria-local.md](07-galeria-local.md) | As fotos tratadas ficam no navegador (IndexedDB) |
| 08 | Painel de status | [08-painel-de-status.md](08-painel-de-status.md) | Quais modelos estão instalados e rodando |
| 09 | Câmera do celular | [09-camera-do-celular.md](09-camera-do-celular.md) | Mandar foto do celular por QR (recurso futuro) |

## A regra que atravessa tudo

O produto sai **byte a byte igual ao da fotografia**. Nenhuma etapa gera, redesenha ou retoca
material: só o fundo muda. A iluminação é trabalho da softbox, não do software.
