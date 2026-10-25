// Fotos do catálogo: o celular (mesma rede Wi-Fi) tira a foto e ela vai direto para o PC. Não fica na galeria do celular.
// Roteiro por produto (docs/catalogo-fotos.md): fotos de REFERÊNCIA para a IA de imagem refotografar em estúdio.
// R1 frente 3/4 e R2 trás 3/4 são obrigatórias (sem elas o prompt recusa); lateral, detalhes, etiqueta e trena ajudam.
// Assistente (rede neural no próprio celular, MediaPipe): acha o equipamento na imagem e orienta "afaste", "centralize",
// "segure firme", mantém a mesma distância da foto de frente e dispara sozinho quando está tudo certo.
// A câmera ao vivo exige endereço seguro: com o certificado em site/scripts/.cert o servidor sobe em https e
// o QR do Realçador já aponta para ele. Sem certificado, só por http://localhost:5180 com `adb reverse tcp:5180 tcp:5180`;
// pelo IP em http a página cai na câmera do próprio celular (sem assistente, zoom ou flash nossos).
// No celular a câmera ocupa a tela com os controles embaixo; no PC a mesma página é uma galeria (copiar, apagar o dia).
// Rodar: node site/scripts/foto-catalogo.mjs. Fotos em fotos-catalogo/<AAAA-MM-DD>/ na raiz do projeto.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 5180);
// HTTPS quando o certificado local existe. A camera ao vivo (e com ela zoom, exposicao e flash) so
// roda em endereco seguro: pelo IP da rede em http o navegador nega getUserMedia, e a pagina cai no
// app de camera do celular. Gerar uma vez, da raiz do projeto:
//   openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=Shadow Studio" \
//     -addext "subjectAltName=IP:<seu-ip>,IP:127.0.0.1,DNS:localhost" \
//     -keyout site/scripts/.cert/key.pem -out site/scripts/.cert/cert.pem
// E um certificado proprio: o celular avisa uma vez ("conexao nao e particular" -> Avancado ->
// Continuar). Sem os arquivos, o servidor sobe em http como antes.
const CERT = resolve(dirname(fileURLToPath(import.meta.url)), ".cert");
const TLS = existsSync(join(CERT, "cert.pem")) && existsSync(join(CERT, "key.pem"))
  ? { cert: readFileSync(join(CERT, "cert.pem")), key: readFileSync(join(CERT, "key.pem")) }
  : null;
const PROTO = TLS ? "https" : "http";
const createServer = (handler) => (TLS ? createHttpsServer(TLS, handler) : createHttpServer(handler));
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../photos");
// Prompt mestre da IA de imagem: lido a cada pedido, então sai sempre a versão atual do repositório.
const PROMPT = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/prompt.txt");
const today = () => new Date().toLocaleDateString("sv-SE");
const cleanDay = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value ?? "") ? value : today());
const cleanKind = (value) => String(value ?? "foto").toLowerCase().replace(/[^a-z0-9-]+/g, "").slice(0, 20) || "foto";
const isPhoto = (file) => /^\d{3}-[a-z0-9-]+\.(jpe?g|png|webp)$/i.test(file);

const listDay = async (day) => (await readdir(join(ROOT, day)).catch(() => [])).filter(isPhoto).sort();

