// Cores personalizadas do SVG. SÓ cores: nada de fonte, tamanho, raio ou layout.
// Defesa em profundidade: o valor é validado na carga da configuração E de novo no renderizador, e só entra no SVG
// depois de validado e normalizado (#rrggbb em minúsculas). Isso impede injeção de CSS/XML pelo valor da cor.

export const CHAVES_COR = ["background", "card", "border", "text", "muted", "track", "accent", "tools"];
const CHAVES_SIMPLES = CHAVES_COR.filter((k) => k !== "tools");

// Padrões = as cores que o painel sempre usou (tema claro e escuro do GitHub). `accent` é a cor das barras de projeto.
export const PADRAO_CLARO = Object.freeze({ background: "#ffffff", card: "#f6f8fa", border: "#d0d7de", text: "#1f2328", muted: "#656d76", track: "#e6eaee", accent: "#d97757" });
export const PADRAO_ESCURO = Object.freeze({ background: "#0d1117", card: "#161b22", border: "#30363d", text: "#e6edf3", muted: "#8b949e", track: "#21262d", accent: "#d97757" });

// Somente #rgb ou #rrggbb. Sem flag "m": o "$" só casa no fim real do texto (um "\n" no final é recusado).
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Valida e normaliza uma cor para #rrggbb em minúsculas. Lança erro (sem repetir o valor recebido). */
export function normalizarHex(valor, rotulo = "cor") {
  if (typeof valor !== "string") throw new Error(`${rotulo}: a cor deve ser um texto no formato #rgb ou #rrggbb.`);
  if (valor.length > 7 || !HEX.test(valor)) throw new Error(`${rotulo}: cor inválida; use somente #rgb ou #rrggbb (hexadecimal; nomes, rgb(), hsl(), var(), url() e outros formatos não são aceitos).`);
  let h = valor.slice(1).toLowerCase();
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return `#${h}`;
}

const ehObjetoSimples = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

/** Texto vindo da config para uma mensagem de erro: limitado e sem caracteres de controle (ESC/OSC não chegam ao terminal). */
const paraMensagem = (s) => String(s).slice(0, 40).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");

/**
 * Valida um objeto de cores (`colors` ou `colorsDark`). Chaves desconhecidas e ids de ferramenta fora de `idsValidos` são recusados.
 * Devolve um objeto NOVO, normalizado, só com o que foi informado: { background?, ..., tools?: {id: "#rrggbb"} }.
 * @param {unknown} obj
 * @param {string[]} idsValidos ids do registro de adaptadores
 * @param {string} [nome] "colors" ou "colorsDark" (para as mensagens)
 */
export function validarCores(obj, idsValidos, nome = "colors") {
  if (!ehObjetoSimples(obj)) throw new Error(`${nome}: esperado um objeto, por exemplo {"accent": "#22c55e"}.`);
  const saida = {};
  for (const k of Object.keys(obj)) {
    if (!CHAVES_COR.includes(k)) throw new Error(`${nome}: chave desconhecida "${paraMensagem(k)}". Permitidas: ${CHAVES_COR.join(", ")}.`);
  }
  for (const k of CHAVES_SIMPLES) {
    if (Object.hasOwn(obj, k)) saida[k] = normalizarHex(obj[k], `${nome}.${k}`);
  }
  if (Object.hasOwn(obj, "tools")) {
    if (!ehObjetoSimples(obj.tools)) throw new Error(`${nome}.tools: esperado um objeto {"id-da-ferramenta": "#rrggbb"}.`);
    const ferramentas = Object.create(null);
    for (const id of Object.keys(obj.tools)) {
      if (!idsValidos.includes(id)) throw new Error(`${nome}.tools: ferramenta desconhecida "${paraMensagem(id)}". Ids válidos: ${idsValidos.join(", ")}.`);
      ferramentas[id] = normalizarHex(obj.tools[id], `${nome}.tools.${id}`);
    }
    saida.tools = ferramentas;
  }
  return saida;
}

const para = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const deRgb = (v) => `#${v.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`;

/** Mistura a com b (t = 0 devolve a, t = 1 devolve b). Entrada e saída em #rrggbb; a saída é sempre hexadecimal. */
export function misturar(a, b, t) {
  const x = para(a);
  const y = para(b);
  return deRgb(x.map((c, i) => c + (y[i] - c) * t));
}

/** Escala de calor do model-3 (níveis 0-4), derivada de `accent` e `background`. Sem chave própria na configuração. */
export function escalaCalor(background, accent) {
  return [0.1, 0.32, 0.55, 0.78, 1].map((t) => misturar(background, accent, t));
}

/** Completa um conjunto parcial (já validado) com os padrões. `tools` fica de fora: é tratado à parte, por id. */
export const comPadrao = (padrao, parcial) => ({ ...padrao, ...Object.fromEntries(CHAVES_SIMPLES.filter((k) => parcial && parcial[k]).map((k) => [k, parcial[k]])) });
