// Configuração local e estado do usuário. Tudo fica na pasta do usuário (fora do projeto), nunca é versionado.
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { ADAPTERS } from "./adapters/index.mjs";
import { validarCores } from "./cores.mjs";
import { lerAllowlist, validarTitulo } from "./privacy.mjs";
import { IDIOMAS, MODELOS, TEMAS } from "./svg.mjs";

export const PADROES = Object.freeze({ dataRepo: "ai-metrics", branch: "main", theme: "auto", lang: "en", autoPublish: false });

const CHAVES = ["githubUser", "dataRepo", "branch", "remoteUrl", "publicProjects", "theme", "title", "lang", "autoPublish", "commitName", "commitEmail", "model", "colors", "colorsDark"];
const USUARIO_GITHUB = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NOME_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,60}$/;

/** Pasta de configuração, estado, clone de dados e saídas. Padrão: ~/.ai-usage-metrics */
export const pastaPadrao = () => join(homedir(), ".ai-usage-metrics");

export const caminhos = (stateDir) => ({
  dir: stateDir,
  config: join(stateDir, "config.json"),
  estado: join(stateDir, "state.json"),
  clone: join(stateDir, "repo"),
  saida: join(stateDir, "out"),
  json: join(stateDir, "out", "metrics.json"),
  svg: join(stateDir, "out", "metrics.svg"),
  // um arquivo por modelo, para escolher pela URL sem rodar de novo: metrics.model-1.svg, metrics.model-2.svg, metrics.model-3.svg
  svgsModelos: MODELOS.map((m) => join(stateDir, "out", `metrics.${m}.svg`)),
});

const mesmoCaminho = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const semBarraFinal = (p) => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);

/** Tira o prefixo de caminho estendido (\\?\ ou \\?\UNC\) para comparar caminhos na mesma grafia. */
function semPrefixoEstendido(p) {
  if (/^\\\\\?\\UNC\\/i.test(p)) return "\\\\" + p.slice(8);
  return p.replace(/^\\\\\?\\/, "");
}

/**
 * Grafias de caminho que a ferramenta recusa sem nem tentar resolver: prefixos de dispositivo/estendido (\\?\, //?/, \\.\),
 * caminho UNC (\\servidor\..., inclusive \\localhost\c$) e, no Windows, nome com ponto ou espaço final (o Windows os descarta,
 * e a mesma pasta pode ser escrita de várias formas). Devolve o motivo ou null.
 */
export function grafiaPerigosa(dir, plataforma = process.platform) {
  const s = String(dir);
  if (/^[\\/]{2}[?.][\\/]/.test(s)) return "prefixo de caminho estendido/dispositivo (\\\\?\\, //?/ ou \\\\.\\)";
  if (plataforma === "win32") {
    if (/^[\\/]{2}[^\\/]/.test(s)) return "caminho de rede/UNC";
    if (s.split(/[\\/]+/).some((seg) => seg && seg !== "." && seg !== ".." && /[. ]$/.test(seg))) return "nome terminado em ponto ou espaço";
  }
  return null;
}

/** realpath do caminho ou, se ele ainda não existe, do ancestral existente mais próximo + o resto (já normalizado, sem '..'). */
async function realpathProfundo(d) {
  let atual = d;
  const resto = [];
  for (;;) {
    try {
      return semBarraFinal(semPrefixoEstendido(join(await realpath(atual), ...[...resto].reverse())));
    } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
      const pai = dirname(atual);
      if (pai === atual) return semBarraFinal(semPrefixoEstendido(d));
      resto.push(basename(atual));
      atual = pai;
    }
  }
}

/**
 * Recusa um --state-dir perigoso: grafia suspeita (\\?\, UNC, ponto/espaço final), raiz de unidade, a pasta pessoal inteira
 * (a do sistema e a de --home) ou uma pasta que já é um repositório git. A comparação é feita sobre o realpath (links,
 * junctions e nomes 8.3 resolvem para o mesmo lugar) do state-dir (ou do ancestral existente mais próximo).
 */
export async function validarStateDir(dir, { homes = [] } = {}) {
  const orientacao = "Escolha uma pasta própria e vazia para o estado (padrão: ~/.ai-usage-metrics).";
  const motivo = grafiaPerigosa(dir);
  if (motivo) throw new Error(`--state-dir inválido: ${motivo}. ${orientacao}`);
  const d = resolve(dir);
  const real = await realpathProfundo(d);
  for (const c of [d, real]) if (mesmoCaminho(semBarraFinal(parse(c).root), semBarraFinal(c))) throw new Error(`--state-dir inválido: não use a raiz de uma unidade (nem um link que aponte para ela). ${orientacao}`);
  for (const h of [homedir(), ...homes]) {
    const alvos = [semBarraFinal(resolve(h)), await realpathProfundo(resolve(h))];
    if (alvos.some((a) => mesmoCaminho(a, semBarraFinal(d)) || mesmoCaminho(a, real))) throw new Error(`--state-dir inválido: não use a pasta pessoal inteira (nem um link que aponte para ela). ${orientacao}`);
  }
  try {
    await lstat(join(real, ".git"));
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return;
    throw e;
  }
  throw new Error(`--state-dir inválido: a pasta já é um repositório git (tem .git). ${orientacao}`);
}

