// "Minhas fotos": as fotos tratadas ficam no navegador (IndexedDB), não no servidor. Guardamos os
// blobs do antes e do depois, então a página reabre com o histórico e o antes/depois sem rede.

export type FotoLocal = {
  id: string;
  nome: string;
  ts: number;
  antes: Blob;
  depois: Blob;
  w: number;
  h: number;
  ms: number;
  cobertura: number;
  fundo: string;   // "branco" | "transparente" | "#rrggbb"
  formato: string; // "png" | "jpeg" | "webp"
};

const BANCO = "shadow-studio";
const LOJA = "fotos";

function abrir(): Promise<IDBDatabase> {
  return new Promise((ok, falha) => {
    const req = indexedDB.open(BANCO, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(LOJA, { keyPath: "id" });
    req.onsuccess = () => ok(req.result);
    req.onerror = () => falha(req.error);
  });
}

async function comLoja<T>(modo: IDBTransactionMode, fn: (loja: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await abrir();
  return new Promise<T>((ok, falha) => {
    const req = fn(db.transaction(LOJA, modo).objectStore(LOJA));
    req.onsuccess = () => ok(req.result as T);
    req.onerror = () => falha(req.error);
  });
}

export const salvarFoto = (f: FotoLocal) => comLoja<IDBValidKey>("readwrite", (l) => l.put(f));
export const removerFoto = (id: string) => comLoja<undefined>("readwrite", (l) => l.delete(id));

export async function listarFotos(): Promise<FotoLocal[]> {
  try {
    const todas = await comLoja<FotoLocal[]>("readonly", (l) => l.getAll());
    return todas.sort((a, b) => b.ts - a.ts); // mais recentes primeiro
  } catch {
    return []; // sem IndexedDB (janela privada, bloqueado): a página segue sem histórico
  }
}
