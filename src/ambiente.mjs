// Ambiente externo do assistente `setup`: tudo o que sai do processo (gh, API pública do GitHub, npm, schtasks, navegador).
// Cada função é pequena, sem shell (execFile com array de argumentos), com ambiente por allowlist, timeout e limite de saída.
// A saída de programas e da rede é parseada de forma ESTRITA e sanitizada antes de ser mostrada. Nenhum token é lido nem repassado.
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { limparTexto } from "./texto.mjs";

export const USUARIO_GITHUB = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const NOME_REPO = /^[A-Za-z0-9._-]{1,100}$/;
export const NOME_TAREFA = "ai-usage-metrics";
export const PASTA_RUNTIME = ".ai-usage-metrics-runtime";
export const HOST_API = "api.github.com";
export const REGISTRO_NPM = "https://registry.npmjs.org/";
const LIMITE_API = 64 * 1024;
const LIMITE_SAIDA = 256 * 1024;

export const usuarioValido = (u) => typeof u === "string" && USUARIO_GITHUB.test(u);
export const repoValido = (r) => typeof r === "string" && NOME_REPO.test(r) && r !== "." && r !== ".." && !/\.git$/i.test(r);
export const idValido = (n) => Number.isSafeInteger(n) && n > 0;

export { limparTexto };

// Variáveis que os programas externos podem receber. Tokens (GH_TOKEN, GITHUB_TOKEN, NPM_TOKEN...) NÃO passam: o gh usa o login próprio dele.
const ENV_PERMITIDAS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
  "USER", "USERNAME", "LOGNAME", "USERDOMAIN", "COMPUTERNAME", "LANG", "LANGUAGE", "TZ", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "GH_CONFIG_DIR",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS",
]);

/** Ambiente por allowlist para gh/npm/schtasks. */
export function ambienteExterno(base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const K = k.toUpperCase();
    if (ENV_PERMITIDAS.has(K) || K.startsWith("LC_")) env[k] = v;
  }
  env.GH_PROMPT_DISABLED = "1"; // o gh nunca abre pergunta própria
  env.NO_COLOR = "1";
  env.GH_NO_UPDATE_NOTIFIER = "1";
  return env;
}

/** Executa SEM shell. Nunca lança: devolve { ok, ausente, codigo, stdout, stderr }. */
export function executar(comando, args, { timeout = 30_000, env = ambienteExterno(), exec = execFile, cwd, signal } = {}) {
  return new Promise((resolver) => {
    let filho;
    try {
      // `signal`: Ctrl+C no assistente aborta o filho (o execFile o encerra e devolve AbortError).
      filho = exec(comando, args, { env, timeout, windowsHide: true, maxBuffer: LIMITE_SAIDA, cwd, shell: false, signal }, (erro, stdout, stderr) => {
        if (!erro) return resolver({ ok: true, ausente: false, cancelado: false, codigo: 0, stdout: String(stdout), stderr: String(stderr) });
        const cancelado = erro.name === "AbortError" || erro.code === "ABORT_ERR";
        resolver({ ok: false, ausente: erro.code === "ENOENT", cancelado, codigo: typeof erro.code === "number" ? erro.code : -1, stdout: String(stdout ?? ""), stderr: cancelado ? "cancelado" : String(stderr ?? "") });
      });
      filho?.stdin?.end(); // nada para ler: o programa nunca fica esperando o teclado
    } catch (e) {
      resolver({ ok: false, ausente: e?.code === "ENOENT", codigo: -1, stdout: "", stderr: String(e?.message ?? e) });
    }
  });
}

// ---------- parsers estritos (a saída externa é dado hostil) ----------

