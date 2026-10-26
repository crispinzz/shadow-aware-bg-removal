// Realçador de fotos: ferramenta própria, sem marca de ninguém. Só no servidor de desenvolvimento.
// As fotos do celular chegam pelo servidor da câmera (porta 5180, via proxy /galeria) e a lista
// se atualiza sozinha, então a foto aparece aqui segundos depois de ser tirada.
//
// Existe UM tratamento: trocar o fundo infinito por branco limpo. Cor, saturação, luz e nitidez do
// produto não são tocadas. A sombra volta sozinha (Multiply) e o pincel serve para insistir nela.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { ArrowLeft, ArrowRight, Brush, Download, Eraser, Grid3x3, House, Image as ImageIcon, LogOut, Moon, Radio, Search, Smartphone, Sun, X } from "lucide-react";
import { smoothBackdrop } from "../src/backdrop";
import { arquivoUrl, processar as recortarNoEstudio } from "./studio-client";
import "./studio.css";

const RECARGA = 4000; // de quanto em quanto tempo procura foto nova
const NOME = (arquivo: string) => arquivo.replace(/^\d+-/, "").replace(/\.\w+$/, "").replace(/-/g, " ");
const fotoUrl = (dia: string, arquivo: string) => `/galeria/foto?dia=${dia}&arquivo=${encodeURIComponent(arquivo)}`;

type Galeria = { dia: string; dias: string[]; fotos: string[] };
type Modo = "sombra" | "apagar";
type Tema = "claro" | "escuro";

