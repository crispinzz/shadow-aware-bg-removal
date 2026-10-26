// Troca o fundo infinito por branco limpo, sem ruga. É o único tratamento que o Realçador faz.
//
// Regra: só o fundo muda. O produto sai pixel por pixel igual ao original — sem correção de cor,
// saturação, contraste ou nitidez; a iluminação é resolvida no set, com softbox.
//
// A sombra fica, e é a mesma conta que o Photoshop faz: a sombra nunca é recortada, ela é separada
// por luminosidade e remontada em Multiply sobre o branco. Aqui cada pixel de fundo é dividido pela
// luz que o fundo teria ali sem sombra: o tecido liso dá 1 e vira branco puro, a sombra dá menos de
// 1 e volta na mesma forma e na mesma suavidade. A ruga também dá menos de 1, mas pouco, e some no
// corte de RUGA. O pincel é só para insistir: no que você pintar, a sombra volta sem esse corte.
//
// Onde está o produto vem do Estúdio (BiRefNet, em realcar/, na sua máquina). Achar isso na conta,
// crescendo uma região clara a partir da borda, foi tentado e não serve: barra cromada tem a mesma
// luz do tecido branco, a região entrava no produto e ele saia fantasma. Sem a máscara do Estúdio
// a função ainda roda nesse modo, que fica como reça de emergência e avisa pela cobertura.

const LADO_MAX = 3000;       // acima disto a foto é reduzida: memória e tempo, sem ganho visível
const DEGRAU = 7;            // diferença de luz, em 0..255, que ainda conta como "mesmo fundo"
const PISO = 52;             // quanto o fundo pode escurecer em relação à borda antes de virar sombra
const CONTORNO = 14;         // contraste a 2 px que já é silhueta de produto, não dobra de tecido
const CERCA = 1 / 300;       // quanto a silhueta empurra o fundo para longe, em fração do lado maior
const RAIO_LUZ = 1 / 22;     // raio da leitura da luz do fundo, em fração do lado maior
const PENA = 1 / 400;        // borda da máscara borrada, para o fundo encontrar o produto sem degrau
const QUALIDADE = 0.95;
const SOMBRA_MIN = 0.62;     // a sombra não escurece além disto: abaixo seria buraco, não sombra
const RUGA = 0.18;           // ate 18% mais escuro que o fundo liso e dobra de tecido, e vira branco
const PENA_MASCARA = 1 / 500;  // pena da silhueta: a máscara vem de uma foto menor e sobe em degrau
const PENA_PINCEL = 1 / 90;    // borda macia do traço: sombra não tem contorno de caneta
const SUAVE_SOMBRA = 1 / 220; // raio que tira o grão da sombra sem mexer na forma dela
const ALFA_PRODUTO = 0.22;   // acima disto a mascara ja conta como produto, e nada ali e tocado
const SOMBRA_ALCANCE = 0.26; // até onde a sombra ainda vale, em fração do lado maior, caindo macio
const VIZINHA = 0.04;        // o quanto uma peça pode estar longe da caixa do produto e ainda ser dele

export interface BackdropOpts {
  sombra?: CanvasImageSource;   // traço do pincel da sombra
  produto?: CanvasImageSource;  // máscara do Estúdio
  apagar?: CanvasImageSource;   // (legado) traço da borracha
  /** Fundo da saída: "transparente" (PNG com alfa) ou uma cor RGB (padrão branco). */
  fundo?: "transparente" | { r: number; g: number; b: number };
  /** Formato do arquivo quando o fundo é sólido. Transparente é sempre PNG. */
  formato?: "png" | "jpeg" | "webp";
}

export interface BackdropResult {
  file: File;
  /** Fração do quadro que foi reconhecida como fundo. Abaixo de 0,1 provavelmente não era estúdio. */
  cobertura: number;
  /** Lado da imagem tratada, para o pincel desenhar na mesma escala. */
  w: number;
  h: number;
  ms: number;
}

