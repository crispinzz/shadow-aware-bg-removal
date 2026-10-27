// SHARP — estúdio local. A foto nunca sai da máquina: o backend escuta só em 127.0.0.1, e as fotos
// tratadas ficam no navegador (IndexedDB), não num servidor.
//
// Fluxo: escolhe a foto → ajusta o fundo (branco, cor ou transparente) e o formato → processa. O
// produto não é tocado; a sombra volta sozinha (Multiply) e o pincel serve para insistir nela.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { Brush, Check, Cpu, Download, Eraser, House, Image as ImageIcon, Moon, Palette, Radio, Search, SlidersHorizontal, Smartphone, Sun, Trash2, X } from "lucide-react";
import { smoothBackdrop, type BackdropOpts } from "../src/backdrop";
import { arquivoUrl, processar as recortarNoEstudio, saude, type Saude } from "./studio-client";
import { listarFotos, removerFoto, salvarFoto, type FotoLocal } from "./galeria-local";
import "./studio.css";

type Tema = "claro" | "escuro";
type Fundo = "branco" | "cor" | "transparente";
type Formato = "png" | "jpeg" | "webp";

const hexParaRgb = (h: string) => {
  const n = parseInt(h.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

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
    <svg className="rt-marca" viewBox="0 0 44 14" aria-label="SHARP" role="img">
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

/** Pincel: pinta por cima da foto, e o traço entra como máscara. Serve para a sombra (insistir numa
 *  sombra fraca) e para a remoção inteligente (marcar o que tirar); muda só a cor, o rótulo e a dica. */
function Pincel({ foto, w, h, aoAplicar, aoCancelar, cor = "rgba(90,90,255,.5)", rotuloAplicar = "Aplicar a sombra", dica = "Pinte por cima da sombra que fica no chão. O resto do fundo some." }: {
  foto: string; w: number; h: number;
  aoAplicar: (trilha: HTMLCanvasElement) => void;
  aoCancelar: () => void;
  cor?: string; rotuloAplicar?: string; dica?: string;
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
    ctx.strokeStyle = ctx.fillStyle = cor;
    ctx.lineWidth = grossura;
    ctx.lineCap = ctx.lineJoin = "round";
    if (de) { ctx.beginPath(); ctx.moveTo(de.x, de.y); ctx.lineTo(ate.x, ate.y); ctx.stroke(); }
    else { ctx.beginPath(); ctx.arc(ate.x, ate.y, grossura / 2, 0, Math.PI * 2); ctx.fill(); }
    setPintou(true);
  };

  return (
    <div className="rt-pincel">
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
          {rotuloAplicar}
        </button>
      </div>
      <p className="rt-dica">{dica}</p>
    </div>
  );
}

/** Controles de fundo e formato, reusados antes de processar e para reprocessar. */
function Opcoes({ fundo, setFundo, corHex, setCorHex, formato, setFormato }: {
  fundo: Fundo; setFundo: (f: Fundo) => void;
  corHex: string; setCorHex: (c: string) => void;
  formato: Formato; setFormato: (f: Formato) => void;
}) {
  const fundos: [Fundo, string][] = [["branco", "Branco"], ["cor", "Cor"], ["transparente", "Transparente"]];
  const formatos: Formato[] = ["png", "jpeg", "webp"];
  return (
    <div className="rt-opcoes">
      <div className="rt-campo">
        <span>Fundo</span>
        <div className="rt-seg">
          {fundos.map(([v, rotulo]) => (
            <button key={v} className={fundo === v ? "is-on" : ""} onClick={() => setFundo(v)}>
              {fundo === v ? <Check size={13} /> : null} {rotulo}
            </button>
          ))}
        </div>
      </div>

      {fundo === "cor" ? (
        <div className="rt-campo rt-campo--cor">
          <span><Palette size={14} /> Cor</span>
          <div className="rt-cor">
            <input type="color" value={corHex} onChange={(e) => setCorHex(e.target.value)} aria-label="Seletor de cor" />
            <input
              type="text"
              value={corHex}
              onChange={(e) => { const v = e.target.value; if (/^#[0-9a-fA-F]{0,6}$/.test(v)) setCorHex(v); }}
              onBlur={(e) => { if (!/^#[0-9a-fA-F]{6}$/.test(e.target.value)) setCorHex("#f2f2f2"); }}
              spellCheck={false}
              aria-label="Cor em hex"
            />
            <span className="rt-cor-amostra" style={{ background: corHex }} />
          </div>
        </div>
      ) : null}

      <div className="rt-campo">
        <span>Formato</span>
        <div className="rt-seg">
          {formatos.map((v) => (
            <button
              key={v}
              className={formato === v ? "is-on" : ""}
              disabled={fundo === "transparente" && v !== "png"}
              onClick={() => setFormato(v)}
            >
              {v === "jpeg" ? "JPG" : v.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      {fundo === "transparente" ? <p className="rt-nota">Transparente exporta sempre em PNG.</p> : null}
    </div>
  );
}

/** Um card de "Minhas fotos": mostra o antes e, no hover, troca para o depois. */
function CartaoLocal({ foto, aoAbrir, aoRemover }: { foto: FotoLocal; aoAbrir: () => void; aoRemover: () => void }) {
  const [a, setA] = useState("");
  const [d, setD] = useState("");
  useEffect(() => {
    const ua = URL.createObjectURL(foto.antes);
    const ud = URL.createObjectURL(foto.depois);
    setA(ua); setD(ud);
    return () => { URL.revokeObjectURL(ua); URL.revokeObjectURL(ud); };
  }, [foto]);
  return (
    <li className="rt-local">
      <button type="button" className="rt-local-card" onClick={aoAbrir} title="Abrir antes e depois">
        <div className={foto.fundo === "transparente" ? "rt-local-img rt-local-img--xadrez" : "rt-local-img"}>
          {a ? <img src={a} className="rt-local-antes" alt={`${foto.nome} antes`} /> : null}
          {d ? <img src={d} className="rt-local-depois" alt={`${foto.nome} depois`} /> : null}
        </div>
        <div className="rt-card-pe">
          <b>{foto.nome}</b>
          <span>{new Date(foto.ts).toLocaleDateString()}</span>
        </div>
      </button>
      <button type="button" className="rt-local-x" onClick={aoRemover} aria-label="Remover do histórico"><Trash2 size={13} /></button>
    </li>
  );
}

/** Modal com antes/depois arrastável e exportação de novo. */
function ModalFoto({ foto, aoFechar }: { foto: FotoLocal; aoFechar: () => void }) {
  const [a, setA] = useState("");
  const [d, setD] = useState("");
  useEffect(() => {
    const ua = URL.createObjectURL(foto.antes);
    const ud = URL.createObjectURL(foto.depois);
    setA(ua); setD(ud);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && aoFechar();
    window.addEventListener("keydown", esc);
    return () => { URL.revokeObjectURL(ua); URL.revokeObjectURL(ud); window.removeEventListener("keydown", esc); };
  }, [foto, aoFechar]);
  return (
    <div className="rt-modal" onClick={aoFechar}>
      <div className="rt-modal-caixa" onClick={(e) => e.stopPropagation()}>
        <header className="rt-modal-topo">
          <b>{foto.nome}</b>
          <div className="rt-bloco-acoes">
            {d ? <a className="rt-botao rt-botao--principal" href={d} download={foto.depois instanceof File ? foto.depois.name : `${foto.nome}.${foto.formato === "jpeg" ? "jpg" : foto.formato}`}><Download size={15} /> Exportar</a> : null}
            <button className="rt-botao" onClick={aoFechar} aria-label="Fechar"><X size={15} /></button>
          </div>
        </header>
        {a && d ? <Cortina antes={a} depois={d} xadrez={foto.fundo === "transparente"} /> : null}
        <footer className="rt-ficha">
          <div><span>Fundo</span><b>{foto.fundo === "branco" ? "Branco" : foto.fundo === "transparente" ? "Transparente" : foto.fundo}</b></div>
          <div><span>Formato</span><b>{foto.formato === "jpeg" ? "JPG" : foto.formato.toUpperCase()}</b></div>
          <div><span>Tamanho</span><b>{foto.w} × {foto.h}</b></div>
          <div><span>Montagem</span><b>{(foto.ms / 1000).toFixed(1)} s</b></div>
        </footer>
      </div>
    </div>
  );
}

/** Painel de status: qual modelo está em uso e se está instalado e rodando. */
function Status({ s, aberto, aoAlternar }: { s: Saude | null; aberto: boolean; aoAlternar: () => void }) {
  const ok = !!s?.ok;
  return (
    <div className="rt-status">
      <button type="button" className="rt-status-pino" onClick={aoAlternar} title="Modelos em uso">
        <Cpu size={16} />
        <i className={ok ? "rt-dot rt-dot--on" : "rt-dot rt-dot--off"} />
        Modelos
      </button>
      {aberto ? (
        <div className="rt-popover">
          <div className="rt-pop-linha">
            <b>Backend</b>
            <span className={ok ? "rt-tag rt-tag--on" : "rt-tag rt-tag--off"}>{ok ? "rodando" : "fora do ar"}</span>
          </div>
          <div className="rt-pop-linha">
            <b>Produto · BiRefNet</b>
            <span className="rt-pop-sub">{s?.modelo ?? "—"}</span>
            <span className={s?.modelo_pronto ? "rt-tag rt-tag--on" : "rt-tag rt-tag--off"}>
              {s?.modelo_pronto ? (s?.modelo_carregado ? "rodando" : "instalado") : "não instalado"}
            </span>
          </div>
          <div className="rt-pop-linha">
            <b>Sombra · analítica</b>
            <span className="rt-pop-sub">na própria foto</span>
            <span className="rt-tag rt-tag--on">ativa</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function StudioPage() {
  const escolher = useRef<HTMLInputElement>(null);
  const trilho = useRef<HTMLUListElement>(null);
  const original = useRef<File | null>(null);

  const [pendente, setPendente] = useState<{ file: File; url: string; titulo: string } | null>(null);
  const [antes, setAntes] = useState<{ url: string; titulo: string } | null>(null);
  const [depois, setDepois] = useState<{ url: string; nome: string; cobertura: number; ms: number; w: number; h: number } | null>(null);
  const [ferramenta, setFerramenta] = useState<null | "sombra" | "remocao">(null);
  const marcas = useRef<{ sombra?: HTMLCanvasElement; apagar?: HTMLCanvasElement }>({});

  const [fundo, setFundo] = useState<Fundo>("branco");
  const [corHex, setCorHex] = useState("#f2f2f2");
  const [formato, setFormato] = useState<Formato>("png");
  const fundoRef = useRef(fundo); fundoRef.current = fundo;
  const corRef = useRef(corHex); corRef.current = corHex;
  const formatoRef = useRef(formato); formatoRef.current = formato;

  const [local, setLocal] = useState<FotoLocal[]>([]);
  const [modal, setModal] = useState<FotoLocal | null>(null);
  const [busca, setBusca] = useState("");

  const [saudeInfo, setSaudeInfo] = useState<Saude | null>(null);
  const [verStatus, setVerStatus] = useState(false);
  const [qr, setQr] = useState<{ img: string; url: string } | null>(null);
  const [semServidor, setSemServidor] = useState(true);

  const [tema, setTema] = useState<Tema>("claro");
  const [etapa, setEtapa] = useState("");
  const [rodando, setRodando] = useState(false);
  const [arrastando, setArrastando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    const salvo = localStorage.getItem("rt-tema") as Tema | null;
    setTema(salvo ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "escuro" : "claro"));
  }, []);
  useEffect(() => { try { localStorage.setItem("rt-tema", tema); } catch { /* sem storage */ } }, [tema]);

  // Status dos modelos: pergunta ao backend e repete, para o painel refletir instalar/subir.
  useEffect(() => {
    let vivo = true;
    const puxar = async () => { const s = await saude(); if (vivo) setSaudeInfo(s); };
    void puxar();
    const t = setInterval(puxar, 5000);
    return () => { vivo = false; clearInterval(t); };
  }, []);

  const recarregarLocal = useCallback(async () => setLocal(await listarFotos()), []);
  useEffect(() => { void recarregarLocal(); }, [recarregarLocal]);

  // Câmera do celular: fica como recurso futuro, discreto. Só mostra o QR quando o servidor responde.
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/galeria/rede");
        const { urls } = (await r.json()) as { urls: string[] };
        if (urls?.length) {
          setSemServidor(false);
          setQr({ img: await QRCode.toDataURL(urls[0], { margin: 1, width: 240, color: { dark: "#101114", light: "#ffffff" } }), url: urls[0] });
        }
      } catch { /* sem servidor da câmera: a página segue sem o QR */ }
    })();
  }, []);

  const preparar = useCallback((file: File, titulo: string) => {
    original.current = file;
    marcas.current = {};
    const url = URL.createObjectURL(file);
    setPendente({ file, url, titulo });
    setAntes({ url, titulo });
    setDepois(null);
    setFerramenta(null);
    setErro(null);
  }, []);

  const rodar = useCallback(async (file: File, titulo: string) => {
    original.current = file;
    setDepois(null);
    setErro(null);
    setFerramenta(null);
    setRodando(true);
    setEtapa("O SHARP está achando o produto…");
    try {
      const trabalho = await recortarNoEstudio(await reduzir(file));
      const mascara = trabalho.arquivos.mascara;
      if (!mascara) throw new Error("O Estúdio terminou sem a máscara do produto.");
      const desenho = await carregarImagem(arquivoUrl(mascara.id));
      // A sombra sai do próprio pixel da foto (analítico, em src/backdrop.ts): nítida e na forma real.
      // A rede de sombra foi treinada sem o objeto no quadro, então num fundo de estúdio ela lê o
      // produto como sombra e borra — por isso não entra aqui.
      setEtapa("Montando o fundo…");
      const f = fundoRef.current;
      const alvoFundo: BackdropOpts["fundo"] = f === "transparente" ? "transparente" : f === "cor" ? hexParaRgb(corRef.current) : { r: 255, g: 255, b: 255 };
      const res = await smoothBackdrop(file, file.name, { sombra: marcas.current.sombra, apagar: marcas.current.apagar, produto: desenho, fundo: alvoFundo, formato: formatoRef.current });
      setDepois({ url: URL.createObjectURL(res.file), nome: res.file.name, cobertura: res.cobertura, ms: res.ms, w: res.w, h: res.h });
      const item: FotoLocal = {
        id: crypto.randomUUID(), nome: titulo, ts: Date.now(),
        antes: file, depois: res.file, w: res.w, h: res.h, ms: res.ms, cobertura: res.cobertura,
        fundo: f === "cor" ? corRef.current : f, formato: f === "transparente" ? "png" : formatoRef.current,
      };
      await salvarFoto(item).catch(() => { /* sem IndexedDB: segue sem histórico */ });
      void recarregarLocal();
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setRodando(false);
      setEtapa("");
    }
  }, [recarregarLocal]);

  const processar = () => { if (pendente) void rodar(pendente.file, pendente.titulo); };
  const aoEscolher = (file: File) => preparar(file, file.name.replace(/\.\w+$/, ""));
  const reiniciar = () => { setPendente(null); setAntes(null); setDepois(null); setFerramenta(null); setErro(null); marcas.current = {}; };

  useEffect(() => {
    const colar = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (file && !rodando) aoEscolher(file);
    };
    window.addEventListener("paste", colar);
    return () => window.removeEventListener("paste", colar);
  });

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
    return termo ? local.filter((f) => f.nome.toLowerCase().includes(termo)) : local;
  }, [local, busca]);

  const correr = (passo: number) => trilho.current?.scrollBy({ left: passo * 320, behavior: "smooth" });
  const tituloFundo = fundo === "branco" ? "Fundo branco" : fundo === "transparente" ? "Fundo transparente" : "Fundo colorido";

  return (
    <div
      className="rt"
      data-tema={tema}
      onDragOver={(e) => { e.preventDefault(); if (Array.from(e.dataTransfer.items).some((i) => i.kind === "file")) setArrastando(true); }}
      onDrop={(e) => {
        e.preventDefault();
        setArrastando(false);
        const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
        if (file && !rodando) aoEscolher(file);
      }}
    >
      <aside className="rt-rail">
        <Marca />
        <nav>
          <button className="rt-rail-item is-on" title="Estúdio" onClick={reiniciar}><House size={20} /></button>
          <button className="rt-rail-item" title="Pincel da sombra" disabled={!depois} onClick={() => setFerramenta((v) => v === "sombra" ? null : "sombra")}><Brush size={20} /></button>
          <button className="rt-rail-item" title="Minhas fotos" onClick={() => trilho.current?.scrollIntoView({ behavior: "smooth" })}><ImageIcon size={20} /></button>
          <button className="rt-rail-item" title="Câmera do celular (em breve)" disabled={!qr} onClick={() => qr && window.open(qr.url, "_blank")}><Smartphone size={20} /></button>
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
      </aside>

      <div className="rt-corpo">
        <header className="rt-topo">
          <label className="rt-busca">
            <Search size={17} />
            <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar nas minhas fotos" />
            {busca ? <button onClick={() => setBusca("")} aria-label="Limpar busca"><X size={14} /></button> : null}
          </label>
          <div className="rt-topo-dir">
            <Status s={saudeInfo} aberto={verStatus} aoAlternar={() => setVerStatus((v) => !v)} />
            <input ref={escolher} type="file" accept="image/*" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) aoEscolher(f); e.target.value = ""; }} />
            <button className="rt-botao rt-botao--principal" disabled={rodando} onClick={() => escolher.current?.click()}>
              {rodando ? "Trabalhando…" : "Escolher foto"}
            </button>
          </div>
        </header>

        <main className="rt-tela">
          <section className="rt-bloco">
            <header className="rt-bloco-topo">
              <h2>{depois ? tituloFundo : pendente ? "Ajuste e processe" : "SHARP"}</h2>
              <span>{antes ? antes.titulo : "Escolha uma foto para começar"}</span>
              {depois ? (
                <div className="rt-bloco-acoes">
                  <button className={ferramenta === "sombra" ? "rt-botao is-on" : "rt-botao"} onClick={() => setFerramenta((v) => v === "sombra" ? null : "sombra")}><Brush size={15} /> Sombra</button>
                  <button className={ferramenta === "remocao" ? "rt-botao is-on" : "rt-botao"} onClick={() => setFerramenta((v) => v === "remocao" ? null : "remocao")}><Eraser size={15} /> Remoção</button>
                  <button className="rt-botao" onClick={() => setDepois(null)}><SlidersHorizontal size={15} /> Ajustar</button>
                  <a className="rt-botao rt-botao--principal" href={depois.url} download={depois.nome}><Download size={15} /> Baixar</a>
                </div>
              ) : null}
            </header>

            <div className="rt-palco">
              {antes && ferramenta && depois ? (
                <Pincel
                  key={ferramenta}
                  foto={antes.url}
                  w={depois.w}
                  h={depois.h}
                  cor={ferramenta === "remocao" ? "rgba(255,70,70,.5)" : "rgba(90,90,255,.5)"}
                  rotuloAplicar={ferramenta === "remocao" ? "Remover o que pintei" : "Aplicar a sombra"}
                  dica={ferramenta === "remocao"
                    ? "Pinte por cima do que quer tirar — uma sombra errada, lixo do fundo. Some a região inteira dali; o produto nunca é tocado."
                    : "Pinte por cima da sombra que fica no chão. O resto do fundo some."}
                  aoCancelar={() => setFerramenta(null)}
                  aoAplicar={(trilha) => {
                    if (ferramenta === "remocao") marcas.current.apagar = trilha;
                    else marcas.current.sombra = trilha;
                    if (original.current) void rodar(original.current, antes.titulo);
                  }}
                />
              ) : antes && depois ? (
                <Cortina antes={antes.url} depois={depois.url} xadrez={fundo === "transparente"} />
              ) : antes && rodando ? (
                <div className="rt-cortina rt-cortina--so">
                  <img src={antes.url} alt="Antes" className="rt-cortina-base" />
                  <span className="rt-cortina-brilho" />
                  <span className="rt-etapa">{etapa || "Trabalhando…"}</span>
                </div>
              ) : pendente ? (
                <div className="rt-preparar">
                  <img src={pendente.url} alt="Prévia" className="rt-preparar-foto" />
                  <div className="rt-preparar-lado">
                    <Opcoes fundo={fundo} setFundo={setFundo} corHex={corHex} setCorHex={setCorHex} formato={formato} setFormato={setFormato} />
                    <button className="rt-botao rt-botao--principal rt-processar" onClick={processar}>Processar</button>
                  </div>
                </div>
              ) : (
                <div className="rt-zero">
                  <b>Nenhuma foto selecionada</b>
                  <p>Arraste uma foto para cá, cole com Ctrl+V ou clique em "Escolher foto".</p>
                </div>
              )}
            </div>

            {erro ? <p className="rt-erro">{erro}</p> : null}
          </section>

          <section className="rt-bloco">
            <header className="rt-bloco-topo">
              <h2>Minhas fotos</h2>
              <span>{local.length ? `${local.length} no navegador` : "nada ainda"}</span>
              <div className="rt-bloco-acoes">
                <button className="rt-redondo" onClick={() => correr(-1)} aria-label="Anteriores"><ChevronLeft /></button>
                <button className="rt-redondo" onClick={() => correr(1)} aria-label="Próximas"><ChevronRight /></button>
              </div>
            </header>

            {fotos.length ? (
              <ul className="rt-trilho" ref={trilho}>
                {fotos.map((f) => (
                  <CartaoLocal key={f.id} foto={f} aoAbrir={() => setModal(f)} aoRemover={() => { void removerFoto(f.id).then(recarregarLocal); }} />
                ))}
              </ul>
            ) : (
              <div className="rt-zero">
                <b>Suas fotos tratadas aparecem aqui</b>
                <p>Ficam salvas neste navegador. Passe o mouse para ver como ficou; clique para o antes e depois.</p>
              </div>
            )}
          </section>
        </main>
      </div>

      {modal ? <ModalFoto foto={modal} aoFechar={() => setModal(null)} /> : null}
      {arrastando ? <div className="rt-solte"><span>Solte a foto aqui</span></div> : null}
    </div>
  );
}

// Setas do trilho, inline para não puxar mais ícones só por isto.
const ChevronLeft = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18 9 12l6-6" /></svg>;
const ChevronRight = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>;
