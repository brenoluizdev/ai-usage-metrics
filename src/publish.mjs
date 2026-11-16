// Publicação: valida, mostra o que seria enviado (dry-run) e, só com confirmação, faz commit + push no
// repositório de dados do próprio usuário usando o `git` dele. Nunca usa --force, nunca lida com tokens.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ADAPTERS } from "./adapters/index.mjs";
import { aposentarClone, cloneEhNosso, gravarMarcadores } from "./clone-owner.mjs";
import { autorDoCommit, hostDoRemoto, modoTesteRemotoLocal, normalizarRemoto, urlDoRemoto, validarRemoto } from "./config.mjs";
import { garantirSemVazamento, garantirSvgSemVazamento, lerAllowlist, validarTitulo } from "./privacy.mjs";
import { lerArquivoLimitado } from "./limitado.mjs";
import { avaliarRegressao, linhasDeRegressao } from "./regressao.mjs";
import { exigirMetricasValidas, validarMetricas } from "./schema.mjs";
import { MODELOS, MODELO_PADRAO, gerarSvg } from "./svg.mjs";

const execFileP = promisify(execFile);

// Lista FIXA (allowlist) do que o publish escreve, adiciona ao git e envia: arquivos planos na raiz do repositório de dados.
export const ARQUIVOS = Object.freeze(["metrics.json", "metrics.svg", ...MODELOS.map((m) => `metrics.${m}.svg`)]);
export const MENSAGEM_DE_COMMIT = "chore(metrics): update AI usage metrics";

/** Remove credenciais de qualquer texto que vá para mensagem de erro ou log (user:senha@host). */
export const semCredenciais = (t) => String(t).replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, "$1***@");

// Variáveis do ambiente que o git pode receber. Todo o resto (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
// GIT_CONFIG_COUNT/KEY_n/VALUE_n, GIT_SSH_COMMAND, GIT_SSH, GIT_ASKPASS, GIT_EXEC_PATH, GIT_PROXY_COMMAND...) NÃO é repassado.
const ENV_PERMITIDAS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
  "USER", "USERNAME", "LOGNAME", "USERDOMAIN", "COMPUTERNAME", "LANG", "LANGUAGE", "TZ", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR",
]);

/** Monta o ambiente do git por allowlist. Em modo de testes, também deixa passar o isolamento de config do git. */
export function ambienteGit({ interativo, autor, base = process.env }) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    const K = k.toUpperCase();
    if (v === undefined) continue;
    if (ENV_PERMITIDAS.has(K) || K.startsWith("LC_")) env[k] = v;
    else if (modoTesteRemotoLocal() && (K === "GIT_CONFIG_GLOBAL" || K === "GIT_CONFIG_NOSYSTEM")) env[k] = v;
  }
  if (!interativo) env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM ??= undefined;
  if (env.GIT_CONFIG_NOSYSTEM === undefined) delete env.GIT_CONFIG_NOSYSTEM;
  if (autor) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = autor.name;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = autor.email;
  }
  return env;
}

/** Opções -c fixas: só https/ssh, sem hooks do usuário, sem symlinks, sem assinatura/gerenciador de arquivos externo. */
export function opcoesSeguras({ semHooks, autor }) {
  const o = [
    "protocol.allow=never",
    "protocol.https.allow=always",
    "protocol.ssh.allow=always",
    `core.hooksPath=${semHooks}`,
    "core.symlinks=false",
    "core.fsmonitor=false",
    "commit.gpgsign=false",
    "init.templateDir=",
  ];
  if (modoTesteRemotoLocal()) o.push("protocol.file.allow=always"); // somente testes (repositório bare local)
  if (autor) o.push(`user.name=${autor.name}`, `user.email=${autor.email}`);
  return o.flatMap((x) => ["-c", x]);
}