/** Média local com pesos: só os pixels de dentro da máscara entram na conta (box blur, duas passadas). */
function blurMascarado(valor: Float32Array, peso: Float32Array, w: number, h: number, r: number) {
  const passe = (ent: Float32Array, pes: Float32Array, largura: number, altura: number) => {
    const sv = new Float32Array(largura + 1);
    const sp = new Float32Array(largura + 1);
    for (let y = 0; y < altura; y++) {
      const base = y * largura;
      for (let x = 0; x < largura; x++) { sv[x + 1] = sv[x] + ent[base + x]; sp[x + 1] = sp[x] + pes[base + x]; }
      for (let x = 0; x < largura; x++) {
        const a = Math.max(0, x - r), b = Math.min(largura, x + r + 1);
        ent[base + x] = sv[b] - sv[a];
        pes[base + x] = sp[b] - sp[a];
      }
    }
  };
  const gira = (ent: Float32Array, largura: number, altura: number) => {
    const saida = new Float32Array(ent.length);
    for (let y = 0; y < altura; y++) for (let x = 0; x < largura; x++) saida[x * altura + y] = ent[y * largura + x];
    return saida;
  };
  passe(valor, peso, w, h);
  let v = gira(valor, w, h), p = gira(peso, w, h);
  passe(v, p, h, w);
  v = gira(v, h, w); p = gira(p, h, w);
  for (let i = 0; i < valor.length; i++) valor[i] = p[i] > 0.001 ? v[i] / p[i] : valor[i];
}

/**
 * Onde a região não pode entrar: a silhueta do produto e uma faixa em volta dela.
 *
 * Degrau por degrau não basta. Numa foto um pouco suave, o contorno cromado da escada sobe em
 * rampa de poucos pixels, cada passo cabe na tolerância e a região escorre para dentro do produto —
 * que entao e alisado junto e sai fantasma. Medir o contraste a 2 px de distancia separa os dois
 * casos: a dobra do tecido fica abaixo de CONTORNO, a silhueta passa muito disso.
 */
function cercaDoContorno(luz: Float32Array, w: number, h: number) {
  const n = w * h;
  const bruta = new Uint8Array(n);
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const dx = Math.abs(luz[i + 2] - luz[i - 2]);
      const dy = Math.abs(luz[i + 2 * w] - luz[i - 2 * w]);
      if (Math.max(dx, dy) > CONTORNO) bruta[i] = 1;
    }
  }
  // Engorda a cerca: o contorno tem rampa dos dois lados, e sem a folga a região entraria por ela.
  const r = Math.max(2, Math.round(Math.max(w, h) * CERCA));
  const soma = new Float32Array(n);
  const peso = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) soma[i] = bruta[i];
  blurMascarado(soma, peso, w, h, r);
  const cerca = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (soma[i] > 0.0005) cerca[i] = 1;
  return cerca;
}

/**
 * Fecha o furo que a rede deixa no meio do produto.
 *
 * Em parte escura do produto — o lado sem luz de uma maçã, a borracha preta de um pé — a rede
 * responde alfa baixo, e aquele pedaço virava branco: um buraco no meio da foto. Um furo desses
 * é uma ilha de fundo que não encosta na borda do quadro E que não tem a luz do fundo. O vazado
 * de verdade (entre as barras de uma escada) mostra o tecido, então tem a luz do fundo e fica.
 */
function fecharFuros(marca: Uint8Array, luz: Float32Array, w: number, h: number, aoFechar: (i: number) => void) {
  const n = w * h;
  // Luz do fundo: mediana da moldura do quadro, igual à da busca por borda.
  const borda: number[] = [];
  for (let x = 0; x < w; x += 4) { borda.push(luz[x], luz[(h - 1) * w + x]); }
  for (let y = 0; y < h; y += 4) { borda.push(luz[y * w], luz[y * w + w - 1]); }
  borda.sort((a, b) => a - b);
  const referencia = borda[borda.length >> 1] || 255;

  const visto = new Uint8Array(n);
  const pilha = new Int32Array(n);
  for (let inicio = 0; inicio < n; inicio++) {
    if (!marca[inicio] || visto[inicio]) continue;
    let topo = 0, lido = 0;
    pilha[topo++] = inicio;
    visto[inicio] = 1;
    let naBorda = false;
    let soma = 0;
    while (lido < topo) {
      const i = pilha[lido++];
      const x = i % w, y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) naBorda = true;
      soma += luz[i];
      for (const j of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1]) {
        if (j >= 0 && j < n && !visto[j] && marca[j]) { visto[j] = 1; pilha[topo++] = j; }
      }
    }
    if (naBorda) continue;                       // é o fundo do quadro, não um furo
    if (soma / topo > referencia * 0.78) continue; // tem a luz do fundo: vazado de verdade
    for (let k = 0; k < topo; k++) { marca[pilha[k]] = 0; aoFechar(pilha[k]); }
  }
}