// A rede do Estúdio trabalha em 1024 px: mandar 12 MP só gasta decodificação e uma segunda passada
// que não muda a máscara. Reduzida, a foto volta em segundos; a máscara é ampliada na composição.
const LADO_RECORTE = 1400;
async function reduzir(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const escala = Math.min(1, LADO_RECORTE / Math.max(bitmap.width, bitmap.height));
  if (escala === 1) { bitmap.close(); return file; }
  const tela = document.createElement("canvas");
  tela.width = Math.round(bitmap.width * escala);
  tela.height = Math.round(bitmap.height * escala);
  tela.getContext("2d")!.drawImage(bitmap, 0, 0, tela.width, tela.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((ok) => tela.toBlob(ok, "image/jpeg", 0.92));
  return blob ? new File([blob], file.name, { type: "image/jpeg" }) : file;
}

const carregarImagem = (url: string) => new Promise<HTMLImageElement>((ok, falha) => {
  const img = new Image();
  img.onload = () => ok(img);
  img.onerror = () => falha(new Error("Não consegui ler a máscara do Estúdio."));
  img.src = url;
});

/** Marca da ferramenta: três formas, sem ligação com nenhuma empresa. */
function Marca() {
  return (
    <svg className="rt-marca" viewBox="0 0 44 14" aria-label="Realçador" role="img">
      <path d="M7 0 14 14H0Z" />
      <circle cx="22" cy="7" r="7" />
      <rect x="30" y="0" width="14" height="14" rx="2" />
    </svg>
  );
}

/** Antes e depois na mesma moldura, com um divisor que se arrasta. */
function Cortina({ antes, depois, xadrez }: { antes: string; depois: string; xadrez?: boolean }) {
  const caixa = useRef<HTMLDivElement>(null);
  const [corte, setCorte] = useState(50);
  const arrastando = useRef(false);

  const mover = useCallback((clientX: number) => {
    const r = caixa.current?.getBoundingClientRect();
    if (!r) return;
    setCorte(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => arrastando.current && mover(e.clientX);
    const solta = () => { arrastando.current = false; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", solta);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", solta); };
  }, [mover]);

  return (
    <div ref={caixa} className={xadrez ? "rt-cortina rt-cortina--xadrez" : "rt-cortina"} onPointerDown={(e) => { arrastando.current = true; mover(e.clientX); }}>
      <img src={depois} alt="Depois" className="rt-cortina-base" />
      <div className="rt-cortina-topo" style={{ width: `${corte}%` }}>
        <img src={antes} alt="Antes" />
      </div>
      <div className="rt-cortina-linha" style={{ left: `${corte}%` }}>
        <span className="rt-cortina-alca" aria-hidden="true" />
      </div>
      <span className="rt-cortina-marca rt-cortina-marca--antes">Antes</span>
      <span className="rt-cortina-marca rt-cortina-marca--depois">Depois</span>
    </div>
  );
}

/**
 * Pincel da sombra: você pinta por cima da foto original onde a sombra está, e o traço vai para o
 * tratamento como máscara. Serve quando a sombra é fraca demais para passar sozinha.
 */
function Pincel({ foto, w, h, modo, aoAplicar, aoCancelar }: {
  foto: string; w: number; h: number; modo: Modo;
  aoAplicar: (trilha: HTMLCanvasElement) => void;
  aoCancelar: () => void;
}) {
  const tela = useRef<HTMLCanvasElement>(null);
  const pintando = useRef(false);
  const ultimo = useRef<{ x: number; y: number } | null>(null);
  const [grossura, setGrossura] = useState(60);
  const [pintou, setPintou] = useState(false);

  const ponto = (e: React.PointerEvent) => {
    const c = tela.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };

  const traco = (de: { x: number; y: number } | null, ate: { x: number; y: number }) => {
    const ctx = tela.current!.getContext("2d")!;
    const cor = modo === "sombra" ? "rgba(90,90,255,.5)" : "rgba(255,70,70,.45)";
    ctx.strokeStyle = cor;
    ctx.fillStyle = cor;
    ctx.lineWidth = grossura;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (de) { ctx.beginPath(); ctx.moveTo(de.x, de.y); ctx.lineTo(ate.x, ate.y); ctx.stroke(); }
    else { ctx.beginPath(); ctx.arc(ate.x, ate.y, grossura / 2, 0, Math.PI * 2); ctx.fill(); }
    setPintou(true);
  };

  return (
    <div className="rt-pincel" data-modo={modo}>
      <div className="rt-pincel-palco">
        <img src={foto} alt="Foto original" />
        <canvas
          ref={tela}
          width={w}
          height={h}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            pintando.current = true;
            const pt = ponto(e);
            ultimo.current = pt;
            traco(null, pt);
          }}
          onPointerMove={(e) => {
            if (!pintando.current) return;
            const pt = ponto(e);
            traco(ultimo.current, pt);
            ultimo.current = pt;
          }}
          onPointerUp={() => { pintando.current = false; ultimo.current = null; }}
        />
      </div>
      <div className="rt-barra">
        <label className="rt-range">
          Pincel
          <input type="range" min={10} max={240} step={5} value={grossura} onChange={(e) => setGrossura(Number(e.target.value))} />
        </label>
        <button className="rt-botao" onClick={() => {
          const c = tela.current!;
          c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
          setPintou(false);
        }}>Limpar</button>
        <button className="rt-botao" onClick={aoCancelar}>Cancelar</button>
        <button className="rt-botao rt-botao--principal" disabled={!pintou} onClick={() => aoAplicar(tela.current!)}>
          {modo === "sombra" ? "Aplicar a sombra" : "Remover o que pintei"}
        </button>
      </div>
      <p className="rt-dica">
        {modo === "sombra"
          ? "Pinte por cima da sombra que fica no chão. O resto do fundo sai branco."
          : "Pinte tudo que não é o produto: tripé, caixa, quina de móvel. Pode marcar vários de uma vez."}
      </p>
    </div>
  );
}