async function readBody(request, limit = 40 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Foto grande demais.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const send = (response, status, body, type = "application/json; charset=utf-8") => {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://local");
  const day = cleanDay(url.searchParams.get("dia"));
  try {
    if (request.method === "GET" && url.pathname === "/") return send(response, 200, PAGE, "text/html; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/prompt") {
      return send(response, 200, await readFile(PROMPT, "utf8"), "text/plain; charset=utf-8");
    }
    // Copia o prompt para a área de transferência do Windows (funciona mesmo quando o navegador bloqueia).
    if (request.method === "POST" && url.pathname === "/copiar-prompt") {
      const script = `Get-Content -Raw -Encoding UTF8 -LiteralPath '${PROMPT.replace(/'/g, "''")}' | Set-Clipboard`;
      await new Promise((done, fail) => execFile("powershell.exe", ["-NoProfile", "-Command", script], (error) => (error ? fail(error) : done())));
      return send(response, 200, { ok: true });
    }
    // Endereço de rede, para o Realçador montar o QR que o celular escaneia.
    if (request.method === "GET" && url.pathname === "/rede") {
      const ips = Object.values(networkInterfaces()).flat()
        .filter((item) => item && item.family === "IPv4" && !item.internal)
        .map((item) => `${PROTO}://${item.address}:${PORT}`);
      return send(response, 200, { urls: ips });
    }
    if (request.method === "GET" && url.pathname === "/fotos") {
      const days = (await readdir(ROOT).catch(() => [])).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort().reverse();
      return send(response, 200, { day, days, photos: await listDay(day) });
    }
    if (request.method === "GET" && url.pathname === "/foto") {
      const file = url.searchParams.get("arquivo") ?? "";
      if (!isPhoto(file)) return send(response, 400, { error: "Arquivo inválido." });
      const type = file.endsWith(".png") ? "image/png" : file.endsWith(".webp") ? "image/webp" : "image/jpeg";
      return send(response, 200, await readFile(join(ROOT, day, file)), type);
    }
    if (request.method === "POST" && url.pathname === "/foto") {
      const body = await readBody(request);
      if (!body.length) return send(response, 400, { error: "Foto vazia." });
      const dir = join(ROOT, today());
      await mkdir(dir, { recursive: true });
      const photos = await listDay(today());
      const last = Number(photos.at(-1)?.slice(0, 3) ?? 0);
      const ext = (request.headers["content-type"] ?? "").includes("png") ? "png" : "jpg";
      const file = `${String(last + 1).padStart(3, "0")}-${cleanKind(url.searchParams.get("tipo"))}.${ext}`;
      await writeFile(join(dir, file), body);
      console.log(`  ✓ ${today()}/${file} (${Math.round(body.length / 1024)} KB)`);
      return send(response, 200, { file });
    }
    // Copiar todas as fotos do dia para a área de transferência do Windows (como arquivos: Ctrl+V no ChatGPT cola todas).
    if (request.method === "POST" && url.pathname === "/copiar") {
      const photos = (await listDay(day)).map((file) => join(ROOT, day, file).replace(/'/g, "''"));
      if (!photos.length) return send(response, 400, { error: "Nenhuma foto neste dia." });
      const script = `Set-Clipboard -Path ${photos.map((path) => `'${path}'`).join(",")}`;
      await new Promise((done, fail) => execFile("powershell.exe", ["-NoProfile", "-Command", script], (error) => (error ? fail(error) : done())));
      return send(response, 200, { copied: photos.length });
    }
    // Apagar uma foto.
    if (request.method === "DELETE" && url.pathname === "/foto") {
      const file = url.searchParams.get("arquivo") ?? "";
      if (!isPhoto(file)) return send(response, 400, { error: "Arquivo inválido." });
      await rm(join(ROOT, day, file));
      return send(response, 200, { deleted: file });
    }
    // Apagar todas as fotos de um dia (botão só existe na galeria do PC).
    if (request.method === "DELETE" && url.pathname === "/fotos") {
      const photos = await listDay(day);
      await Promise.all(photos.map((file) => rm(join(ROOT, day, file))));
      console.log(`  × ${photos.length} fotos apagadas de ${day}`);
      return send(response, 200, { deleted: photos.length });
    }
    send(response, 404, { error: "Não encontrado." });
  } catch (error) {
    send(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}).listen(PORT, "0.0.0.0", () => {
  const ips = Object.values(networkInterfaces()).flat().filter((item) => item && item.family === "IPv4" && !item.internal).map((item) => item.address);
  console.log(`Fotos do catálogo → pasta ${ROOT}`);
  for (const ip of ips) console.log(`  Celular na rede${TLS ? "" : " (sem camera ao vivo: falta o certificado)"}: ${PROTO}://${ip}:${PORT}`);
  console.log(`  Celular por cabo: adb reverse tcp:${PORT} tcp:${PORT} e abrir ${PROTO}://localhost:${PORT}`);
});

const PAGE = /* html */ `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#fbfbf8">
<title>Catalogue photos</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Inter+Tight:wght@500;600;700&display=swap">
<style>
  :root { --blue: #0000f7; --blue-hover: #0000b8; --ink: #17211d; --muted: #66706b; --canvas: #fbfbf8; --surface: #fefefc; --tile: #efefeb; --line: #e8e8e4; --ok: #157a4a; --warn: #a15c07; --bad: #b42318; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--canvas); color: var(--ink); font: 15px/1.45 Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
  button { font: inherit; cursor: pointer; }

  /* Celular: câmera ocupando a tela, controles embaixo. */
  /* A camera e a interface: ela ocupa a tela inteira e os controles flutuam por cima, em vez de
     dividir a altura com eles (antes o video sobrava num quarto da tela). */
  .phone { position: relative; height: 100dvh; overflow: hidden; background: #17211d; }
  .phone .view { position: absolute; inset: 0; }
  .phone .ptop, .phone .live { position: absolute; left: 0; right: 0; z-index: 2; }
  .phone .ptop { top: 0; background: linear-gradient(to bottom, rgba(23,33,29,.74), transparent); border: 0; color: #fefefc; }
  .phone .ptop small, .phone .ptop .hoje { color: #e7eae7; background: rgba(254,254,252,.16); }
  .phone .ptop small { background: none; }
  .phone .live { bottom: 0; background: linear-gradient(to top, rgba(23,33,29,.82) 62%, transparent); color: #fefefc; }
  .phone .live .now b, .phone .live .say { color: #fefefc; }
  .phone .live .say { background: rgba(254,254,252,.16); }
  .phone .live .hint, .phone .live .now small { color: #d6dad6; }
  .phone .live .chip, .phone .live .side { background: rgba(254,254,252,.16); border-color: rgba(254,254,252,.28); color: #fefefc; }
  .phone .live .chip.on { background: #fefefc; color: #17211d; border-color: #fefefc; }
  .phone .live .side.on { background: var(--blue); border-color: var(--blue); color: #fefefc; }
  .phone .live .dots li { background: rgba(254,254,252,.3); }
  .phone .live .checks li { background: rgba(254,254,252,.16); color: #e7eae7; }
  .ptop { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: calc(10px + env(safe-area-inset-top)) 16px 10px;
    background: var(--surface); border-bottom: 1px solid var(--line); }
  .ptop b { font-family: "Inter Tight", Inter, sans-serif; font-size: 15px; font-weight: 600; letter-spacing: -.01em; }
  .ptop small { display: block; color: var(--muted); font-size: 12px; }
  .ptop .hoje { margin-left: auto; padding: 5px 11px; border-radius: 999px; background: var(--tile);
    font-family: "Inter Tight", Inter, sans-serif; font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .dots { display: flex; gap: 5px; margin: 0; padding: 0; list-style: none; }
  .dots li { flex: 1; height: 4px; border-radius: 999px; background: var(--tile); }
  .dots li.feito { background: var(--blue); }
  .dots li.agora { background: var(--blue); box-shadow: 0 0 0 3px rgba(0,0,247,.14); }
  .view { position: relative; flex: 1 1 auto; min-height: 0; background: #17211d; overflow: hidden; }
  .view video, .view canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .view .off { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; text-align: center; color: #c9cec9; font-size: 13px; }
  .phone.nolive .view { display: none; }
  .phone.nolive .live { flex: 1; justify-content: flex-start; gap: 16px; padding: 22px 20px calc(22px + env(safe-area-inset-bottom)); }
  .phone.nolive .row { margin-top: auto; }
  .phone.nolive .now b { font-size: 32px; }
  .phone.nolive .hint { font-size: 17px; }
  .phone.nolive .shoot { min-height: 120px; font-size: 22px; }
  .live { flex: 0 0 auto; display: flex; flex-direction: column; gap: 7px; padding: 10px 14px calc(10px + env(safe-area-inset-bottom)); background: var(--surface); }
  .now { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .now b { font-family: "Inter Tight", Inter, sans-serif; font-size: 17px; font-weight: 600; letter-spacing: -.02em; }
  .now small { color: var(--muted); white-space: nowrap; }
  .hint { margin: -4px 0 0; color: var(--muted); font-size: 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .say { padding: 7px 11px; border-radius: 11px; background: var(--tile); font-family: "Inter Tight", Inter, sans-serif; font-size: 14px; font-weight: 600; }
  .say.ok { background: #e3f1e9; color: var(--ok); }
  .say.warn { background: #fbefdc; color: var(--warn); }
  .checks { display: flex; gap: 6px; flex-wrap: wrap; margin: 0; padding: 0; list-style: none; font-size: 12px; }
  .checks li { padding: 3px 9px; border-radius: 999px; background: var(--tile); color: var(--muted); }
  .checks li.ok { background: #e3f1e9; color: var(--ok); }
  /* Controles de camera profissional: grande-angular, zoom, exposicao, flash. */
  .cam { display: grid; gap: 7px; }
  .lens { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { padding: 5px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--canvas); color: var(--ink); font-size: 13px; font-weight: 600; }
  .chip.on { border-color: var(--blue); background: var(--blue); color: #fefefc; }
  .slider { display: grid; gap: 3px; font-size: 12px; color: var(--muted); }
  .slider input { width: 100%; accent-color: var(--blue); }
  .row { display: flex; align-items: stretch; gap: 8px; }
  .shoot { flex: 1; min-height: 54px; border: 0; border-radius: 18px; background: var(--blue); color: #fefefc; font-family: "Inter Tight", Inter, sans-serif; font-size: 18px; font-weight: 600; }
  .shoot:active { background: var(--blue-hover); }
  .side { min-width: 72px; padding: 0 12px; border-radius: 14px; border: 1px solid var(--line); background: var(--canvas); color: var(--ink); font-size: 14px; }
  .side.on { border-color: var(--blue); color: var(--blue); }
  .strip { display: flex; gap: 6px; overflow-x: auto; min-height: 40px; }
  .strip figure { position: relative; flex: 0 0 40px; height: 40px; margin: 0; border-radius: 10px; overflow: hidden; background: var(--tile); }
  .strip img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .strip figure.sending { opacity: .45; }
  .strip figure.error { outline: 2px solid var(--bad); }
  .status { min-height: 0; font-size: 12px; color: var(--muted); }
  .status.bad { color: var(--bad); }

  /* PC: galeria. */
  .desk { display: none; max-width: 1440px; margin: 0 auto; padding: 0 28px 48px; }
  .deskbar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap;
    margin: 0 -28px 24px; padding: 16px 28px; background: rgba(251,251,248,.88); backdrop-filter: blur(10px); border-bottom: 1px solid var(--line); }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand svg { flex: 0 0 auto; }
  .desk h1 { margin: 0; font-family: "Inter Tight", Inter, sans-serif; font-size: 19px; font-weight: 600; letter-spacing: -.02em; }
  .desk .sub { margin: 1px 0 0; color: var(--muted); font-size: 13px; }
  .tools { display: flex; gap: 8px; align-items: center; }
  .desk select, .add, .danger, .copy { height: 38px; border-radius: 10px; font: inherit; font-size: 14px; }
  .desk select { padding: 0 10px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); font-family: "Inter Tight", Inter, sans-serif; font-weight: 500; }
  .add { padding: 0 14px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); transition: border-color .15s, color .15s; }
  .add:hover { border-color: var(--ink); }
  .danger { padding: 0 14px; border: 1px solid var(--line); background: var(--surface); color: var(--muted); transition: border-color .15s, color .15s; }
  .danger:hover { border-color: #f1c9c4; color: var(--bad); }
  .danger:disabled, .copy:disabled, .add:disabled { opacity: .35; cursor: default; }
  .danger:disabled:hover { border-color: var(--line); color: var(--muted); }
  .copy { padding: 0 16px; border: 0; background: var(--blue); color: #fefefc; font-weight: 600; }
  .copy:hover:not(:disabled) { background: var(--blue-hover); }
  .sep { width: 1px; height: 22px; background: var(--line); }
  .count { font-family: "Inter Tight", Inter, sans-serif; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }

  .dropzone { position: fixed; inset: 0; z-index: 20; display: none; place-items: center; background: rgba(0,0,247,.06); pointer-events: none; }
  .dropzone.on { display: grid; }
  .dropzone span { padding: 18px 28px; border-radius: 16px; border: 2px dashed var(--blue); background: var(--surface);
    font-family: "Inter Tight", Inter, sans-serif; font-size: 17px; font-weight: 600; color: var(--blue); }

  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 14px; }
  .gallery figure { position: relative; margin: 0; border-radius: 14px; overflow: hidden; background: var(--surface); border: 1px solid var(--line);
    transition: border-color .15s, box-shadow .15s, transform .15s; }
  .gallery figure:hover { border-color: #d8d8d2; box-shadow: 0 6px 20px rgba(23,33,29,.07); transform: translateY(-2px); }
  .gallery button.shot { display: block; width: 100%; padding: 0; border: 0; background: var(--tile); aspect-ratio: 1; }
  .gallery img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .gallery figcaption { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 11px; font-size: 12px; color: var(--muted); }
  .gallery figcaption b { font-family: "Inter Tight", Inter, sans-serif; font-size: 13px; font-weight: 600; color: var(--ink); }
  .gallery figcaption span { font-variant-numeric: tabular-nums; }
  .gallery .del { position: absolute; top: 8px; right: 8px; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 999px;
    background: rgba(23,33,29,.62); color: #fefefc; font-size: 17px; line-height: 30px; opacity: 0; transition: opacity .15s, background .15s; }
  .gallery figure:hover .del { opacity: 1; }
  .gallery .del:hover { background: var(--bad); }

  .empty { grid-column: 1 / -1; display: grid; justify-items: center; gap: 10px; padding: 72px 20px; text-align: center; }
  .empty .tile { display: grid; place-items: center; width: 64px; height: 64px; border-radius: 18px; background: var(--tile); }
  .empty b { font-family: "Inter Tight", Inter, sans-serif; font-size: 16px; font-weight: 600; }
  .empty p { margin: 0; max-width: 340px; color: var(--muted); font-size: 14px; }

  .lightbox { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(23,33,29,.93); z-index: 10; }
  .lightbox.open { display: flex; }
  .lightbox img { max-width: 92vw; max-height: 84vh; object-fit: contain; border-radius: 6px; }
  .lightbox p { position: absolute; left: 0; right: 0; bottom: 18px; margin: 0; text-align: center; color: #fefefc;
    font-family: "Inter Tight", Inter, sans-serif; font-size: 14px; }
  .lightbox .nav { position: absolute; top: 50%; transform: translateY(-50%); width: 52px; height: 52px; border: 0; border-radius: 999px;
    background: rgba(254,254,252,.12); color: #fefefc; font-size: 26px; transition: background .15s; }
  .lightbox .nav:hover, .lightbox .close:hover { background: rgba(254,254,252,.26); }
  .lightbox .prev { left: 18px; } .lightbox .next { right: 18px; }
  .lightbox .close { position: absolute; top: 18px; right: 18px; width: 44px; height: 44px; border: 0; border-radius: 999px;
    background: rgba(254,254,252,.12); color: #fefefc; font-size: 22px; transition: background .15s; }

  @media (min-width: 900px) and (hover: hover) {
    .phone { display: none; }
    .desk { display: block; }
  }
</style>
</head>
<body>
<div class="phone">
  <header class="ptop"><svg width="26" height="26" viewBox="0 0 64 64" fill="none" aria-hidden="true"><circle cx="35.5" cy="9.5" r="5.5" fill="#0000f7"/><path d="M24.6 13.6A22 22 0 1 0 53 42.5" stroke="#0000f7" stroke-width="8.5" stroke-linecap="round"/><path d="M24 31.5C24 25 29 20 35.5 20S47 25 47 31.5V36h6v7.5c0 3-1.6 5.5-4.4 6.7V39.6H40.8c-2 2.6-4.3 3.9-7 3.9C28.3 43.5 24 38.2 24 31.5Z" fill="#0000f7"/></svg><div><b>Fotos do catálogo</b><small>Vão direto para o computador</small></div><span class="hoje" id="hoje">0</span></header>
  <div class="view">
    <video id="video" playsinline muted></video>
    <canvas id="overlay"></canvas>
    <div class="off" id="viewOff">Câmera ao vivo desligada.</div>
  </div>
  <div class="live">
    <ul class="dots" id="dots"></ul>
    <div class="now"><b id="step">Giro 0°</b><small id="count"></small></div>
    <p class="hint" id="hint"></p>
    <div class="say" id="say">Preparando…</div>
    <ul class="checks" id="checks"></ul>
    <div class="cam" id="cam" hidden>
      <div class="lens" id="lens"></div>
      <label class="slider" id="zoomWrap" hidden><span id="zoomLabel">Zoom</span><input id="zoom" type="range"></label>
      <label class="slider" id="expWrap" hidden><span id="expLabel">Exposicao</span><input id="exp" type="range"></label>
    </div>
    <div class="row">
      <button class="shoot" id="shoot">📷 Tirar foto</button>
      <button class="side" id="auto" title="Disparo automático">Auto</button>
      <button class="side" id="skip">Pular</button>
    </div>
    <div class="strip" id="strip"></div>
    <div class="status" id="status"></div>
  </div>
  <input id="camera" type="file" accept="image/*" capture="environment" hidden>
</div>

<div class="desk">
  <header class="deskbar">
    <div class="brand"><svg width="34" height="34" viewBox="0 0 64 64" fill="none" aria-hidden="true"><circle cx="35.5" cy="9.5" r="5.5" fill="#0000f7"/><path d="M24.6 13.6A22 22 0 1 0 53 42.5" stroke="#0000f7" stroke-width="8.5" stroke-linecap="round"/><path d="M24 31.5C24 25 29 20 35.5 20S47 25 47 31.5V36h6v7.5c0 3-1.6 5.5-4.4 6.7V39.6H40.8c-2 2.6-4.3 3.9-7 3.9C28.3 43.5 24 38.2 24 31.5Z" fill="#0000f7"/></svg><div><h1>Fotos do catálogo</h1><p class="sub" id="deskInfo">Chegam aqui assim que o celular tira.</p></div></div>
    <div class="tools">
      <span class="count" id="deskCount"></span>
      <select id="day" aria-label="Dia"></select>
      <span class="sep"></span>
      <button class="add" id="copyPrompt">Copiar prompt</button>
      <button class="add" id="addFiles">Adicionar fotos</button>
      <input id="deskFiles" type="file" accept="image/*" multiple hidden>
      <button class="danger" id="wipe" disabled>Apagar todas</button>
      <button class="copy" id="copyAll" disabled>Copiar todas</button>
    </div>
  </header>
  <div class="gallery" id="gallery"></div>
</div>
<div class="dropzone" id="dropzone"><span>Solte as fotos aqui</span></div>
<div class="lightbox" id="lightbox">
  <img id="big" alt="">
  <button class="nav prev" id="bigPrev" aria-label="Anterior">‹</button>
  <button class="nav next" id="bigNext" aria-label="Próxima">›</button>
  <button class="close" id="bigClose" aria-label="Fechar">×</button>
  <p id="bigCaption"></p>
</div>

<script type="module">
  // ------------------------------------------------------------------ roteiro
  // Os ângulos são os mesmos das imagens do carrossel: com a foto no ângulo certo a IA só edita (fica fiel ao produto).
  const STEPS = [
    { kind: "frente", label: "R1 · Frente 3/4", hint: "OBRIGATÓRIA. Vira a câmera uns 35° para a esquerda da frente (vê a frente e o lado esquerdo), na altura do assento. Inteiro e aberto.", assist: "frame" },
    { kind: "tras", label: "R2 · Trás 3/4", hint: "OBRIGATÓRIA. Por trás, uns 35° para o lado direito, na altura do assento. Inteiro.", assist: "frame" },
    { kind: "reta", label: "Frente reta", hint: "Bem de frente (0°), na altura do meio do equipamento. Vira a imagem de Medidas.", assist: "frame" },
    { kind: "lateral", label: "Lateral", hint: "Bem de lado (90°), pelo lado esquerdo, na altura do meio.", assist: "frame" },
    { kind: "detalhe", label: "Detalhes", hint: "De perto: apoio de pé, freio, braço, pneu. Vários seguidos; Pular avança.", assist: "none" },
    { kind: "dobrada", label: "Dobrada", hint: "Dobrado/fechado, inteiro. Pule se não dobra.", assist: "frame" },
    { kind: "etiqueta", label: "Etiqueta", hint: "Etiqueta do fabricante, bem de perto e legível (modelo, peso máximo, ANVISA).", assist: "none" },
  ];
  const LABEL = Object.fromEntries(STEPS.map((s) => [s.kind, s.label]));
  const $ = (id) => document.getElementById(id);
  const fileUrl = (day, file) => "/foto?dia=" + day + "&arquivo=" + encodeURIComponent(file);
  const kindOf = (file) => file.replace(/^\\d+-/, "").replace(/\\.\\w+$/, "");
  const today = new Date().toLocaleDateString("sv-SE");
  const isDesk = matchMedia("(min-width: 900px) and (hover: hover)").matches;

  // ------------------------------------------------------------------ celular: envio
  let step = 0;
  let sent = 0;
  const recent = [];

  function renderStep() {
    const s = STEPS[step];
    $("step").textContent = s.label;
    $("hint").textContent = s.hint;
    $("count").textContent = (step + 1) + " de " + STEPS.length;
    $("hoje").textContent = sent;
    $("dots").innerHTML = STEPS.map((_, i) =>
      '<li class="' + (i < step ? "feito" : i === step ? "agora" : "") + '"></li>').join("");
    $("strip").innerHTML = "";
    recent.slice(-8).reverse().forEach((p) => {
      const fig = document.createElement("figure");
      fig.className = p.state;
      const img = document.createElement("img");
      img.src = p.preview;
      fig.append(img);
      if (p.state === "error") fig.onclick = () => upload(p);
      $("strip").append(fig);
    });
  }

  async function upload(p) {
    p.state = "sending";
    $("status").className = "status";
    $("status").textContent = "Enviando " + LABEL[p.kind] + "…";
    renderStep();
    try {
      const res = await fetch("/foto?tipo=" + p.kind, { method: "POST", body: p.blob, headers: { "content-type": p.blob.type || "image/jpeg" } });
      if (!res.ok) throw new Error();
      p.state = "";
      sent++;
      $("status").textContent = LABEL[p.kind] + " salva no PC ✓";
    } catch {
      p.state = "error";
      $("status").className = "status bad";
      $("status").textContent = "Não chegou no PC. Toque na foto com borda vermelha para reenviar.";
    }
    renderStep();
  }

  function took(blob) {
    const p = { blob, kind: STEPS[step].kind, preview: URL.createObjectURL(blob), state: "" };
    recent.push(p);
    // Detalhe fica no mesmo passo (vários de seguida); "Pular" avança.
    if (STEPS[step].kind !== "detalhe") {
      step = (step + 1) % STEPS.length;
      if (step === 0) resetAssist();
    }
    navigator.vibrate?.(60);
    upload(p);
  }

  $("camera").onchange = (event) => {
    const blob = event.target.files[0];
    event.target.value = "";
    if (blob) took(blob);
  };
  $("skip").onclick = () => { step = (step + 1) % STEPS.length; if (step === 0) resetAssist(); renderStep(); };

  // ------------------------------------------------------------------ celular: assistente (rede neural)
  const video = $("video");
  const overlay = $("overlay");
  let live = false;
  let detector = null;
  let vision = null;
  let auto = true;
  let ref = null;        // caixa do equipamento na foto de frente (mesma distância na de trás)
  let needsMove = false; // depois de cada foto, só dispara de novo depois que a cena mudar (você virou o equipamento ou andou)
  let prevSmall = null;  // quadro anterior em miniatura, para saber se está parado
  let readySince = 0;
  let busy = false;
  const small = document.createElement("canvas");
  small.width = 32; small.height = 24;
  const smallCtx = small.getContext("2d", { willReadFrequently: true });

  let clock = 0;
  const stamp = () => (clock = Math.max(clock + 1, performance.now())); // MediaPipe exige tempo sempre crescente
  function resetAssist() { ref = null; }

  function say(text, tone) {
    $("say").textContent = text;
    $("say").className = "say" + (tone ? " " + tone : "");
  }
  function checks(list) {
    $("checks").innerHTML = list.map(([label, ok]) => '<li class="' + (ok ? "ok" : "") + '">' + (ok ? "✓ " : "") + label + "</li>").join("");
  }

  // ------------------------------------------------------------ camera profissional
  // Grande-angular (0,5x/0,6x), zoom, exposicao e flash. O que aparece depende do aparelho: so
  // entra o controle que a trilha de video declara em getCapabilities(). Em celular com
  // grande-angular separada, 0,5x troca de camera; quando e uma lente so, cai no menor zoom dela.
  let lentes = [];
  let lenteAtual = null;
  let caps = {};
  const ULTRA = /ultra|wide angle|grande|0[.,]5/i;
  const FRONTAL = /front|frontal|user|face/i;

  async function openStream(deviceId) {
    video.srcObject?.getTracks?.().forEach((t) => t.stop());
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }
        : { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    });
    video.srcObject = stream;
    lenteAtual = deviceId;
    await video.play();
  }

  function track() { return video.srcObject?.getVideoTracks?.()[0] ?? null; }

  async function aplicar(ajustes) {
    try { await track()?.applyConstraints({ advanced: [ajustes] }); }
    catch { say("O aparelho nao aceitou esse ajuste.", "warn"); }
  }

  async function setupCam() {
    const t = track();
    if (!t) return;
    caps = t.getCapabilities?.() ?? {};
    const atual = t.getSettings?.() ?? {};
    if (!lentes.length) {
      const todos = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      lentes = todos.filter((d) => d.kind === "videoinput" && !FRONTAL.test(d.label));
    }
    $("cam").hidden = false;

    const zoomWrap = $("zoomWrap"), zoom = $("zoom");
    if (caps.zoom) {
      zoomWrap.hidden = false;
      zoom.min = caps.zoom.min; zoom.max = caps.zoom.max;
      zoom.step = caps.zoom.step || (caps.zoom.max - caps.zoom.min) / 100;
      zoom.value = atual.zoom ?? caps.zoom.min;
      rotuloZoom(Number(zoom.value));
      zoom.oninput = () => { rotuloZoom(Number(zoom.value)); void aplicar({ zoom: Number(zoom.value) }); };
    } else zoomWrap.hidden = true;

    const expWrap = $("expWrap"), exp = $("exp");
    if (caps.exposureCompensation) {
      expWrap.hidden = false;
      exp.min = caps.exposureCompensation.min; exp.max = caps.exposureCompensation.max;
      exp.step = caps.exposureCompensation.step || 0.1;
      exp.value = atual.exposureCompensation ?? 0;
      rotuloExp(Number(exp.value));
      exp.oninput = () => { rotuloExp(Number(exp.value)); void aplicar({ exposureCompensation: Number(exp.value) }); };
    } else expWrap.hidden = true;

    desenharLentes();
  }

  function rotuloZoom(valor) {
    const base = caps.zoom?.min || 1;
    $("zoomLabel").textContent = "Zoom " + (valor / base).toFixed(1) + "x";
  }

  function rotuloExp(valor) {
    $("expLabel").textContent = "Exposicao " + (valor > 0 ? "+" : "") + valor.toFixed(1);
  }

  // Aproxima o fator pedido: a grande-angular quando ela existe separada, senao o zoom da lente.
  async function angulo(fator) {
    const ultra = lentes.find((d) => ULTRA.test(d.label));
    const naUltra = !!lenteAtual && ultra && lenteAtual === ultra.deviceId;
    if (fator < 1 && ultra && !naUltra) { await openStream(ultra.deviceId); return setupCam(); }
    if (fator >= 1 && naUltra) { await openStream(null); await setupCam(); if (fator === 1) return; }
    if (!caps.zoom) { say("Esta camera nao tem zoom ajustavel.", "warn"); return; }
    const alvo = Math.min(caps.zoom.max, Math.max(caps.zoom.min, caps.zoom.min * fator));
    $("zoom").value = alvo;
    rotuloZoom(alvo);
    await aplicar({ zoom: alvo });
    desenharLentes();
  }

  // Volta ao normal: lente principal, zoom minimo, exposicao neutra e flash apagado.
  async function resetCam() {
    if (lenteAtual) await openStream(null);
    const ajustes = {};
    if (caps.zoom) ajustes.zoom = caps.zoom.min;
    if (caps.exposureCompensation) ajustes.exposureCompensation = 0;
    if (caps.torch) ajustes.torch = false;
    await aplicar(ajustes);
    await setupCam();
    say("Camera no normal.", "ok");
  }

  function desenharLentes() {
    const atual = track()?.getSettings?.() ?? {};
    const flashOn = !!atual.torch;
    const base = caps.zoom?.min || 1;
    const zoomAtual = atual.zoom ?? base;
    const temUltra = lentes.some((d) => ULTRA.test(d.label));
    const naUltra = !!lenteAtual && temUltra && ULTRA.test(lentes.find((d) => d.deviceId === lenteAtual)?.label || "");
    const cabe = (f) => (f < 1 ? temUltra || !!caps.zoom : caps.zoom ? caps.zoom.max / base >= f : f === 1);
    const fatores = [0.5, 0.6, 1, 2, 3, 5].filter(cabe);
    const marcada = (f) => (f < 1 ? naUltra && f === 0.5 : !naUltra && Math.abs(zoomAtual / base - f) < 0.08);
    let html = fatores
      .map((f) => '<button class="chip' + (marcada(f) ? " on" : "") + '" data-f="' + f + '">' + String(f).replace(".", ",") + 'x</button>')
      .join("");
    if (caps.torch) html += '<button class="chip' + (flashOn ? " on" : "") + '" data-flash="1">Flash</button>';
    html += '<button class="chip" data-reset="1">Normal</button>';
    $("lens").innerHTML = html;
    for (const b of $("lens").querySelectorAll("button")) {
      b.onclick = () => {
        if (b.dataset.reset) { void resetCam(); return; }
        if (b.dataset.flash) { void aplicar({ torch: !flashOn }).then(desenharLentes); return; }
        void angulo(Number(b.dataset.f));
      };
    }
  }

  async function startLive() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      document.querySelector(".phone").classList.add("nolive");
      say("Toque em Tirar foto: abre a câmera do celular.");
      $("auto").hidden = true;
      return;
    }
    try {
      await openStream(null);
      live = true;
      $("viewOff").hidden = true;
      say("Carregando o assistente…");
      void setupCam();
    } catch (error) {
      document.querySelector(".phone").classList.add("nolive");
      say("Toque em Tirar foto: abre a câmera do celular.");
      $("auto").hidden = true;
      return;
    }
    try {
      const base = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
      vision = await import(base + "/vision_bundle.mjs");
      const files = await vision.FilesetResolver.forVisionTasks(base + "/wasm");
      detector = await vision.ObjectDetector.createFromOptions(files, {
        baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite", delegate: "GPU" },
        runningMode: "VIDEO",
        scoreThreshold: 0.25,
        maxResults: 5,
      });
    } catch {
      say("Assistente não carregou (sem internet?). Dá para tirar normalmente.");
    }
    setInterval(tick, 330);
  }

  // Maior objeto que não é pessoa: cadeira, cama, andador (o modelo costuma chamar de chair, bed, bicycle…).
  function findProduct(result) {
    const list = (result?.detections ?? []).filter((d) => d.categories[0]?.categoryName !== "person");
    if (!list.length) return null;
    const best = list.reduce((a, b) => (a.boundingBox.width * a.boundingBox.height > b.boundingBox.width * b.boundingBox.height ? a : b));
    const b = best.boundingBox, w = video.videoWidth, h = video.videoHeight;
    return { x: b.originX / w, y: b.originY / h, w: b.width / w, h: b.height / h, cx: (b.originX + b.width / 2) / w, bottom: (b.originY + b.height) / h };
  }

  function stillness() {
    smallCtx.drawImage(video, 0, 0, 32, 24);
    const data = smallCtx.getImageData(0, 0, 32, 24).data;
    let diff = 0;
    if (prevSmall) for (let i = 0; i < data.length; i += 4) diff += Math.abs(data[i] - prevSmall[i]);
    prevSmall = data.slice();
    return prevSmall && diff / (32 * 24) < 7;
  }

  function drawBox(box, ok) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const largura = Math.round(overlay.clientWidth * devicePixelRatio);
    const altura = Math.round(overlay.clientHeight * devicePixelRatio);
    if (overlay.width !== largura || overlay.height !== altura) { overlay.width = largura; overlay.height = altura; }
    const ctx = overlay.getContext("2d");
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!box || !vw) return;
    const scale = Math.min(overlay.width / vw, overlay.height / vh);
    const ox = (overlay.width - vw * scale) / 2, oy = (overlay.height - vh * scale) / 2;
    ctx.lineWidth = 3 * devicePixelRatio;
    ctx.strokeStyle = ok ? "#3ddc84" : "#ffb020";
    ctx.strokeRect(ox + box.x * vw * scale, oy + box.y * vh * scale, box.w * vw * scale, box.h * vh * scale);
    if (ref) {
      ctx.setLineDash([8 * devicePixelRatio, 6 * devicePixelRatio]);
      ctx.strokeStyle = "rgba(254,254,252,.7)";
      const lineY = oy + ref.bottom * vh * scale;
      ctx.beginPath(); ctx.moveTo(ox, lineY); ctx.lineTo(ox + vw * scale, lineY); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function tick() {
    if (!live || busy || !video.videoWidth) return;
    const s = STEPS[step];
    const now = performance.now();
    const still = stillness();
    if (needsMove && !still) needsMove = false;
    if (s.assist === "none" || !detector) {
      drawBox(null);
      checks([["Parado", still]]);
      say(still ? "Pode tirar." : "Segure firme…", still ? "ok" : "");
      readySince = 0;
      return;
    }
    const box = findProduct(detector.detectForVideo(video, stamp()));
    let msg = "", ok = false, centered = false, sized = false;
    if (!box) {
      msg = "Não estou vendo o equipamento. Enquadre ele inteiro.";
    } else {
      const cut = box.x < 0.01 || box.y < 0.01 || box.x + box.w > 0.99 || box.bottom > 0.99;
      centered = Math.abs(box.cx - 0.5) < 0.07;
      const base = ref && ["tras", "lateral", "reta"].includes(s.kind) ? ref : null;
      const ratio = base ? box.h / base.h : box.h / 0.6;
      sized = !cut && ratio > 0.9 && ratio < 1.12;
      if (cut) msg = "Afaste um pouco: o equipamento está cortado.";
      else if (ratio <= 0.9) msg = base ? "Chegue um pouco mais perto (igual à frente)." : "Chegue mais perto.";
      else if (ratio >= 1.12) msg = "Afaste um pouco" + (base ? " (igual à frente)." : ".");
      else if (!centered) msg = box.cx > 0.5 ? "Mova o celular um pouco para a direita →" : "← Mova o celular um pouco para a esquerda";
      else if (needsMove) msg = "Agora posicione para: " + s.label + ".";
      else if (!still) msg = "Segure firme…";
      else { msg = "Perfeito!" + (auto ? " Segure…" : " Pode tirar."); ok = true; }
    }
    drawBox(box, ok);
    checks([["Enquadrado", !!box && sized], ["Centro", centered], ["Parado", still]]);
    say(msg, ok ? "ok" : box ? "warn" : "");
    if (!ok) { readySince = 0; return; }
    if (!readySince) readySince = now;
    if (auto && now - readySince > 900) capture(box);
  }

  async function grab() {
    // Foto na resolução máxima do sensor quando o navegador deixa; senão, o quadro do vídeo.
    const track = video.srcObject?.getVideoTracks?.()[0];
    if (track && "ImageCapture" in window) {
      try { return await new ImageCapture(track).takePhoto(); } catch {}
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    return await new Promise((done) => canvas.toBlob(done, "image/jpeg", 0.92));
  }

  async function capture(box) {
    if (busy) return;
    busy = true;
    readySince = 0;
    needsMove = true;
    const s = STEPS[step];
    say("📸 Foto!", "ok");
    try {
      if (s.kind === "frente" && box) ref = box;
      const blob = await grab();
      if (blob) took(blob);
    } finally {
      setTimeout(() => { busy = false; }, 700);
    }
  }

  $("shoot").onclick = () => {
    if (!live) return $("camera").click();
    const s = STEPS[step];
    const box = s.assist !== "none" && detector && video.videoWidth ? findProduct(detector.detectForVideo(video, stamp())) : null;
    capture(box);
  };
  $("auto").onclick = () => {
    auto = !auto;
    $("auto").classList.toggle("on", auto);
    $("auto").textContent = auto ? "Auto ✓" : "Auto";
  };
  $("auto").classList.add("on");
  $("auto").textContent = "Auto ✓";

  // ------------------------------------------------------------------ PC: galeria
  let deskDay = today;
  let deskPhotos = [];
  let open = -1;

  async function loadDesk(force) {
    const data = await fetch("/fotos?dia=" + deskDay).then((r) => r.json());
    const days = data.days.includes(today) ? data.days : [today, ...data.days];
    if ($("day").options.length !== days.length) {
      $("day").innerHTML = days.map((d) => '<option value="' + d + '">' + d.split("-").reverse().join("/") + (d === today ? " (hoje)" : "") + "</option>").join("");
      $("day").value = deskDay;
    }
    if (!force && data.photos.join() === deskPhotos.join()) return;
    deskPhotos = data.photos;
    $("wipe").disabled = !deskPhotos.length;
    $("copyAll").disabled = !deskPhotos.length;
    $("deskInfo").textContent = "Chegam aqui assim que o celular tira.";
    $("deskCount").textContent = deskPhotos.length ? deskPhotos.length + (deskPhotos.length === 1 ? " foto" : " fotos") : "";
    $("gallery").innerHTML = deskPhotos.length ? "" : VAZIO;
    deskPhotos.forEach((file, index) => {
      const fig = document.createElement("figure");
      const button = document.createElement("button");
      const img = document.createElement("img");
      img.src = fileUrl(deskDay, file);
      img.loading = "lazy";
      img.alt = LABEL[kindOf(file)] || "Foto";
      button.append(img);
      button.onclick = () => show(index);
      const cap = document.createElement("figcaption");
      const nome = document.createElement("b");
      nome.textContent = (LABEL[kindOf(file)] || kindOf(file)).replace(/^R\d+ · /, "");
      const num = document.createElement("span");
      num.textContent = file.slice(0, 3);
      cap.append(nome, num);
      const del = document.createElement("button");
      del.className = "del"; del.title = "Apagar esta foto"; del.setAttribute("aria-label", "Apagar esta foto"); del.textContent = "×";
      del.onclick = async () => {
        if (!confirm("Apagar a foto " + file + "?")) return;
        await fetch("/foto?dia=" + deskDay + "&arquivo=" + encodeURIComponent(file), { method: "DELETE" });
        loadDesk(true);
      };
      fig.append(button, cap, del);
      $("gallery").append(fig);
    });
  }

  const VAZIO = '<div class="empty">'
    + '<span class="tile"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#66706b" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M14.5 4h-5L8 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-4l-1.5-2Z"/><circle cx="12" cy="13" r="3.5"/></svg></span>'
    + '<b>Nenhuma foto neste dia</b>'
    + '<p>Abra esta página no celular pelo Wi-Fi e tire as fotos: elas chegam aqui na hora.</p></div>';

  function show(index) {
    if (!deskPhotos.length) return;
    open = (index + deskPhotos.length) % deskPhotos.length;
    const file = deskPhotos[open];
    $("big").src = fileUrl(deskDay, file);
    $("bigCaption").textContent = (open + 1) + " de " + deskPhotos.length + " · " + (LABEL[kindOf(file)] || kindOf(file));
    $("lightbox").classList.add("open");
  }
  const hide = () => { open = -1; $("lightbox").classList.remove("open"); };
  $("bigPrev").onclick = () => show(open - 1);
  $("bigNext").onclick = () => show(open + 1);
  $("bigClose").onclick = hide;
  $("lightbox").onclick = (event) => { if (event.target.id === "lightbox") hide(); };
  document.addEventListener("keydown", (event) => {
    if (open < 0) return;
    if (event.key === "Escape") hide();
    if (event.key === "ArrowLeft") show(open - 1);
    if (event.key === "ArrowRight") show(open + 1);
  });
  $("day").onchange = (event) => { deskDay = event.target.value; deskPhotos = []; loadDesk(true); };
  // Arrastar ou escolher fotos no PC: entram no dia de hoje como se tivessem vindo do celular (sem ângulo marcado).
  async function addDeskFiles(files) {
    const list = [...files].filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    $("deskInfo").textContent = "Enviando " + list.length + (list.length === 1 ? " foto…" : " fotos…");
    for (const f of list) await fetch("/foto?tipo=foto", { method: "POST", body: f, headers: { "content-type": f.type || "image/jpeg" } });
    deskDay = today; $("day").value = today; loadDesk(true);
  }
  $("copyPrompt").onclick = async () => {
    const res = await fetch("/copiar-prompt", { method: "POST" }).then((r) => r.ok).catch(() => false);
    $("copyPrompt").textContent = res ? "Prompt copiado ✓ · Ctrl+V" : "Não deu para copiar";
    setTimeout(() => ($("copyPrompt").textContent = "Copiar prompt"), 2500);
  };
  $("addFiles").onclick = () => $("deskFiles").click();
  $("deskFiles").onchange = (e) => { addDeskFiles(e.target.files); e.target.value = ""; };
  let dragDepth = 0;
  document.addEventListener("dragenter", (e) => { if (!isDesk || !e.dataTransfer?.types.includes("Files")) return; dragDepth++; $("dropzone").classList.add("on"); });
  document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("dropzone").classList.remove("on"); } });
  document.addEventListener("dragover", (e) => { if (isDesk) e.preventDefault(); });
  document.addEventListener("drop", (e) => { if (!isDesk) return; e.preventDefault(); dragDepth = 0; $("dropzone").classList.remove("on"); addDeskFiles(e.dataTransfer.files); });

  $("copyAll").onclick = async () => {
    const res = await fetch("/copiar?dia=" + deskDay, { method: "POST" }).then((r) => r.json()).catch(() => ({}));
    $("copyAll").textContent = res.copied ? res.copied + " copiadas ✓ · Ctrl+V" : "Não deu para copiar";
    setTimeout(() => ($("copyAll").textContent = "Copiar todas"), 2500);
  };
  $("wipe").onclick = async () => {
    const when = deskDay === today ? "de hoje" : "de " + deskDay.split("-").reverse().join("/");
    if (!confirm("Apagar todas as " + deskPhotos.length + " fotos " + when + "? Não dá para desfazer.")) return;
    await fetch("/fotos?dia=" + deskDay, { method: "DELETE" });
    loadDesk(true);
  };

  // ------------------------------------------------------------------ início
  if (isDesk) {
    loadDesk(true);
    setInterval(loadDesk, 3000);
  } else {
    // Retoma o roteiro de onde parou hoje (a próxima depois da última foto).
    fetch("/fotos?dia=" + today).then((r) => r.json()).then((data) => {
      sent = data.photos.length;
      const last = data.photos.at(-1);
      const index = last ? STEPS.findIndex((s) => s.kind === kindOf(last)) : -1;
      step = index >= 0 ? (index + 1) % STEPS.length : 0;
      renderStep();
    });
    renderStep();
    startLive();
  }
</script>
</body>
</html>`;