/**
 * Mantém só a maior peça da máscara e o que estiver perto dela; o resto vira fundo.
 *
 * A rede do Estúdio às vezes guarda um pedaço de móvel na quina do quadro, porque é objeto de
 * verdade. Para a foto de catálogo não é: a foto é do produto do meio.
 */
function soMaiorPeca(marca: Uint8Array, w: number, h: number, aoLimpar: (i: number) => void) {
  const n = w * h;
  const visto = new Uint8Array(n);
  const pilha = new Int32Array(n);
  const pecas: { pixels: number[]; x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let inicio = 0; inicio < n; inicio++) {
    if (marca[inicio] || visto[inicio]) continue;
    let topo = 0, lido = 0;
    pilha[topo++] = inicio;
    visto[inicio] = 1;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (lido < topo) {
      const i = pilha[lido++];
      const x = i % w, y = (i / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const j of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1]) {
        if (j >= 0 && j < n && !visto[j] && !marca[j]) { visto[j] = 1; pilha[topo++] = j; }
      }
    }
    pecas.push({ pixels: Array.prototype.slice.call(pilha.subarray(0, topo)), x0, y0, x1, y1 });
  }
  if (pecas.length < 2) return;
  const produto = pecas.reduce((a, b) => (a.pixels.length >= b.pixels.length ? a : b));
  const folga = Math.round(Math.max(w, h) * VIZINHA);
  for (const peca of pecas) {
    if (peca === produto) continue;
    const perto =
      peca.x0 <= produto.x1 + folga && peca.x1 >= produto.x0 - folga &&
      peca.y0 <= produto.y1 + folga && peca.y1 >= produto.y0 - folga;
    if (!perto) for (const i of peca.pixels) { marca[i] = 1; aoLimpar(i); }
  }
}

/**
 * Fundo = o que se alcança a partir da borda subindo degrau por degrau.
 *
 * A ruga é suave, então a região atravessa a dobra inteira; a silhueta do produto é um degrau
 * abrupto, e a região para nela. O piso de brilho segura a sombra de contato: ela é escura, fica de
 * fora da máscara e por isso continua na foto exatamente como foi fotografada.
 */
function mascaraDoFundo(luz: Float32Array, w: number, h: number) {
  const n = w * h;
  const marca = new Uint8Array(n);
  const cerca = cercaDoContorno(luz, w, h);
  const fila = new Int32Array(n);
  let head = 0, tail = 0;

  // Referência: a mediana da moldura de 1 px. É o tecido iluminado, em qualquer exposição.
  const borda: number[] = [];
  for (let x = 0; x < w; x += 2) { borda.push(luz[x], luz[(h - 1) * w + x]); }
  for (let y = 0; y < h; y += 2) { borda.push(luz[y * w], luz[y * w + w - 1]); }
  borda.sort((a, b) => a - b);
  const referencia = borda[borda.length >> 1];
  const minimo = referencia - PISO;

  const entrar = (i: number, de: number) => {
    if (marca[i] || cerca[i] || luz[i] < minimo) return;
    if (Math.abs(luz[i] - de) > DEGRAU) return;
    marca[i] = 1;
    fila[tail++] = i;
  };
  for (let x = 0; x < w; x++) { entrar(x, luz[x]); entrar((h - 1) * w + x, luz[(h - 1) * w + x]); }
  for (let y = 0; y < h; y++) { entrar(y * w, luz[y * w]); entrar(y * w + w - 1, luz[y * w + w - 1]); }
  while (head < tail) {
    const i = fila[head++];
    const x = i % w;
    const aqui = luz[i];
    if (i >= w) entrar(i - w, aqui);
    if (i < n - w) entrar(i + w, aqui);
    if (x > 0) entrar(i - 1, aqui);
    if (x < w - 1) entrar(i + 1, aqui);
  }

  // O que sobrou de fora não é tudo produto: a cerca deixa ilhas soltas no meio do tecido e um anel
  // em volta da silhueta. Sobre fundo branco cada ilha dessas vira uma mancha de tecido, então o
  // fundo final é o complemento do produto: fora dele, só as manchas grandes continuam de fora.
  // Só o produto fica de fora do fundo: a maior mancha e tudo que estiver perto dela.
  const minimoRuido = Math.max(8, Math.round(n * 0.000004));
  const visto = new Uint8Array(n);
  const pilha = new Int32Array(n);
  const manchas: { pixels: number[]; x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let inicio = 0; inicio < n; inicio++) {
    if (marca[inicio] || visto[inicio]) continue;
    let topo = 0, lido = 0;
    pilha[topo++] = inicio;
    visto[inicio] = 1;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (lido < topo) {
      const i = pilha[lido++];
      const x = i % w, y = (i / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const j of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1]) {
        if (j >= 0 && j < n && !visto[j] && !marca[j]) { visto[j] = 1; pilha[topo++] = j; }
      }
    }
    manchas.push({ pixels: Array.prototype.slice.call(pilha.subarray(0, topo)), x0, y0, x1, y1 });
  }
  if (!manchas.length) return marca;

  // O produto é a maior mancha, e perto dele tudo é dele: cabo, pé, acessório apoiado ao lado,
  // pedacinho que o contorno separou. Só o que está longe da caixa dele — tripé, caixa esquecida,
  // quina de móvel no canto do quadro — entra no branco. Decidir por distância, e não por tamanho,
  // é o que garante que nenhum pedaço do produto seja apagado por ser pequeno.
  const produto = manchas.reduce((a, b) => (a.pixels.length >= b.pixels.length ? a : b));
  const folga = Math.round(Math.max(w, h) * VIZINHA);
  for (const mancha of manchas) {
    if (mancha === produto) continue;
    const perto =
      mancha.x0 <= produto.x1 + folga && mancha.x1 >= produto.x0 - folga &&
      mancha.y0 <= produto.y1 + folga && mancha.y1 >= produto.y0 - folga;
    // Perto do produto, ainda sobra pontinho de tecido que a cerca isolou. Peça de verdade é mais
    // escura ou mais clara que o tecido; o que tem a luz do próprio fundo é fundo, e vai ao branco.
    let soma = 0;
    for (const i of mancha.pixels) soma += luz[i];
    // Só vale para mancha pequena: peça grande e branca (um assento solto) continua sendo produto.
    const corDeFundo = mancha.pixels.length < n * 0.0008
      && soma / mancha.pixels.length > referencia * (1 - RUGA);
    if (!perto || mancha.pixels.length < minimoRuido || corDeFundo) for (const i of mancha.pixels) marca[i] = 1;
  }
  return marca;
}

