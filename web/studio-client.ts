// Client for the segmentation server (server/), the local Python backend that finds the product.
// Vite proxies /studio to 127.0.0.1:8000 (see vite.config.ts).
// As fotos não saem da máquina — o backend escuta só em 127.0.0.1 e não fala com nada de fora.

const RAIZ = "/studio/api";
const INTERVALO = 700; // de quanto em quanto tempo pergunta se o trabalho andou

export type EstadoTrabalho =
  | "aguardando" | "preparando" | "processando"
  | "concluido" | "concluido_com_aviso" | "falhou" | "cancelado";

export type Trabalho = {
  id: string;
  nome: string;
  estado: EstadoTrabalho;
  erro: string | null;
  avisos: string[];
  metricas: Record<string, unknown>;
  arquivos: Record<string, { id: string; nome: string }>;
};

export type Saude = {
  ok: boolean;
  segmentador: string;
  gemini_configurado: boolean;
  modelo: string;
  modelo_de_recuperacao: string;
  modelo_pronto: boolean;
  modelo_carregado: boolean;
  licenca_dos_pesos: string;
  sombra_rede: string;
  sombra_rede_pronta: boolean;
  sombra_rede_ativa: boolean;
  opencv: string;
  trabalhadores: number;
};

/** Texto de cada aviso do backend. O que o backend manda é um código; quem traduz é a tela. */
export const AVISO_ESTUDIO: Record<string, string> = {
  mascara_grande_demais: "O recorte pegou fundo demais",
  mascara_pequena_demais: "O recorte achou quase nada",
  produto_fragmentado: "O produto saiu em pedaços",
  fragmentos_soltos: "Sobraram pedaços soltos",
  borda_indecisa: "A borda ficou mole",
  recuperado_com_modelo_alternativo: "Precisei do modelo grande para recuperar",
  gemini_falhou_usei_o_modelo_local: "O Gemini não respondeu; recortei aqui mesmo",
};

export const arquivoUrl = (id: string) => `${RAIZ}/files/${id}`;

export async function saude(): Promise<Saude | null> {
  try {
    const r = await fetch(`${RAIZ}/health`);
    return r.ok ? ((await r.json()) as Saude) : null;
  } catch {
    return null; // backend fora do ar; a tela mostra como ligar
  }
}

/** Manda a foto, acompanha o trabalho e devolve quando terminar. Lança com a mensagem do backend. */
export async function processar(
  arquivo: File,
  aoAndar?: (t: Trabalho) => void,
  sinal?: AbortSignal,
): Promise<Trabalho> {
  const corpo = new FormData();
  corpo.append("arquivo", arquivo, arquivo.name);

  const envio = await fetch(`${RAIZ}/process`, { method: "POST", body: corpo, signal: sinal });
  if (!envio.ok) throw new Error(await mensagemDeErro(envio));

  let trabalho = (await envio.json()) as Trabalho;
  aoAndar?.(trabalho);

  while (!terminou(trabalho.estado)) {
    await espera(INTERVALO, sinal);
    const r = await fetch(`${RAIZ}/jobs/${trabalho.id}`, { signal: sinal });
    if (!r.ok) throw new Error(await mensagemDeErro(r));
    trabalho = (await r.json()) as Trabalho;
    aoAndar?.(trabalho);
  }

  if (trabalho.estado === "falhou") throw new Error(trabalho.erro || "O tratamento falhou.");
  if (trabalho.estado === "cancelado") throw new Error("Cancelado.");
  return trabalho;
}

export async function cancelar(id: string): Promise<void> {
  await fetch(`${RAIZ}/cancel/${id}`, { method: "POST" }).catch(() => {});
}

const terminou = (e: EstadoTrabalho) =>
  e === "concluido" || e === "concluido_com_aviso" || e === "falhou" || e === "cancelado";

async function mensagemDeErro(r: Response): Promise<string> {
  try {
    const corpo = (await r.json()) as { detail?: string };
    if (corpo.detail) return corpo.detail;
  } catch { /* resposta sem JSON: cai no texto genérico */ }
  return r.status === 502 || r.status === 504
    ? "O Estúdio não está no ar. Run: python -m uvicorn app.main:app --app-dir server --port 8000."
    : `O Estúdio respondeu ${r.status}.`;
}

function espera(ms: number, sinal?: AbortSignal): Promise<void> {
  return new Promise((ok, falha) => {
    if (sinal?.aborted) return falha(new DOMException("Cancelado", "AbortError"));
    const t = setTimeout(ok, ms);
    sinal?.addEventListener("abort", () => { clearTimeout(t); falha(new DOMException("Cancelado", "AbortError")); }, { once: true });
  });
}
