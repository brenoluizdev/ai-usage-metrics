/**
 * Privacidade: reduz um caminho a só o nome da pasta do projeto e aplica a allowlist/alias.
 * Nada aqui lê conteúdo de conversa.
 */
import { homedir, userInfo } from "node:os";
import { basename } from "node:path";

const ALIAS_VALIDO = /^[\p{L}\p{N} ._+-]{1,60}$/u;
// eslint-disable-next-line no-control-regex
const CONTROLE = /[\u0000-\u001F\u007F-\u009F]/;

/** Barras normalizadas, sem barra final (uso interno). Devolve { texto, partes, pessoal } ou null. */
function partesDoProjeto(cwd, home) {
  if (!cwd || typeof cwd !== "string") return null;
  const norm = (s) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const c = norm(cwd);
  if (!c) return null;
  if (home && c.toLowerCase() === norm(home).toLowerCase()) return { texto: c, partes: [], pessoal: true };
  const partes = c.split("/").filter(Boolean);
  const i = partes.findIndex((p, k) => p === ".claude" && partes[k + 1] === "worktrees");
  const base = i > 0 ? partes.slice(0, i) : partes;
  return { texto: (c.startsWith("/") ? "/" : "") + base.join("/"), partes: base, pessoal: false };
}

/**
 * Nome do projeto a partir do cwd: só o último nome de pasta (nunca o caminho completo).
 * - worktrees (`<repo>/.claude/worktrees/x`) contam para o repositório;
 * - a própria pasta pessoal vira "(pasta pessoal)".
 * @param {string|null|undefined} cwd
 * @param {string} home
 * @returns {string|null}
 */
export function nomeDoProjeto(cwd, home) {
  const b = partesDoProjeto(cwd, home);
  if (!b) return null;
  if (b.pessoal) return "(pasta pessoal)";
  const nome = b.partes[b.partes.length - 1];
  if (!nome || /^[A-Za-z]:$/.test(nome)) return null;
  return nome;
}

/**
 * Caminho completo NORMALIZADO (minúsculas, barras "/", worktrees contam para o repositório), usado só localmente
 * para separar pastas homônimas e casar com a allowlist por caminho. Nunca vai para o JSON público.
 * @param {string|null|undefined} cwd
 * @param {string} home
 */
export function caminhoDoProjeto(cwd, home) {
  const b = partesDoProjeto(cwd, home);
  return b ? b.texto.toLowerCase() : null;
}

/** Chave de allowlist que é um caminho (contém barra) e não só um nome de pasta. */
export const ehChaveDeCaminho = (k) => /[\\/]/.test(k);
export const normalizarChaveDeCaminho = (k) => k.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** Nomes que identificam o dono neste computador: usuário do SO e nome da pasta pessoal. */
function nomesDoUsuario(home) {
  const nomes = new Set();
  try {
    nomes.add(userInfo().username.toLowerCase());
  } catch {
    /* sem informação do usuário */
  }
  for (const h of [home, homedir()]) if (h) nomes.add(basename(h.replace(/[\\/]+$/, "")).toLowerCase());
  nomes.delete("");
  return nomes;
}

/**
 * Valida um nome público (alias): caracteres permitidos, nada que pareça caminho, e-mail ou arquivo,
 * e nada igual ao usuário do sistema ou à pasta pessoal.
 */
export function validarAlias(alias, home) {
  if (typeof alias !== "string" || !ALIAS_VALIDO.test(alias)) throw new Error(`Nome público inválido: "${alias}" (use letras, números, espaço, . _ + -; até 60).`);
  if (nomesDoUsuario(home).has(alias.trim().toLowerCase())) throw new Error(`Nome público inválido: "${alias}" é igual ao seu usuário do sistema.`);
  try {
    garantirSemVazamento(alias, home ?? homedir());
  } catch (e) {
    throw new Error(`Nome público inválido: "${alias}" (${e.message.replace(/^Exportação bloqueada por privacidade: /, "").replace(/\.$/, "")}).`);
  }
  return alias;
}

/** Título livre (config/--title): até 60 caracteres, sem controle, e passa pela mesma barreira de privacidade. */
export function validarTitulo(titulo, home) {
  if (typeof titulo !== "string" || titulo.length > 60) throw new Error("title deve ser texto de até 60 caracteres.");
  if (CONTROLE.test(titulo)) throw new Error("title não pode ter caracteres de controle.");
  try {
    garantirSemVazamento(titulo, home ?? homedir());
  } catch (e) {
    throw new Error(`title recusado: ${e.message.replace(/^Exportação bloqueada por privacidade: /, "")}`);
  }
  return titulo;
}

/**
 * Lê a allowlist da configuração local. Aceita lista (["meu-site"]) ou mapa ({"pasta": "Nome público"}).
 * No mapa a chave pode ser o nome da pasta ("meu-site") ou o caminho completo ("C:\\dev\\meu-site"), para diferenciar
 * pastas homônimas. Caminhos são normalizados (minúsculas, barras "/").
 * @param {unknown} config
 * @param {{ home?: string }} [opt]
 * @returns {Map<string,string>} chave normalizada -> nome público
 */
export function lerAllowlist(config, { home } = {}) {
  const out = new Map();
  const bruto = config && typeof config === "object" ? config.publicProjects : undefined;
  const pares = Array.isArray(bruto)
    ? bruto.map((n) => [n, n])
    : bruto && typeof bruto === "object"
      ? Object.entries(bruto)
      : [];
  const usados = new Set();
  for (const [pasta, alias] of pares) {
    if (typeof pasta !== "string" || typeof alias !== "string") throw new Error("publicProjects: use textos.");
    validarAlias(alias, home);
    const k = alias.toLowerCase();
    if (usados.has(k)) throw new Error(`Nome público repetido: "${alias}".`);
    usados.add(k);
    if (CONTROLE.test(pasta)) throw new Error("publicProjects: pasta com caractere de controle.");
    out.set(ehChaveDeCaminho(pasta) ? normalizarChaveDeCaminho(pasta) : pasta.trim().toLowerCase(), alias);
  }
  return out;
}

/**
 * Última barreira antes de gravar o JSON público: recusa caminhos, e-mails e a pasta pessoal.
 * @param {string} texto JSON serializado
 * @param {string} home
 */
export function garantirSemVazamento(texto, home) {
  const problemas = [];
  const h = home.replace(/\\/g, "/").toLowerCase();
  const t = texto.replace(/\\\\/g, "/").replace(/\\/g, "/").toLowerCase();
  if (h && t.includes(h)) problemas.push("contém a pasta pessoal do usuário");
  if (/[a-z]:\//i.test(t)) problemas.push("contém um caminho de disco (C:/...)");
  if (/\/users\/|\/home\//.test(t)) problemas.push("contém um caminho de usuário");
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(texto)) problemas.push("contém algo parecido com e-mail");
  if (/\.jsonl?\b|\.sqlite|\.db\b/i.test(texto)) problemas.push("contém nome de arquivo de dados");
  if (problemas.length) throw new Error(`Exportação bloqueada por privacidade: ${problemas.join("; ")}.`);
}

/** Mesma barreira para o SVG final (o namespace XML padrão do SVG não conta como caminho). */
export function garantirSvgSemVazamento(svg, home) {
  garantirSemVazamento(svg.replace('xmlns="http://www.w3.org/2000/svg"', ""), home);
}
