# 09 · Câmera do celular

## O que faz
Recurso **futuro, discreto**: mostrar um QR code para mandar a foto do celular para o estúdio, sem
cabo. Só aparece quando um servidor de câmera responde.

## Onde mora
`web/StudioPage.tsx` — busca `GET /galeria/rede`; se vier uma URL, gera o QR (`qrcode`) e acende o
ícone de rádio no trilho lateral.

## Como funciona
A página pergunta pela URL da galeria de rede na carga. Sem resposta, segue sem o QR e o indicador
fica apagado ("Servidor da câmera fora do ar"). Com resposta, o QR aponta o celular para a página de
envio.

## Estado atual
O endpoint `/galeria/rede` ainda não faz parte do backend local (`server/app/`); a UI já está pronta
para quando ele existir. Por enquanto o botão da câmera fica desabilitado.
