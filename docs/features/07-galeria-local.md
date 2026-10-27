# 07 · Galeria local

## O que faz
Guarda as fotos tratadas **no próprio navegador**, em IndexedDB. Nada sobe para servidor nenhum;
aparecem em "Minhas fotos" e abrem num antes/depois arrastável.

## Onde mora
- `web/galeria-local.ts` — `salvarFoto`, `listarFotos`, `removerFoto` (tipo `FotoLocal`).
- `web/StudioPage.tsx` — `CartaoLocal` (card com hover antes→depois) e `ModalFoto` (antes/depois +
  reexportar).

## Como funciona
Cada item guarda os blobs `antes` e `depois`, o tamanho, o tempo de montagem, o fundo e o formato.
A lista é relida depois de cada processamento e de cada remoção.

## Regra que não pode quebrar
É conveniência, não fonte de verdade: se o IndexedDB falhar (aba anônima, storage bloqueado), o
processamento segue sem histórico (`salvarFoto(...).catch(...)`). Os blobs ficam só neste navegador —
não atravessam dispositivos nem chegam a ninguém.