/**
 * @param sombra   Opcional: o traço do pincel. Onde ele tem alfa, a sombra volta sem o corte de ruga.
 * @param produto  A máscara do Estúdio: branco onde está o produto. Com ela, fundo é tudo o que está
 *                 fora — e nenhum pixel do produto é tocado. Sem ela, cai na busca pela borda.
 */
export async function smoothBackdrop(
  input: Blob,
  name: string,
  opts: BackdropOpts = {},
): Promise<BackdropResult> {
  const { sombra, produto, apagar } = opts;
  const transparente = opts.fundo === "transparente";
  const cor = opts.fundo && typeof opts.fundo === "object" ? opts.fundo : { r: 255, g: 255, b: 255 };
  const formato: "png" | "jpeg" | "webp" = transparente ? "png" : (opts.formato ?? "jpeg");
  const comeco = performance.now();
  const bitmap = await createImageBitmap(input);
  const escala = Math.min(1, LADO_MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * escala);
  const h = Math.round(bitmap.height * escala);

  const tela = document.createElement("canvas");
  tela.width = w; tela.height = h;
  const ctx = tela.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const imagem = ctx.getImageData(0, 0, w, h);
  const px = imagem.data;
  const n = w * h;

  const luz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    luz[i] = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
  }

  // Fundo = fora do produto. A máscara já vem com borda macia, então ela também serve de pena.
  const marca = new Uint8Array(n);
  let suave: Float32Array | null = null;
  if (produto) {
    const aux = document.createElement("canvas");
    aux.width = w; aux.height = h;
    const actx = aux.getContext("2d", { willReadFrequently: true })!;
    actx.drawImage(produto, 0, 0, w, h);
    const dados = actx.getImageData(0, 0, w, h).data;
    suave = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      // A máscara pode chegar em cinza (produto no branco) ou com alfa; vale o que for mais forte.
      const alfa = Math.max(dados[p], dados[p + 3] === 255 ? 0 : dados[p + 3]) / 255;
      // Limiar baixo de proposito: na duvida o pixel e produto. Em meio-tom a rede poe a perna
      // clara e a quina cromada, e cortar em 0,5 apagava pedaco de produto. O vazado de verdade
      // vem com alfa perto de zero e continua virando branco.
      suave[i] = alfa > ALFA_PRODUTO ? 0 : 1 - alfa / ALFA_PRODUTO;
      marca[i] = alfa <= ALFA_PRODUTO ? 1 : 0;
    }
    const macio = suave;
    fecharFuros(marca, luz, w, h, (i) => { macio[i] = 0; });
    // A máscara foi calculada numa foto menor e ampliada até aqui: a silhueta chega em degrau de
    // vários pixels. Sem esta pena, o contorno do produto sai serrilhado contra o branco.
    const degrau = Math.max(1, Math.round(Math.max(w, h) * PENA_MASCARA));
    const umM = new Float32Array(n).fill(1);
    blurMascarado(macio, umM, w, h, degrau);
    soMaiorPeca(marca, w, h, (i) => { macio[i] = 1; });
  } else {
    mascaraDoFundo(luz, w, h).forEach((v, i) => { marca[i] = v; });
  }
  let dentro = 0;
  for (let i = 0; i < n; i++) dentro += marca[i];

  // Borracha: o que você pintou aqui vira fundo, doa a mascara o que disser. É assim que sai o
  // objeto que a rede insiste em chamar de produto — tripé, caixa, pedaço de parede.
  if (apagar) {
    const aux = document.createElement("canvas");
    aux.width = w; aux.height = h;
    const actx = aux.getContext("2d", { willReadFrequently: true })!;
    actx.drawImage(apagar, 0, 0, w, h);
    const dados = actx.getImageData(0, 0, w, h).data;
    for (let i = 0; i < n; i++) {
      if (dados[i * 4 + 3] <= 6) continue;
      marca[i] = 1;
      if (suave) suave[i] = 1;
    }
  }

  // O traço do pincel entra como peso 0..1: a borda macia da ponta vira borda macia da sombra.
  let pincel: Float32Array | null = null;
  if (sombra) {
    const aux = document.createElement("canvas");
    aux.width = w; aux.height = h;
    const actx = aux.getContext("2d", { willReadFrequently: true })!;
    actx.drawImage(sombra, 0, 0, w, h);
    const dados = actx.getImageData(0, 0, w, h).data;
    pincel = new Float32Array(n);
    let algum = 0;
    for (let i = 0; i < n; i++) { const a = dados[i * 4 + 3] / 255; pincel[i] = a; algum += a > 0.02 ? 1 : 0; }
    if (!algum) pincel = null;
    // Borda macia no traço: sombra não tem contorno de caneta. O raio acompanha o tamanho da foto,
    // então o mesmo traço vale igual em 1 MP e em 12 MP.
    if (pincel) {
      const umP = new Float32Array(n).fill(1);
      blurMascarado(pincel, umP, w, h, Math.max(2, Math.round(Math.max(w, h) * PENA_PINCEL)));
    }
    // Traço pequeno demais é toque sem querer, e viraria uma mancha escura solta.
    if (pincel) {
      let area = 0;
      for (let i = 0; i < n; i++) if (pincel[i] > 0.08) area++;
      if (area < n * 0.002) pincel = null;
    }
  }

  // Quanta luz o fundo teria em cada ponto se a sombra não estivesse lá: média larga tomada só nos
  // pixels de fundo. É contra ela que a sombra é medida — por isso a sombra não muda de forma.
  const raio = Math.max(8, Math.round(Math.max(w, h) * RAIO_LUZ));
  const base = new Float32Array(n);
  const peso = new Float32Array(n);
  // Só o fundo CLARO entra na conta da luz: sombra e canto escuro puxariam a referência para baixo
  // e a sombra sumiria. Onde a média local não tem material suficiente, vale a mediana do quadro.
  const claros: number[] = [];
  for (let i = 0; i < n; i += 7) if (marca[i]) claros.push(luz[i]);
  claros.sort((a, b) => a - b);
  const luzDoFundo = claros.length ? claros[Math.round((claros.length - 1) * 0.75)] : 255;
  for (let i = 0; i < n; i++) {
    const claro = marca[i] && luz[i] > luzDoFundo * 0.82 ? 1 : 0;
    base[i] = luz[i] * claro;
    peso[i] = claro;
  }
  blurMascarado(base, peso, w, h, raio);
  for (let i = 0; i < n; i++) if (!(base[i] > 1)) base[i] = luzDoFundo;

  // Onde o branco vale: o fundo achado, mais o traço do pincel (a sombra costuma ser escura demais
  // para a região alcançar sozinha). A pena tira o degrau na divisa com o produto.
  const pena = Math.max(1, Math.round(Math.max(w, h) * PENA));
  const forca = new Float32Array(n);
  const um = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) forca[i] = Math.max(suave ? suave[i] : marca[i], pincel ? (pincel[i] > 0.02 ? 1 : 0) : 0);
  if (!suave) blurMascarado(forca, um, w, h, pena); // a máscara do Estúdio já vem com a borda macia

  // Quanto a sombra ainda vale, conforme se afasta do produto.
  //
  // Antes isto era uma caixa: a sombra sobrevivia dentro do retângulo do produto com uma folga, e
  // morria de uma vez na borda dele. Numa sombra longa — sol baixo, luz rasante — o resultado era
  // a sombra cortada com uma régua, que é pior do que não ter sombra. Agora o produto é borrado
  // num campo que cai com a distância: perto vale inteira, longe some sozinha, sem nenhuma reta.
  const vizinhanca = new Float32Array(n);
  const umV = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) vizinhanca[i] = marca[i] ? 0 : 1;
  blurMascarado(vizinhanca, umV, w, h, Math.max(4, Math.round(Math.max(w, h) * SOMBRA_ALCANCE)));
  // A curva: o campo sai forte colado no produto e cai rápido. A raiz abre a meia-luz, para a
  // sombra não terminar num degrau onde o campo cruza o limiar.
  for (let i = 0; i < n; i++) vizinhanca[i] = Math.min(1, Math.sqrt(vizinhanca[i] * 2.2));

  // A sombra é decidida num mapa próprio e depois suavizada. Pixel a pixel ela sai granulada e com
  // bloco quadrado, porque a média larga muda de vizinhança de um pixel para o outro; a sombra de
  // verdade não tem grão nenhum, e o que interessa dela é a forma.
  const fatores = new Float32Array(n);
  const umTodo = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    const medido = Math.max(SOMBRA_MIN, Math.min(1, luz[i] / base[i]));
    const pintado = pincel ? pincel[i] : 0;
    let f = medido > 1 - RUGA ? 1 : 1 - (1 - medido) * vizinhanca[i];
    if (pintado > 0.02) f = Math.min(f, 1 - pintado * (1 - medido));
    fatores[i] = f;
  }
  blurMascarado(fatores, umTodo, w, h, Math.max(2, Math.round(Math.max(w, h) * SUAVE_SOMBRA)));

  for (let i = 0; i < n; i++) {
    const t = forca[i];
    if (t <= 0.002) continue; // produto: byte original, intocado
    const p = i * 4;
    if (transparente) {
      // Produto sobre a sombra sobre o vazio: a sombra vira preto semi-transparente (o xadrez
      // aparece através dela), o fundo limpo some. Divide pela cobertura para a borda macia do
      // produto manter a cor em vez de escurecer num halo.
      const s = 1 - Math.max(SOMBRA_MIN, Math.min(1, fatores[i])); // 0 limpo .. força da sombra
      const cobre = (1 - t) + t * s;
      px[p] = cobre > 0 ? Math.round(px[p] * (1 - t) / cobre) : 0;
      px[p + 1] = cobre > 0 ? Math.round(px[p + 1] * (1 - t) / cobre) : 0;
      px[p + 2] = cobre > 0 ? Math.round(px[p + 2] * (1 - t) / cobre) : 0;
      px[p + 3] = Math.round(255 * cobre);
      continue;
    }
    // Multiply sobre a cor escolhida: fator 1 é a cor pura, abaixo de 1 é sombra. A dobra de tecido
    // fica dentro de RUGA e é arredondada para a cor; a sombra passa disso e sobrevive inteira.
    const f = Math.max(SOMBRA_MIN, Math.min(1, fatores[i]));
    px[p] = Math.round(px[p] * (1 - t) + cor.r * f * t);
    px[p + 1] = Math.round(px[p + 1] * (1 - t) + cor.g * f * t);
    px[p + 2] = Math.round(px[p + 2] * (1 - t) + cor.b * f * t);
  }

  ctx.putImageData(imagem, 0, 0);
  const tipo = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[formato];
  const blob = await new Promise<Blob | null>((ok) => tela.toBlob(ok, tipo, QUALIDADE));
  if (!blob) throw new Error("Não consegui gerar a foto tratada.");
  const ext = formato === "jpeg" ? "jpg" : formato;
  const sufixo = transparente ? "-fundo-transparente" : "-fundo";
  return {
    file: new File([blob], name.replace(/\.\w+$/, "") + `${sufixo}.${ext}`, { type: tipo }),
    cobertura: dentro / n,
    w,
    h,
    ms: Math.round(performance.now() - comeco),
  };
}