export default function StudioPage() {
  const escolher = useRef<HTMLInputElement>(null);
  const trilho = useRef<HTMLUListElement>(null);
  const original = useRef<File | null>(null);
  const [galeria, setGaleria] = useState<Galeria | null>(null);
  const [semServidor, setSemServidor] = useState(false);
  const [qr, setQr] = useState<{ img: string; url: string } | null>(null);
  const [busca, setBusca] = useState("");
  const [antes, setAntes] = useState<{ url: string; titulo: string } | null>(null);
  const [depois, setDepois] = useState<{ url: string; nome: string; cobertura: number; ms: number; w: number; h: number } | null>(null);
  const [pincel, setPincel] = useState<Modo | null>(null);
  // Os traços ficam guardados: dá para remover um objeto, ver o resultado e ainda pintar a sombra.
  const marcas = useRef<{ sombra?: HTMLCanvasElement; apagar?: HTMLCanvasElement }>({});
  // Fundo da saída: branco limpo (JPEG) ou transparente (PNG, com a sombra por cima do xadrez). O
  // ref espelha o estado para o rodar reusar o modo atual sem virar dependência do callback.
  const [fundo, setFundo] = useState<"branco" | "transparente">("branco");
  const fundoRef = useRef(fundo);
  fundoRef.current = fundo;
  // A página também é renderizada no servidor, onde localStorage não existe: começa no claro e
  // corrige no navegador, na primeira pintura.
  const [tema, setTema] = useState<Tema>("claro");
  useEffect(() => {
    const salvo = localStorage.getItem("rt-tema") as Tema | null;
    setTema(salvo ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "escuro" : "claro"));
  }, []);
  useEffect(() => { localStorage.setItem("rt-tema", tema); }, [tema]);
  const [etapa, setEtapa] = useState("");
  const [rodando, setRodando] = useState(false);
  const [arrastando, setArrastando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const carregarGaleria = useCallback(async (dia?: string) => {
    try {
      const r = await fetch(`/galeria/fotos${dia ? `?dia=${dia}` : ""}`);
      if (!r.ok) throw new Error(String(r.status));
      const data = (await r.json()) as { day: string; days: string[]; photos: string[] };
      setSemServidor(false);
      // hoje só entra na lista depois da primeira foto do dia: sem pasta, cai no dia mais recente que existe
      if (!dia && data.days.length && !data.days.includes(data.day)) return void carregarGaleria(data.days[0]);
      setGaleria((atual) =>
        atual && atual.dia === data.day && atual.fotos.join() === data.photos.join()
          ? atual // nada mudou: não re-renderiza a grade
          : { dia: data.day, dias: data.days, fotos: data.photos });
    } catch {
      setSemServidor(true);
    }
  }, []);

  useEffect(() => { void carregarGaleria(); }, [carregarGaleria]);

  useEffect(() => {
    const t = setInterval(() => void carregarGaleria(galeria?.dia), RECARGA);
    return () => clearInterval(t);
  }, [carregarGaleria, galeria?.dia]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/galeria/rede");
        const { urls } = (await r.json()) as { urls: string[] };
        if (!urls.length) return;
        setQr({ img: await QRCode.toDataURL(urls[0], { margin: 1, width: 240, color: { dark: "#101114", light: "#ffffff" } }), url: urls[0] });
      } catch { /* sem servidor da câmera: a página segue sem o QR */ }
    })();
  }, [semServidor]);

  const rodar = useCallback(async (file: File, titulo: string, novo?: boolean) => {
    original.current = file;
    if (novo) { marcas.current = {}; setAntes({ url: URL.createObjectURL(file), titulo }); }
    setDepois(null);
    setErro(null);
    setPincel(null);
    setRodando(true);
    setEtapa("");
    try {
      // O Estúdio diz onde está o produto; o branco e a sombra são montados aqui, sobre a original.
      setEtapa("O Estúdio está achando o produto…");
      const trabalho = await recortarNoEstudio(await reduzir(file));
      const mascara = trabalho.arquivos.mascara;
      if (!mascara) throw new Error("O Estúdio terminou sem a máscara do produto.");
      const desenho = await carregarImagem(arquivoUrl(mascara.id));
      setEtapa("Limpando o fundo…");
      const res = await smoothBackdrop(file, file.name, marcas.current.sombra, desenho, marcas.current.apagar, fundoRef.current === "transparente");
      setDepois({ url: URL.createObjectURL(res.file), nome: res.file.name, cobertura: res.cobertura, ms: res.ms, w: res.w, h: res.h });
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setRodando(false);
      setEtapa("");
    }
  }, []);

  const trocarFundo = () => {
    const novo = fundo === "branco" ? "transparente" : "branco";
    setFundo(novo);
    fundoRef.current = novo;
    if (original.current) void rodar(original.current, antes?.titulo ?? "");
  };

  const daGaleria = useCallback(async (arquivo: string) => {
    if (!galeria || rodando) return;
    const blob = await (await fetch(fotoUrl(galeria.dia, arquivo))).blob();
    void rodar(new File([blob], arquivo, { type: blob.type }), NOME(arquivo), true);
  }, [galeria, rodando, rodar]);

  useEffect(() => {
    const colar = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (file && !rodando) void rodar(file, "Foto colada", true);
    };
    window.addEventListener("paste", colar);
    return () => window.removeEventListener("paste", colar);
  }, [rodando, rodar]);

  // O aviso de "solte aqui" some quando o arrasto sai da janela ou termina em outro lugar.
  useEffect(() => {
    const fora = (e: DragEvent) => { if (!e.relatedTarget) setArrastando(false); };
    const fim = () => setArrastando(false);
    window.addEventListener("dragleave", fora);
    window.addEventListener("dragend", fim);
    window.addEventListener("drop", fim);
    window.addEventListener("blur", fim);
    return () => {
      window.removeEventListener("dragleave", fora);
      window.removeEventListener("dragend", fim);
      window.removeEventListener("drop", fim);
      window.removeEventListener("blur", fim);
    };
  }, []);

  const fotos = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    const lista = galeria?.fotos ?? [];
    return termo ? lista.filter((f) => NOME(f).toLowerCase().includes(termo)) : lista;
  }, [galeria?.fotos, busca]);

  const correr = (passo: number) => trilho.current?.scrollBy({ left: passo * 320, behavior: "smooth" });

  return (
    <div
      className="rt"
      data-tema={tema}
      onDragOver={(e) => {
        e.preventDefault();
        if (Array.from(e.dataTransfer.items).some((i) => i.kind === "file")) setArrastando(true);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setArrastando(false);
        const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
        if (file && !rodando) void rodar(file, file.name, true);
      }}
    >
      <aside className="rt-rail">
        <Marca />
        <nav>
          <button className="rt-rail-item is-on" title="Estúdio" onClick={() => { setAntes(null); setDepois(null); setPincel(null); marcas.current = {}; }}><House size={20} /></button>
          <button className="rt-rail-item" title="Pincel da sombra" disabled={!depois} onClick={() => setPincel("sombra")}><Brush size={20} /></button>
          <button className="rt-rail-item" title="Remover objeto" disabled={!depois} onClick={() => setPincel("apagar")}><Eraser size={20} /></button>
          <button className="rt-rail-item" title="Fotos do celular" onClick={() => trilho.current?.scrollIntoView({ behavior: "smooth" })}><ImageIcon size={20} /></button>
          <button className="rt-rail-item" title="Abrir a câmera do celular" disabled={!qr} onClick={() => qr && window.open(qr.url, "_blank")}><Smartphone size={20} /></button>
          <button className="rt-rail-item" title={semServidor ? "Servidor da câmera fora do ar" : "Servidor da câmera no ar"}>
            <Radio size={20} className={semServidor ? undefined : "rt-vivo"} />
          </button>
        </nav>
        <button
          className="rt-rail-item rt-rail-fim"
          title={tema === "claro" ? "Modo escuro" : "Modo claro"}
          onClick={() => setTema(tema === "claro" ? "escuro" : "claro")}
        >
          {tema === "claro" ? <Moon size={20} /> : <Sun size={20} />}
        </button>
        <button className="rt-rail-item" title="Fechar" onClick={() => window.close()}><LogOut size={20} /></button>
      </aside>

      <div className="rt-corpo">
        <header className="rt-topo">
          <label className="rt-busca">
            <Search size={17} />
            <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar foto" />
            {busca ? <button onClick={() => setBusca("")} aria-label="Limpar busca"><X size={14} /></button> : null}
          </label>
          <div className="rt-topo-dir">
            {galeria?.dias.length ? (
              <select value={galeria.dia} onChange={(e) => void carregarGaleria(e.target.value)} aria-label="Dia">
                {galeria.dias.map((d) => <option key={d} value={d}>{d.split("-").reverse().join("/")}</option>)}
              </select>
            ) : null}
            <input ref={escolher} type="file" accept="image/*" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void rodar(f, f.name, true); e.target.value = ""; }} />
            <button className="rt-botao rt-botao--principal" disabled={rodando} onClick={() => escolher.current?.click()}>
              {rodando ? "Trabalhando…" : "Escolher foto"}
            </button>
          </div>
        </header>

        <main className="rt-tela">
          <section className="rt-bloco">
            <header className="rt-bloco-topo">
              <h2>{fundo === "branco" ? "Fundo branco" : "Fundo transparente"}</h2>
              <span>{antes ? antes.titulo : "Escolha uma foto para começar"}</span>
              {depois ? (
                <div className="rt-bloco-acoes">
                  <button className="rt-botao" onClick={() => setPincel(pincel === "sombra" ? null : "sombra")}><Brush size={15} /> Sombra</button>
                  <button className="rt-botao" onClick={() => setPincel(pincel === "apagar" ? null : "apagar")}><Eraser size={15} /> Remover objeto</button>
                  <button className="rt-botao" disabled={rodando} onClick={trocarFundo}><Grid3x3 size={15} /> {fundo === "branco" ? "Transparente" : "Fundo branco"}</button>
                  <a className="rt-botao rt-botao--principal" href={depois.url} download={depois.nome}><Download size={15} /> Baixar</a>
                </div>
              ) : null}
            </header>

            <div className="rt-palco">
              {antes && pincel && depois ? (
                <Pincel
                  key={pincel}
                  foto={antes.url}
                  w={depois.w}
                  h={depois.h}
                  modo={pincel}
                  aoCancelar={() => setPincel(null)}
                  aoAplicar={(trilha) => {
                    marcas.current[pincel] = trilha;
                    if (original.current) void rodar(original.current, antes.titulo);
                  }}
                />
              ) : antes && depois ? (
                <Cortina antes={antes.url} depois={depois.url} xadrez={fundo === "transparente"} />
              ) : antes ? (
                <div className="rt-cortina rt-cortina--so">
                  <img src={antes.url} alt="Antes" className="rt-cortina-base" />
                  <span className="rt-cortina-brilho" />
                  <span className="rt-etapa">{etapa || "Trabalhando…"}</span>
                </div>
              ) : (
                <div className="rt-zero">
                  <b>Nenhuma foto selecionada</b>
                  <p>Escolha uma foto do celular abaixo, arraste para cá, cole com Ctrl+V ou clique em "Escolher foto".</p>
                </div>
              )}
            </div>

            {depois ? (
              <footer className="rt-ficha">
                <div><span>Fundo</span><b>{(depois.cobertura * 100).toFixed(0)}% do quadro</b></div>
                <div><span>Montagem</span><b>{(depois.ms / 1000).toFixed(1)} s</b></div>
                <div><span>Tamanho</span><b>{depois.w} × {depois.h}</b></div>
                <div><span>Produto</span><b>intocado</b></div>
              </footer>
            ) : null}
            {erro ? <p className="rt-erro">{erro}</p> : null}
          </section>

          <section className="rt-bloco">
            <header className="rt-bloco-topo">
              <h2>Fotos do celular</h2>
              <span>{semServidor ? "servidor fora do ar" : `${fotos.length} no dia`}</span>
              <div className="rt-bloco-acoes">
                <button className="rt-redondo" onClick={() => correr(-1)} aria-label="Anteriores"><ArrowLeft size={16} /></button>
                <button className="rt-redondo" onClick={() => correr(1)} aria-label="Próximas"><ArrowRight size={16} /></button>
              </div>
            </header>

            {semServidor ? (
              <div className="rt-zero">
                <b>O servidor da câmera não está no ar</b>
                <p>Rode <code>node site/scripts/foto-catalogo.mjs</code> para ver aqui as fotos que o celular tira.</p>
                <button type="button" className="rt-botao" onClick={() => void carregarGaleria()}>Procurar de novo</button>
              </div>
            ) : (
              <ul className="rt-trilho" ref={trilho}>
                {fotos.map((arquivo) => (
                  <li key={arquivo}>
                    <button type="button" disabled={rodando} onClick={() => void daGaleria(arquivo)} className="rt-card">
                      <img src={fotoUrl(galeria!.dia, arquivo)} alt={NOME(arquivo)} loading="lazy" />
                      <div className="rt-card-pe">
                        <b>{NOME(arquivo)}</b>
                        <span>{arquivo.split("-")[0]}</span>
                      </div>
                    </button>
                  </li>
                ))}
                {qr ? (
                  <li>
                    <div className="rt-card rt-card--qr">
                      <img src={qr.img} alt={`QR para ${qr.url}`} />
                      <div className="rt-card-pe">
                        <b>Tirar foto pelo celular</b>
                        <span>mesmo Wi-Fi</span>
                      </div>
                    </div>
                  </li>
                ) : null}
                {!fotos.length && !qr ? <li className="rt-zero"><b>Nenhuma foto neste dia</b></li> : null}
              </ul>
            )}
          </section>
        </main>
      </div>

      {arrastando ? <div className="rt-solte"><span>Solte a foto aqui</span></div> : null}
    </div>
  );
}