/** SOMENTE TESTES: libera remoto local/file:// quando esta variável de ambiente vale "1". Nunca vem da configuração do usuário. */
export const VAR_TESTE_REMOTO_LOCAL = "AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE";
export const modoTesteRemotoLocal = () => process.env[VAR_TESTE_REMOTO_LOCAL] === "1";

// eslint-disable-next-line no-control-regex
const CONTROLE_OU_ESPACO = /[\u0000-\u0020\u007F-\u009F\\]/;
// eslint-disable-next-line no-control-regex
const CONTROLE = /[\u0000-\u001F\u007F-\u009F]/;
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const CAMINHO_SEGURO = /^[A-Za-z0-9._~/-]+$/;
const SCP = /^git@([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):([A-Za-z0-9._~/-]+)$/;

/**
 * Política de host: só nome DNS público com ponto. Recusa localhost/nomes internos, nomes sem ponto, IP literal (v4 em qualquer
 * notação: decimal, hex, octal, formato curto) e qualquer host com rótulo só numérico ou começando com 0x (o getaddrinfo
 * do SO converte esses em IP). IPv6 já é recusado pela regra de caracteres do host.
 * Retorna o motivo (texto curto) ou null se o host é aceitável.
 */
export function motivoHostRecusado(host) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  const rotulos = h.split(".");
  if (rotulos.length < 2) return "host sem ponto (nome interno ou 'localhost')";
  if (/(^|\.)localhost$/.test(h) || /\.(local|localdomain|internal|intranet|lan|home|corp)$/.test(h)) return "host interno/local";
  if (rotulos.some((l) => /^\d+$/.test(l) || /^0x/i.test(l))) return "host numérico (IP em qualquer formato) ou com rótulo numérico/0x";
  return null;
}

/** Host de um remoto já validado (https, ssh:// ou SCP), em minúsculas. */
export function hostDoRemoto(url) {
  const m = SCP.exec(url);
  if (m) return m[1].toLowerCase();
  return new URL(url).hostname.toLowerCase();
}

/**
 * Valida a URL do remoto SEM nunca repetir a URL na mensagem de erro (poderia conter credencial).
 * Aceita só: https://host/caminho (sem usuário/senha), git@host:caminho e ssh://git@host/caminho (sem senha).
 * Recusa: http://, git://, file://, caminhos locais e UNC, ext::/xyz::, nome começando com "-", espaços e caracteres de controle.
 * Remoto local só no modo de testes (variável AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE=1, "somente testes").
 */