async function git(args, { cwd, env, timeout = 120_000 } = {}) {
  if (!cwd) throw new Error("erro interno: todo comando git precisa de cwd explícito (nunca herda o diretório do processo)");
  try {
    const { stdout } = await execFileP("git", args, { cwd, env, timeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const detalhe = semCredenciais((e.stderr || e.message || "").toString().trim().split("\n").slice(-4).join(" | "));
    const sub = args.find((x, i) => !x.startsWith("-") && args[i - 1] !== "-c");
    throw new Error(`git ${sub} falhou: ${detalhe}`);
  }
}

/** Recusa symlink (ou qualquer coisa que não seja arquivo comum) no destino da escrita. */
/** `lstatFn` existe só para os testes simularem link simbólico sem precisar de privilégio no SO. */
export async function exigirArquivoSeguro(arquivo, lstatFn = lstat) {
  let st;
  try {
    st = await lstatFn(arquivo);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  if (st.isSymbolicLink()) throw new Error(`Recuso escrever em ${arquivo}: é um link simbólico. Mova a pasta 'repo' do estado para outro lugar.`);
  if (!st.isFile()) throw new Error(`Recuso escrever em ${arquivo}: não é um arquivo comum.`);
}

/** Escrita atômica: arquivo temporário exclusivo na mesma pasta + rename. Nunca segue symlink no destino. */
export async function escreverAtomico(dir, nome, conteudo, { mode } = {}) {
  const alvo = join(dir, nome);
  await exigirArquivoSeguro(alvo);
  const tmp = join(dir, `.${nome}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, conteudo, { encoding: "utf8", flag: "wx", ...(mode === undefined ? {} : { mode }) });
    await exigirArquivoSeguro(alvo); // de novo, logo antes de trocar
    await rename(tmp, alvo);
    if (mode !== undefined) await chmod(alvo, mode).catch(() => {}); // no Windows o modo quase não tem efeito (valem as ACLs do perfil)
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Contagem de linhas adicionadas/removidas (multiconjunto de linhas; suficiente para um resumo). */
function resumoDeLinhas(antigo, novo) {
  const conta = (t) => {
    const m = new Map();
    for (const l of t.split("\n")) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const a = conta(antigo);
  const b = conta(novo);
  let add = 0;
  let rem = 0;
  for (const [l, n] of b) add += Math.max(0, n - (a.get(l) ?? 0));
  for (const [l, n] of a) rem += Math.max(0, n - (b.get(l) ?? 0));
  return { add, rem };
}

async function lerSeExiste(arquivo) {
  await exigirArquivoSeguro(arquivo); // clone adulterado (link simbólico) não é lido
  try {
    return await readFile(arquivo, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Valida o JSON e monta o plano de envio SEM escrever nada em disco nem tocar na rede.
 * O SVG enviado é sempre re-renderizado aqui a partir do JSON validado.
 * @param {{ config: any, caminhos: any, jsonPath: string, home: string }} p
 */
export async function planejar({ config, caminhos, jsonPath, home }) {
  let texto;
  try {
    texto = await readFile(jsonPath, "utf8");
  } catch (e) {
    throw new Error(`Não consegui ler ${jsonPath}: ${e.code === "ENOENT" ? "arquivo não existe (rode export primeiro)" : e.message}.`);
  }
  let json;
  try {
    json = JSON.parse(texto);
  } catch {
    throw new Error(`${jsonPath} não é um JSON válido.`);
  }
  exigirMetricasValidas(json); // allowlist estrita de campos e formatos
  garantirSemVazamento(JSON.stringify(json), home); // barreira de privacidade existente

  // Ferramentas: id e nome têm de ser exatamente os das fontes registradas (nada de texto livre em campos de ferramenta).
  const nomesConhecidos = new Map(ADAPTERS.map((a) => [a.id, a.name]));
  const ids = new Set([
    ...json.tools.map((t) => t.id),
    ...json.projects.flatMap((p) => p.tools.map((t) => t.id)),
    ...json.timeline.points.flatMap((p) => Object.keys(p.byTool)),
  ]);
  const desconhecidas = [...ids].filter((id) => !nomesConhecidos.has(id));
  if (desconhecidas.length) throw new Error("JSON recusado: ferramenta fora das fontes registradas: " + desconhecidas.join(", ") + ".");
  const nomeDiferente = json.tools.filter((t) => nomesConhecidos.get(t.id) !== t.name).map((t) => t.id);
  if (nomeDiferente.length) throw new Error("JSON recusado: nome de ferramenta diferente do registrado na fonte: " + nomeDiferente.join(", ") + ".");

  // Nomes públicos precisam estar na allowlist da configuração (o JSON pode ter sido editado à mão).
  const aliases = new Set([...lerAllowlist(config, { home }).values()].map((n) => n.toLowerCase()));
  const publicos = json.projects.filter((p) => p.public && p.name !== "sem-projeto").map((p) => p.name);
  const fora = publicos.filter((n) => !aliases.has(n.toLowerCase()));
  if (fora.length) throw new Error(`JSON recusado: projeto(s) públicos fora da allowlist da configuração: ${fora.join(", ")}.`);

  const jsonFinal = JSON.stringify(json, null, 2) + "\n";
  if (config.title !== undefined) validarTitulo(config.title, home);
  // Todos os SVGs são regerados aqui a partir do JSON validado (nunca se envia um SVG pronto do disco), com as mesmas cores,
  // e cada um passa pela barreira de privacidade antes de ser enviado. metrics.svg = o modelo escolhido em `model`.
  const opcoesSvg = { tema: config.theme, titulo: config.title, idioma: config.lang, cores: config.colors, coresEscuro: config.colorsDark };
  const svgs = Object.fromEntries(MODELOS.map((m) => [m, gerarSvg(json, { ...opcoesSvg, modelo: m })]));
  for (const svg of Object.values(svgs)) garantirSvgSemVazamento(svg, home);

  const novos = { "metrics.json": jsonFinal, "metrics.svg": svgs[config.model ?? MODELO_PADRAO] };
  for (const m of MODELOS) novos[`metrics.${m}.svg`] = svgs[m];
  const antigos = {};
  for (const nome of ARQUIVOS) antigos[nome] = await lerSeExiste(join(caminhos.clone, nome));
  const arquivos = ARQUIVOS.map((nome) => {
    const velho = antigos[nome];
    const status = velho === null ? "novo" : velho === novos[nome] ? "sem mudança" : "alterado";
    const { add, rem } = velho === null ? { add: novos[nome].split("\n").length, rem: 0 } : resumoDeLinhas(velho, novos[nome]);
    return { nome, conteudo: novos[nome], bytes: Buffer.byteLength(novos[nome]), status, add, rem };
  });

  let anterior = null;
  try {
    anterior = antigos["metrics.json"] && antigos["metrics.json"].length <= 5 * 1024 * 1024 ? JSON.parse(antigos["metrics.json"]) : null;
  } catch {
    anterior = null;
  }
  // Só uma referência válida pelo esquema serve de comparação (a guarda de regressão olha a série, não os totais declarados).
  const anteriorJson = anterior && typeof anterior === "object" && validarMetricas(anterior).ok ? anterior : null;
  const anteriorInvalido = antigos["metrics.json"] !== null && !anteriorJson; // existe no clone mas não serve de referência

  return {
    json,
    arquivos,
    publicos,
    anonimizados: json.projects.filter((p) => !p.public).length,
    remoto: validarRemoto(urlDoRemoto(config)),
    branch: config.branch,
    autor: autorDoCommit(config),
    cloneExiste: existsSync(join(caminhos.clone, ".git")),
    anteriorJson,
    anteriorInvalido,
    anterior: anteriorJson
      ? { sessions: anteriorJson.totals.sessions, userMessages: anteriorJson.totals.userMessages, dias: anteriorJson.timeline.points.length, from: anteriorJson.period?.from ?? null, to: anteriorJson.period?.to ?? null }
      : anterior && typeof anterior === "object" && anterior.totals && Number.isSafeInteger(anterior.totals.sessions) && Number.isSafeInteger(anterior.totals.userMessages)
        ? { sessions: anterior.totals.sessions, userMessages: anterior.totals.userMessages }
        : null,
  };
}

/** Texto do dry-run: exatamente o que seria enviado e o que ficaria público. */
export function descreverPlano(plano) {
  const L = [];
  L.push("O que seria enviado (dry-run):");
  L.push(`  repositório: ${plano.remoto} (branch ${plano.branch})`);
  if (!/^(file:|[A-Za-z]:|\/)/i.test(plano.remoto)) {
    const host = hostDoRemoto(plano.remoto);
    if (host !== "github.com") L.push(`  ATENÇÃO: o host é "${host}", não github.com. Confira se é o servidor que você quer (por exemplo, um GitHub Enterprise seu); o histórico será enviado para lá.`);
  }
  if (!plano.cloneExiste) L.push("  clone local de dados: ainda não existe (será criado na confirmação); diferenças abaixo são contra um repositório vazio.");
  for (const a of plano.arquivos) L.push(`  - ${a.nome}  ${a.bytes} bytes  [${a.status}${a.status === "sem mudança" ? "" : `: +${a.add} -${a.rem} linhas`}]`);
  L.push(`  commit: "${MENSAGEM_DE_COMMIT}" (somente esses ${ARQUIVOS.length} arquivos)`);
  L.push(`  autor do commit (vai para o histórico público): ${plano.autor.name} <${plano.autor.email}>`);
  if (!plano.autor.noreply) {
    L.push("  ATENÇÃO: este e-mail NÃO é um endereço noreply do GitHub (…@users.noreply.github.com); ele ficará PÚBLICO e permanente no histórico.");
    L.push('  Para usar o noreply, ajuste "commitEmail" na configuração (veja SECURITY.md). O envio exige confirmação extra.');
  }
  const t = plano.json.totals;
  L.push(`Resumo dos números: ${t.sessions} sessões, ${t.userMessages} mensagens, ${t.activeDays} dias ativos, ${t.projects} projetos.`);
  if (plano.anterior) L.push(`  antes: ${plano.anterior.sessions} sessões, ${plano.anterior.userMessages} mensagens${plano.anterior.dias === undefined ? "" : `, ${plano.anterior.dias} dias${plano.anterior.from ? ` (${plano.anterior.from} a ${plano.anterior.to})` : ""}`}.`);
  L.push("Validação: esquema v1 estrito OK; barreira de privacidade OK; SVGs gerados só a partir do JSON validado.");
  L.push(`Privacidade: ${plano.anonimizados} projeto(s) anonimizado(s) (projeto-privado-N).`);
  L.push(plano.publicos.length ? `  Nomes que ficariam PÚBLICOS: ${plano.publicos.join(", ")}.` : "  Nenhum nome de projeto ficaria público.");
  L.push("  Datas, quantidades e a ordem do ranking também ficam públicas. O histórico de um repositório público é permanente.");
  return L.join("\n");
}

// Chaves que um clone nosso pode ter no .git/config. QUALQUER outra (pushurl, sshCommand, insteadOf, credential.*, include,
// core.fsmonitor/editor/pager, filtros, proxy...) significa que o clone foi alterado: ele é recriado em vez de confiado.
const CHAVES_DO_CLONE = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|symlinks|precomposeunicode)$/,
  /^remote\.origin\.(url|fetch)$/,
  /^branch\.[^\n]+\.(remote|merge)$/,
];
// Refspec de BUSCA padrão do git clone (o "+" aqui é só da busca local; o push nunca usa refspec forçado).
const REFSPEC_PADRAO = "+" + "refs/heads/*:refs/remotes/origin/*";

/**
 * Confere o clone em cache SEM rodar nada dele. Devolve o motivo (texto curto, sem URLs) se precisa ser recriado, ou null.
 * Ordem: clone e .git são pastas de verdade (lstat) -> config só com chaves esperadas -> remote.origin.url CRU (sem insteadOf
 * do usuário) igual ao remoto aprovado depois de normalizar os dois lados.
 */
async function problemaNoClone({ caminhos, dotGit, remoto, env, seguras }) {
  let stClone;
  try {
    stClone = await lstat(caminhos.clone);
  } catch (e) {
    if (e.code === "ENOENT") return null; // ainda não existe: será criado
    throw e;
  }
  if (stClone.isSymbolicLink() || !stClone.isDirectory()) return "a pasta era um link simbólico ou não era pasta";
  let stGit;
  try {
    stGit = await lstat(dotGit);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    return (await readdir(caminhos.clone)).length ? "o clone estava sem .git" : null; // pasta vazia: o git clona dentro dela
  }
  if (stGit.isSymbolicLink() || !stGit.isDirectory()) return ".git era um arquivo ou link simbólico";
  let lista;
  try {
    // --git-dir explícito, --no-includes e só leitura: ler a config não executa nada do clone.
    lista = await git([...seguras, `--git-dir=${dotGit}`, "config", "--local", "--no-includes", "--list", "-z"], { cwd: caminhos.clone, env });
  } catch {
    return "a configuração do clone era ilegível";
  }
  const entradas = lista.split("\0").filter(Boolean).map((e) => {
    const i = e.indexOf("\n");
    return i === -1 ? [e, ""] : [e.slice(0, i), e.slice(i + 1)];
  });
  for (const [k] of entradas) if (!CHAVES_DO_CLONE.some((r) => r.test(k))) return "a configuração do clone tinha chaves inesperadas";
  const valores = (k) => entradas.filter(([x]) => x === k).map(([, v]) => v);
  const urls = valores("remote.origin.url");
  if (urls.length !== 1) return "o clone não tinha exatamente um remote.origin.url";
  const fetchs = valores("remote.origin.fetch");
  if (fetchs.length !== 1 || fetchs[0] !== REFSPEC_PADRAO) return "o refspec de busca do clone era diferente do esperado";
  try {
    if (normalizarRemoto(urls[0]) !== normalizarRemoto(remoto)) return "o clone apontava para outro repositório";
  } catch {
    return "a URL do clone era inválida";
  }
  return null;
}

/**
 * Recusa (sem apagar nada) uma pasta 'repo' que não é nossa: link/junction/arquivo, pasta com conteúdo sem o nosso marcador,
 * ou repositório do usuário. Só passa: inexistente, pasta vazia (o git clona dentro dela) ou clone com marcador válido.
 */
async function exigirPastaRepoSegura(caminhos) {
  const orientacao = `Mova ou renomeie '${caminhos.clone}' para outro lugar, ou escolha outro --state-dir. Se ela for um clone criado por uma versão anterior desta ferramenta (sem marcador de posse), basta renomear a pasta 'repo'; um novo clone será criado no próximo envio e o conteúdo antigo fica intacto. Nada foi apagado.`;
  let st;
  try {
    st = await lstat(caminhos.clone);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  if (st.isSymbolicLink()) throw new Error(`Recuso usar a pasta 'repo' do estado: é um link simbólico/junction. ${orientacao}`);
  if (!st.isDirectory()) throw new Error(`Recuso usar a pasta 'repo' do estado: não é uma pasta. ${orientacao}`);
  if (await cloneEhNosso(caminhos.dir, caminhos.clone)) return;
  if ((await readdir(caminhos.clone)).length === 0) return;
  throw new Error(`A pasta 'repo' do estado já existe e NÃO foi criada por esta ferramenta (sem o nosso marcador); recuso alterá-la ou apagá-la. ${orientacao}`);
}

/** Aviso explícito quando a guarda de perda de histórico não tem com o que comparar (não bloqueia: senão o primeiro publish travaria). */
export const AVISO_SEM_REFERENCIA = (motivo) => `ATENÇÃO: sem referência válida para comparar (${motivo}): a proteção contra perda de histórico não pôde ser aplicada.`;

/** Ambiente seguro do git (remoto validado, env por allowlist, sem hooks, cwd explícito): a mesma maquinaria do publish e do restore. */
async function prepararGit({ config, caminhos, interativo }) {
  const remoto = validarRemoto(urlDoRemoto(config));
  const autor = autorDoCommit(config);
  const semHooks = join(caminhos.dir, "sem-hooks");
  await mkdir(semHooks, { recursive: true, mode: 0o700 });
  const env = ambienteGit({ interativo, autor });
  // Teto de descoberta: com cwd = state-dir e o PAI dele como teto, o git nunca sobe para um repositório do usuário que por
  // acaso contenha o state-dir (nem lê a config/insteadOf dele), nem em clone/init, que não recebem --git-dir.
  env.GIT_CEILING_DIRECTORIES = dirname(await realpath(caminhos.dir));
  const seguras = opcoesSeguras({ semHooks, autor });
  const dotGit = join(caminhos.clone, ".git");
  // --git-dir/--work-tree explícitos: o git nunca "sobe" para uma pasta-mãe que por acaso seja outro repositório.
  const g = (args, opts = {}) => git([...seguras, `--git-dir=${dotGit}`, `--work-tree=${caminhos.clone}`, ...args], { cwd: caminhos.clone, env, ...opts });
  return { remoto, autor, env, seguras, dotGit, g };
}

/**
 * Deixa o clone local (só nosso) alinhado ao remoto: confere a posse, clona ou busca (rede), recusa alterações e metrics.* que não
 * sejam arquivos comuns. `criarBranchLocal`: o publish cria a branch local mesmo se o remoto ainda não tem; o restore não.
 * @returns {Promise<{ temRemota: boolean, modos: () => Promise<string[]> }>}
 */
async function sincronizarClone({ config, caminhos, ctx, avisar, criarBranchLocal }) {
  const { remoto, env, seguras, dotGit, g } = ctx;
  // 0) A pasta 'repo' só é tocada se for NOSSA (marcador). Nada é apagado: um clone nosso divergente é RENOMEADO.
  await exigirPastaRepoSegura(caminhos);
  // 1) Antes de QUALQUER comando git no clone: ele e o .git têm de ser pastas de verdade e a config tem de ser a que nós criamos.
  const problema = await problemaNoClone({ caminhos, dotGit, remoto, env, seguras });
  if (problema) {
    const velho = await aposentarClone(caminhos.dir, caminhos.clone, { avisar });
    avisar(`o clone local de dados foi recriado (${problema}). O antigo foi guardado em '${velho}' dentro do state-dir (são mantidos só os 3 mais recentes).`);
  }
  if (!existsSync(dotGit)) {
    await git([...seguras, "clone", "--quiet", "--no-hardlinks", "--", remoto, caminhos.clone], { cwd: caminhos.dir, env });
    for (const p of [caminhos.clone, dotGit]) {
      const st = await lstat(p);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("O clone local de dados é inválido (link simbólico ou não é pasta). Mova a pasta 'repo' do estado para outro lugar.");
    }
    await gravarMarcadores(caminhos.dir, caminhos.clone);
  } else {
    await g(["fetch", "--quiet", "origin"]);
  }

  if ((await g(["status", "--porcelain"])).trim()) throw new Error("O clone local de dados tem alterações inesperadas; recuso mexer nele. Mova a pasta 'repo' do estado para outro lugar (ela será recriada).");

  const temRemota = await g(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${config.branch}`]).then(
    () => true,
    () => false,
  );
  if (temRemota) await g(["checkout", "--quiet", "-B", config.branch, `origin/${config.branch}`]);
  else if (criarBranchLocal) await g(["checkout", "--quiet", "-B", config.branch]);

  // Se o remoto traz metrics.* como link simbólico (modo 120000) ou outra coisa que não arquivo comum, recuso.
  const modos = async () => (await g(["ls-files", "-s", "--", ...ARQUIVOS])).split("\n").filter(Boolean).map((l) => l.split(/\s+/)[0]);
  if ((await modos()).some((m) => m !== "100644" && m !== "100755")) throw new Error("O repositório de dados tem metrics.json/metrics*.svg que não são arquivos comuns (link simbólico?). Recuso; corrija o repositório.");
  return { temRemota, modos };
}

/**
 * Sincroniza o clone local, escreve os arquivos de ARQUIVOS, faz commit e push (sem force).
 * O clone em cache é só nosso: antes de escrever ele é alinhado ao remoto (checkout -B local, nunca force no remoto).
 * Proteções: remoto validado (https/ssh), ambiente do git por allowlist, hooks do usuário desligados, symlinks recusados,
 * escrita atômica, autor do commit explícito (padrão: noreply do GitHub).
 * @returns {Promise<{ enviado: boolean, motivo?: string, jaPublicado?: boolean }>}
 */
export async function enviar(plano, { config, caminhos, interativo, avisar = () => {}, permitirPerda = false }) {
  const ctx = await prepararGit({ config, caminhos, interativo });
  const { remoto, g } = ctx;
  const { modos } = await sincronizarClone({ config, caminhos, ctx, avisar, criarBranchLocal: true });

  // Guarda de regressão contra o que o remoto TEM de verdade (acabamos de buscar): se outro computador publicou mais, ou o JSON
  // a enviar é menor, só segue com consentimento explícito (a frase ou --accept-history-loss, decidido pelo chamador).
  if (!permitirPerda) {
    const atual = await lerMetricasLimitado(caminhos.clone);
    let ref = null;
    try {
      ref = atual?.texto ? JSON.parse(atual.texto) : null;
    } catch {
      ref = null;
    }
    const refValida = ref && validarMetricas(ref).ok;
    if (atual && !refValida) avisar(AVISO_SEM_REFERENCIA("o metrics.json do repositório de dados é inválido, ilegível ou grande demais"));
    const reg = refValida ? avaliarRegressao(plano.json, ref) : null;
    if (reg) {
      for (const l of linhasDeRegressao(reg)) avisar(l);
      return { enviado: false, bloqueado: true, motivo: "bloqueado pela guarda de regressão: o repositório de dados tem mais histórico que o JSON a enviar. Rode export de novo (sem --no-history/--since/--tool) ou, se for de propósito, confirme a perda de histórico" };
    }
  }

  for (const a of plano.arquivos) await escreverAtomico(caminhos.clone, a.nome, a.conteudo);
  await g(["add", "--", ...ARQUIVOS]);
  if ((await modos()).some((m) => m !== "100644" && m !== "100755")) throw new Error("Modo de arquivo inesperado no índice; recuso o commit.");
  const mudou = await g(["diff", "--cached", "--quiet"]).then(
    () => false,
    () => true,
  );
  if (!mudou) return { enviado: false, motivo: "nada mudou desde o último envio", jaPublicado: true };

  await g(["commit", "--quiet", "--no-verify", "-m", MENSAGEM_DE_COMMIT]);
  // Sem --force e sem refspec com "+": se o remoto avançou, o push é recusado e nada é sobrescrito.
  // O destino é a URL APROVADA (não o nome "origin"): assim um remote.origin.pushurl no clone nunca desvia o envio.
  await g(["push", "--quiet", "--no-verify", remoto, `refs/heads/${config.branch}:refs/heads/${config.branch}`]);
  return { enviado: true };
}

/** metrics.json do clone com leitura limitada de verdade (abre e lê no máximo 5 MiB + 1 byte; recusa link simbólico). */
async function lerMetricasLimitado(clone) {
  return lerArquivoLimitado(join(clone, "metrics.json"));
}

/**
 * Lê (SEM rede e sem rodar nada do clone) o metrics.json do clone local em cache, só se o clone for nosso: marcador de posse válido,
 * .git de verdade, config só com as chaves esperadas, remoto igual ao configurado e branch igual à configurada.
 * @returns {Promise<{ texto: string } | { motivo: string } | null>} null = não há clone nem arquivo
 */
export async function lerMetricasDoClone({ config, caminhos }) {
  let st;
  try {
    st = await lstat(caminhos.clone);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return { motivo: "o clone local é um link simbólico ou não é pasta" };
  if (!(await cloneEhNosso(caminhos.dir, caminhos.clone))) return { motivo: "o clone local não foi criado por esta ferramenta" };
  const ctx = await prepararGit({ config, caminhos, interativo: false });
  const problema = await problemaNoClone({ caminhos, dotGit: ctx.dotGit, remoto: ctx.remoto, env: ctx.env, seguras: ctx.seguras });
  if (problema) return { motivo: problema };
  if (existsSync(ctx.dotGit)) {
    let atual;
    try {
      atual = (await ctx.g(["symbolic-ref", "--short", "HEAD"])).trim();
    } catch {
      return { motivo: "o clone local está sem branch" };
    }
    if (atual !== config.branch) return { motivo: "o clone local está em outra branch" };
  }
  return lerMetricasLimitado(caminhos.clone);
}

/**
 * RESTORE (rede): baixa o último metrics.json publicado com a MESMA maquinaria do publish (remoto validado, ambiente do git limpo,
 * protocolos permitidos, clone marcado, cwd explícito, sem hooks, sem token). Só lê; nunca faz commit nem push.
 * @returns {Promise<{ vazio: boolean, texto?: string, motivo?: string }>}
 */
export async function baixarMetricasPublicadas({ config, caminhos, interativo, avisar = () => {} }) {
  const ctx = await prepararGit({ config, caminhos, interativo });
  const { temRemota } = await sincronizarClone({ config, caminhos, ctx, avisar, criarBranchLocal: false });
  if (!temRemota) return { vazio: true, motivo: "o repositório de dados está vazio (ou não tem a branch configurada)" };
  const r = await lerMetricasLimitado(caminhos.clone);
  if (r === null) return { vazio: true, motivo: "o repositório de dados não tem metrics.json" };
  if (r.motivo) return { vazio: true, motivo: r.motivo };
  return { vazio: false, texto: r.texto };
}