const objeto = (t) => {
  try {
    const j = JSON.parse(t);
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
};

/** `gh api user` ou GET /users/<login>: { login, id } válidos ou null. Se `esperado` for dado, o login devolvido tem de ser o mesmo (sem diferenciar maiúsculas). */
export function parsearUsuario(texto, esperado) {
  if (typeof texto !== "string" || texto.length > LIMITE_SAIDA) return null;
  const j = objeto(texto);
  if (!j || !usuarioValido(j.login) || !idValido(j.id)) return null;
  if (esperado !== undefined && j.login.toLowerCase() !== String(esperado).toLowerCase()) return null;
  return { login: j.login, id: j.id };
}

/** `gh repo view --json` ou GET /repos/<u>/<n>: { nome, privado } ou null. O nome devolvido tem de ser o pedido. */
export function parsearRepo(texto, nome) {
  if (typeof texto !== "string" || texto.length > LIMITE_SAIDA) return null;
  const j = objeto(texto);
  const privado = j?.isPrivate ?? j?.private;
  if (!j || !repoValido(j.name) || typeof privado !== "boolean") return null;
  if (j.name.toLowerCase() !== String(nome).toLowerCase()) return null;
  return { nome: j.name, privado };
}

// ---------- GitHub: gh e API pública ----------

/** Caminho aceito pela API: /users/<usuário> ou /repos/<usuário>/<repo>, cada parte com a MESMA validação do resto do assistente ('.' e '..' recusados). */
export function caminhoApiValido(caminho) {
  if (typeof caminho !== "string") return false;
  const p = caminho.split("/");
  if (p[0] !== "") return false;
  if (p.length === 3 && p[1] === "users") return usuarioValido(p[2]);
  if (p.length === 4 && p[1] === "repos") return usuarioValido(p[2]) && repoValido(p[3]);
  return false;
}

/**
 * Uma única consulta HTTPS GET, host FIXO, sem credenciais, sem seguir redirecionamento, com timeout de ociosidade, PRAZO TOTAL,
 * limite de tamanho e cancelamento (signal). Usa o ambiente do próprio Node (proxy só com NODE_USE_ENV_PROXY=1).
 */
export function apiGet(caminho, { request = httpsRequest, timeout = 10_000, prazoTotal = 15_000, signal } = {}) {
  return new Promise((resolver) => {
    if (!caminhoApiValido(caminho)) return resolver({ erro: "caminho recusado" });
    let fim = false;
    let relogio = null;
    let req;
    const terminar = (r) => {
      if (fim) return;
      fim = true;
      clearTimeout(relogio);
      resolver(r);
    };
    relogio = setTimeout(() => {
      terminar({ erro: "prazo total esgotado" });
      req?.destroy();
    }, prazoTotal);
    signal?.addEventListener("abort", () => {
      terminar({ erro: "cancelado" });
      req?.destroy();
    }, { once: true });
    try {
      req = request(
        { host: HOST_API, port: 443, path: caminho, method: "GET", timeout, headers: { "User-Agent": "ai-usage-metrics-setup", Accept: "application/vnd.github+json" } },
        (res) => {
          const partes = [];
          let total = 0;
          res.on("data", (c) => {
            total += c.length;
            if (total > LIMITE_API) {
              terminar({ erro: "resposta grande demais" });
              req.destroy();
              return;
            }
            partes.push(c);
          });
          res.on("end", () => terminar({ status: res.statusCode, texto: Buffer.concat(partes).toString("utf8") }));
          res.on("error", () => terminar({ erro: "falha na leitura" }));
        },
      );
    } catch {
      return terminar({ erro: "falha ao iniciar" });
    }
    req.on("timeout", () => {
      terminar({ erro: "tempo esgotado" });
      req.destroy();
    });
    req.on("error", () => terminar({ erro: "sem conexão" }));
    req.end();
  });
}

/** Funções externas reais. Em testes, o assistente recebe um objeto com a mesma forma. */
export function externosPadrao({ exec = execFile, request = httpsRequest, plataforma = process.platform } = {}) {
  const env = ambienteExterno();
  return {
    async ghUsuario() {
      const r = await executar("gh", ["api", "user"], { env, exec });
      if (r.ausente) return { estado: "ausente" };
      if (!r.ok) return { estado: "sem-login" };
      const u = parsearUsuario(r.stdout);
      return u ? { estado: "ok", ...u } : { estado: "erro" };
    },
    async ghRepo(usuario, nome) {
      if (!usuarioValido(usuario) || !repoValido(nome)) return { estado: "erro" };
      const r = await executar("gh", ["repo", "view", `${usuario}/${nome}`, "--json", "name,isPrivate"], { env, exec });
      if (r.ausente) return { estado: "ausente" };
      if (!r.ok) return /could not resolve|not found|404/i.test(r.stderr) ? { estado: "inexistente" } : { estado: "erro" };
      const p = parsearRepo(r.stdout, nome);
      return p ? { estado: "existe", privado: p.privado } : { estado: "erro" };
    },
    async ghCriarRepo(usuario, nome, { signal } = {}) {
      if (!usuarioValido(usuario) || !repoValido(nome)) return { ok: false, motivo: "nome inválido" };
      const r = await executar("gh", ["repo", "create", `${usuario}/${nome}`, "--public", "--description", "AI usage metrics (ai-usage-metrics)"], { env, exec, timeout: 60_000, signal });
      return r.ok ? { ok: true } : { ok: false, cancelado: r.cancelado, motivo: limparTexto(r.stderr || "o gh recusou", 160) };
    },
    async apiUsuario(login) {
      if (!usuarioValido(login)) return { estado: "erro" };
      const r = await apiGet(`/users/${login}`, { request });
      if (r.erro) return { estado: "erro", motivo: r.erro };
      if (r.status === 404) return { estado: "inexistente" };
      if (r.status !== 200) return { estado: "erro", motivo: `HTTP ${Number(r.status) || "?"}` };
      const u = parsearUsuario(r.texto, login);
      return u ? { estado: "ok", ...u } : { estado: "erro", motivo: "resposta inesperada" };
    },
    async apiRepo(usuario, nome) {
      if (!usuarioValido(usuario) || !repoValido(nome)) return { estado: "erro" };
      const r = await apiGet(`/repos/${usuario}/${nome}`, { request });
      if (r.erro) return { estado: "erro", motivo: r.erro };
      if (r.status === 404) return { estado: "inexistente" }; // sem login, um repositório PRIVADO também parece inexistente
      if (r.status !== 200) return { estado: "erro", motivo: `HTTP ${Number(r.status) || "?"}` };
      const p = parsearRepo(r.texto, nome);
      return p ? { estado: "existe", privado: p.privado } : { estado: "erro", motivo: "resposta inesperada" };
    },

    // ---------- npm (cópia fixa do pacote para o agendador) ----------
    async npmInstalar({ prefixo, versao, signal }) {
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(versao)) return { ok: false, motivo: "versão inválida" };
      const cli = localizarNpmCli();
      if (!cli) return { ok: false, motivo: "não encontrei o npm junto do Node" };
      // Registro EXPLÍCITO (o do .npmrc do usuário não decide de onde vem o código que o Agendador vai executar todo dia).
      const r = await executar(process.execPath, [cli, "install", "--prefix", prefixo, `ai-usage-metrics@${versao}`, "--registry", REGISTRO_NPM, "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error"], { env, exec, timeout: 180_000, signal });
      if (!r.ok) return { ok: false, cancelado: r.cancelado, motivo: limparTexto(r.stderr || "o npm falhou", 200) };
      const bin = join(prefixo, "node_modules", "ai-usage-metrics", "bin", "ai-usage-metrics.mjs");
      return existsSync(bin) ? { ok: true, bin } : { ok: false, motivo: "a instalação terminou, mas o executável não está onde esperado" };
    },

    // ---------- Agendador do Windows ----------
    async tarefaExiste(nome) {
      if (plataforma !== "win32") return false;
      const r = await executar("schtasks", ["/Query", "/TN", nome], { env, exec });
      return r.ok;
    },
    /** "Tarefa a executar" da tarefa existente (texto sanitizado), ou null. A chave é localizada (pt-BR/en), então só as conhecidas valem. */
    async tarefaAtual(nome) {
      if (plataforma !== "win32") return null;
      const r = await executar("schtasks", ["/Query", "/TN", nome, "/FO", "LIST", "/V"], { env, exec });
      if (!r.ok) return null;
      for (const linha of r.stdout.split(/\r?\n/)) {
        const m = /^\s*(?:Tarefa a Executar|Task To Run)\s*:\s*(.*)$/i.exec(linha);
        if (m) return limparTexto(m[1], 300) || null;
      }
      return null;
    },
    async criarTarefa({ nome, horario, tr, substituir, signal }) {
      if (plataforma !== "win32") return { ok: false, motivo: "só no Windows" };
      const args = ["/Create", "/SC", "DAILY", "/ST", horario, "/TN", nome, "/TR", tr];
      if (substituir) args.push("/F");
      const r = await executar("schtasks", args, { env, exec, timeout: 30_000, signal });
      return r.ok ? { ok: true } : { ok: false, cancelado: r.cancelado, motivo: limparTexto(r.stderr || r.stdout || "o schtasks recusou", 200) };
    },
    async removerTarefa(nome) {
      const r = await executar("schtasks", ["/Delete", "/TN", nome, "/F"], { env, exec });
      return r.ok;
    },

    // ---------- navegador (só Windows; nos outros sistemas o assistente apenas imprime o caminho) ----------
    async abrir(arquivo) {
      if (plataforma !== "win32" || /[\p{Cc}]/u.test(arquivo)) return false;
      await executar("explorer.exe", [resolve(arquivo)], { env, exec, timeout: 10_000 }); // explorer devolve código 1 mesmo funcionando
      return true;
    },
  };
}