export function validarRemoto(url) {
  const ruim = (motivo) =>
    new Error(
      `remoteUrl inválido: ${motivo}. Aceito: https://host/caminho, git@host:caminho ou ssh://git@host/caminho (sem usuário/senha/token na URL: use o gerenciador de credenciais do git ou chave SSH).`,
    );
  if (typeof url !== "string" || !url) throw ruim("vazio");
  if (url.length > 300) throw ruim("longo demais");
  if (url.startsWith("-")) throw ruim("não pode começar com '-'");
  if (CONTROLE.test(url)) throw ruim("caractere de controle");
  if (/^[A-Za-z0-9+.-]*::/.test(url)) throw ruim("transporte auxiliar (ext::/xyz::) não é permitido");
  if (modoTesteRemotoLocal() && (isAbsolute(url) || /^file:\/\//i.test(url))) return url; // SOMENTE TESTES (remoto bare local)
  if (CONTROLE_OU_ESPACO.test(url)) throw ruim("espaço ou barra invertida");

  const urlComHost = (esquema) => {
    // Validação da string CRUA, antes de o parser de URL normalizar (ele converte IDN em punycode e resolve "%2e%2e").
    if (/[^\x21-\x7E]/.test(url)) throw ruim("caracteres fora de ASCII imprimível (hosts internacionalizados/homógrafos não são aceitos)");
    const sem = url.slice(url.indexOf("//") + 2);
    const barra = sem.indexOf("/");
    if (barra < 1) throw ruim("URL malformada");
    const autoridadeCrua = sem.slice(0, barra);
    const caminhoCru = sem.slice(barra);
    const hostCru = autoridadeCrua.replace(/^git@/i, "").replace(/:\d{1,5}$/, "");
    if (!HOST.test(hostCru)) throw ruim("host inválido (só letras ASCII, dígitos, '.' e '-')");
    const proibido = motivoHostRecusado(hostCru);
    if (proibido) throw ruim(proibido);
    if (hostCru.split(".").some((l) => /^xn--/i.test(l))) throw ruim("host em punycode (xn--) não é aceito: pode ser um domínio parecido com outro");
    if (caminhoCru.includes("%")) throw ruim("sem '%' (codificação percentual) no caminho");
    if (caminhoCru.split("/").some((x) => x === "." || x === "..") || !CAMINHO_SEGURO.test(caminhoCru)) throw ruim("caminho inválido");
    let u;
    try {
      u = new URL(url);
    } catch {
      throw ruim("URL malformada");
    }
    if (!new RegExp(`^${esquema}://[^/@]+(?::\\d{1,5})?/`, "i").test(url) && !new RegExp(`^${esquema}://git@[^/@]+(?::\\d{1,5})?/`, "i").test(url)) {
      throw ruim("usuário/senha/token embutidos ou host malformado");
    }
    if (!HOST.test(u.hostname)) throw ruim("host inválido");
    if (url.split("/").some((x) => x === ".." || x === ".")) throw ruim("caminho inválido");
    if (u.search || u.hash) throw ruim("sem parâmetros na URL");
    if (u.pathname.length < 2 || !CAMINHO_SEGURO.test(u.pathname) || u.pathname.split("/").includes("..")) throw ruim("caminho inválido");
    return u;
  };

  if (/^https:\/\//i.test(url)) {
    const u = urlComHost("https");
    if (u.username || u.password || /^https:\/\/[^/]*@/i.test(url)) throw ruim("credenciais embutidas na URL");
    return url;
  }
  if (/^ssh:\/\//i.test(url)) {
    const u = urlComHost("ssh");
    if (u.username !== "git" || u.password) throw ruim("ssh:// exige o usuário 'git' e não aceita senha");
    return url;
  }
  const m = SCP.exec(url);
  if (m) {
    if (m[2].startsWith("/") || m[2].startsWith("-") || m[2].split("/").some((x) => x === "." || x === "..")) throw ruim("caminho inválido");
    const proibido = motivoHostRecusado(m[1]);
    if (proibido) throw ruim(proibido);
    if (m[1].split(".").some((l) => /^xn--/i.test(l))) throw ruim("host em punycode (xn--) não é aceito: pode ser um domínio parecido com outro");
    return url;
  }
  throw ruim("esquema ou formato não permitido (http://, git://, file://, caminhos locais e UNC são recusados)");
}

/**
 * Forma normalizada do remoto para comparar "é o mesmo destino?" (host em minúsculas, sem .git, sem barra final).
 * SCP (git@host:caminho, caminho relativo ao HOME do servidor) vira scp://git@host/caminho, DIFERENTE de ssh://git@host/caminho
 * (caminho absoluto): trocar de uma forma para a outra conta como "mudou".
 */
export function normalizarRemoto(url) {
  validarRemoto(url);
  let s = url.trim();
  const m = SCP.exec(s);
  if (m) s = `scp://git@${m[1]}/${m[2]}`;
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "");
  const p = /^(https|ssh|scp):\/\/([^/]+)(\/.*)?$/i.exec(s);
  if (p) return `${p[1].toLowerCase()}://${p[2].toLowerCase()}${p[3] ?? ""}`;
  return s;
}

const SUFIXO_NOREPLY = "@users.noreply.github.com";
const EMAIL_COMMIT = /^[^\s@<>,;:"'\\]{1,64}@[A-Za-z0-9.-]{1,190}$/;
// eslint-disable-next-line no-control-regex
const NOME_COMMIT = /^[^\u0000-\u001F\u007F<>\\]{1,100}$/;

/** Autor/committer que irá para o histórico público. Padrão: <githubUser>@users.noreply.github.com. */
export function autorDoCommit(c) {
  const name = c.commitName ?? c.githubUser;
  const email = c.commitEmail ?? `${c.githubUser}${SUFIXO_NOREPLY}`;
  return { name, email, noreply: email.toLowerCase().endsWith(SUFIXO_NOREPLY) };
}

/** Valida e completa a configuração. Rejeita chaves desconhecidas (um erro de digitação não pode desligar uma trava em silêncio). */
export function normalizarConfig(bruto) {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) throw new Error("Configuração inválida: esperado um objeto.");
  for (const k of Object.keys(bruto)) if (!CHAVES.includes(k)) throw new Error(`Configuração: chave desconhecida "${k}". Permitidas: ${CHAVES.join(", ")}.`);
  const c = { ...PADROES, ...bruto };
  if (typeof c.githubUser !== "string" || !USUARIO_GITHUB.test(c.githubUser)) throw new Error("Configuração: githubUser ausente ou inválido.");
  if (!NOME_REPO.test(String(c.dataRepo))) throw new Error("Configuração: dataRepo inválido.");
  if (!BRANCH.test(String(c.branch)) || String(c.branch).includes("..")) throw new Error("Configuração: branch inválida.");
  if (c.remoteUrl !== undefined) validarRemoto(c.remoteUrl);
  if (!TEMAS.includes(c.theme)) throw new Error(`Configuração: theme deve ser ${TEMAS.join("|")}.`);
  if (!IDIOMAS.includes(c.lang)) throw new Error(`Configuração: lang deve ser ${IDIOMAS.join("|")}.`);
  if (c.title !== undefined) {
    try {
      validarTitulo(c.title);
    } catch (e) {
      throw new Error(`Configuração: ${e.message}`);
    }
  }
  if (c.model !== undefined && !MODELOS.includes(c.model)) throw new Error(`Configuração: model deve ser ${MODELOS.join("|")}.`);
  const idsFerramentas = ADAPTERS.map((a) => a.id);
  for (const chave of ["colors", "colorsDark"]) {
    if (c[chave] === undefined) continue;
    try {
      c[chave] = validarCores(c[chave], idsFerramentas, chave); // devolve o objeto normalizado (#rrggbb em minúsculas)
    } catch (e) {
      throw new Error(`Configuração: ${e.message}`);
    }
  }
  if (typeof c.autoPublish !== "boolean") throw new Error("Configuração: autoPublish deve ser true ou false.");
  if (c.commitName !== undefined && (typeof c.commitName !== "string" || !NOME_COMMIT.test(c.commitName))) throw new Error("Configuração: commitName inválido (até 100 caracteres, sem < > nem caracteres de controle).");
  if (c.commitEmail !== undefined && (typeof c.commitEmail !== "string" || !EMAIL_COMMIT.test(c.commitEmail))) throw new Error("Configuração: commitEmail inválido.");
  lerAllowlist(c); // valida publicProjects
  return c;
}

export const urlDoRemoto = (c) => c.remoteUrl ?? `https://github.com/${c.githubUser}/${c.dataRepo}.git`;

export async function lerConfig(arquivo) {
  let txt;
  try {
    txt = await readFile(arquivo, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`Configuração ilegível (${arquivo}): ${e.message}`);
  }
  try {
    return normalizarConfig(JSON.parse(txt));
  } catch (e) {
    throw new Error(`Configuração inválida (${arquivo}): ${e.message}`);
  }
}

export async function gravarConfig(arquivo, config) {
  await mkdir(resolve(arquivo, ".."), { recursive: true, mode: 0o700 }); // Linux/macOS; no Windows valem as ACLs do perfil
  await writeFile(arquivo, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(arquivo, 0o600).catch(() => {}); // arquivo que já existia (--overwrite) também fica restrito; no Windows o chmod quase não tem efeito
}

/**
 * Estado interno: se já houve publicação manual confirmada (em terminal interativo) e o que foi aprovado nela:
 * nomes públicos, o destino {remoto normalizado, branch, autor do commit (nome e e-mail efetivos)} e os pares pasta/nome -> nome público.
 */
export async function lerEstado(arquivo) {
  const vazio = { manualPublishConfirmed: false, approvedPublicNames: [], approvedTarget: null, approvedFolders: Object.create(null), lastPublishAt: null };
  try {
    const e = JSON.parse(await readFile(arquivo, "utf8"));
    const pastas = Object.create(null);
    if (e.approvedFolders && typeof e.approvedFolders === "object" && !Array.isArray(e.approvedFolders)) {
      for (const [k, v] of Object.entries(e.approvedFolders)) if (typeof v === "string") pastas[k] = v;
    }
    const t = e.approvedTarget;
    return {
      manualPublishConfirmed: e.manualPublishConfirmed === true,
      approvedPublicNames: Array.isArray(e.approvedPublicNames) ? e.approvedPublicNames.filter((n) => typeof n === "string") : [],
      approvedTarget:
        t && typeof t.remote === "string" && typeof t.branch === "string"
          ? { remote: t.remote, branch: t.branch, commitName: typeof t.commitName === "string" ? t.commitName : null, commitEmail: typeof t.commitEmail === "string" ? t.commitEmail : null }
          : null,
      approvedFolders: pastas,
      lastPublishAt: typeof e.lastPublishAt === "string" ? e.lastPublishAt : null,
    };
  } catch {
    return vazio;
  }
}

export async function gravarEstado(arquivo, estado) {
  await mkdir(resolve(arquivo, ".."), { recursive: true, mode: 0o700 });
  await writeFile(arquivo, JSON.stringify(estado, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}