/** Caminho do npm-cli.js ao lado do Node em execução (instalação padrão do Node no Windows e no Linux/macOS), ou null. */
export function localizarNpmCli(execPath = process.execPath, existe = existsSync) {
  const base = dirname(execPath);
  for (const c of [join(base, "node_modules", "npm", "bin", "npm-cli.js"), join(base, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]) if (existe(c)) return resolve(c);
  return null;
}

const realNativo = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p; // caminho que não existe (ou sem acesso): compara só a grafia dada
  }
};
const norm = (p) => String(p).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");

/**
 * O pacote está num lugar que some? (cache do npx/pnpm dlx/yarn dlx/bunx ou pasta temporária). Um agendamento apontando para lá quebraria.
 * Os dois lados são comparados também pelo realpath nativo (cobre nomes 8.3 como RUNNER~1 e links). `real` é injetável nos testes.
 */
export function instalacaoInstavel(bin, { temp = tmpdir(), real = realNativo } = {}) {
  const formas = [...new Set([norm(bin), norm(real(bin))])];
  const pastaTemp = [...new Set([norm(resolve(temp)), norm(real(resolve(temp)))])];
  for (const b of formas) {
    if (/(^|\/)_npx(\/|$)/.test(b) || /(^|\/)dlx(-[^/]*)?(\/|$)/.test(b) || /(^|\/)\.bunx?(\/|$)/.test(b) || /(^|\/)bunx-[^/]*(\/|$)/.test(b)) return true;
    if (pastaTemp.some((t) => b === t || b.startsWith(`${t}/`))) return true;
  }
  return false;
}

/** O Node que o schtasks vai gravar está numa pasta que muda (nvm, fnm multishell, volta, asdf, nodenv, pasta de versão)? Só para AVISAR. */
export function nodeInstavel(execPath = process.execPath) {
  const p = norm(execPath);
  return /(^|\/)(\.nvm|nvm|nvm4w|fnm|fnm_multishells|\.fnm|\.volta|volta|\.asdf|asdf|\.nodenv|nodenv|n\/versions|nodist)(\/|$)/.test(p) || /(^|\/)node-v?\d+\.\d+/.test(p) || /(^|\/)versions\/node(\/|$)/.test(p);
}

/** Caminho do executável da cópia fixa. */
export const binDoRuntime = (home) => join(home, PASTA_RUNTIME, "node_modules", "ai-usage-metrics", "bin", "ai-usage-metrics.mjs");
export const pastaDoRuntime = (home) => join(home, PASTA_RUNTIME);
