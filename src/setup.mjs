// Assistente interativo `ai-usage-metrics setup`. Guia do zero até o primeiro painel publicado e o agendamento diário.
// Regras: só roda em terminal; CADA ação externa tem a sua confirmação [s/N] (padrão N); nada é gravado em disco antes do
// resumo final (exceto as prévias locais em <state-dir>/out/preview/); nenhum token é lido, pedido, guardado ou impresso.
// As funções externas (gh, API, npm, schtasks, navegador) vêm de `ambiente.mjs` e são injetáveis (io.externos) nos testes.
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { ADAPTERS } from "./adapters/index.mjs";
import { aggregate, porAtividade, resumo, SEM_PROJETO } from "./aggregate.mjs";
import { binDoRuntime, externosPadrao, idValido, instalacaoInstavel, limparTexto, NOME_TAREFA, pastaDoRuntime, repoValido, usuarioValido } from "./ambiente.mjs";
import { PADROES, lerConfig, normalizarConfig, urlDoRemoto } from "./config.mjs";
import { validarCores, misturar, PADRAO_CLARO } from "./cores.mjs";
import { adquirirLock } from "./lock.mjs";
import { garantirSvgSemVazamento, lerAllowlist, validarAlias, validarTitulo } from "./privacy.mjs";
import { toPublic } from "./public.mjs";
import { exigirMetricasValidas } from "./schema.mjs";
import { IDIOMAS, MODELOS, MODELO_PADRAO, TEMAS, gerarSvg } from "./svg.mjs";

/** Ctrl+C, fim da entrada ou respostas inválidas demais: o assistente sai limpo. */
export class SetupCancelado extends Error {}

const MAX_RESPOSTA = 200;
const MAX_PROJETOS_LISTADOS = 15;
const REPO_PADRAO = "ai-metrics";
const SUFIXO_NOREPLY = "@users.noreply.github.com";
const TITULO_PADRAO = "AI usage";
const LIMITE_TR = 261; // limite do schtasks para o valor de /TR (verificado no Windows 11)

// ---------- paletas (constantes validadas na carga do módulo) ----------

export const PALETAS = Object.freeze([
  { id: "github", nome: "GitHub (padrão, claro e escuro)", claro: null, escuro: null },
  {
    id: "dracula",
    nome: "Dracula",
    claro: { accent: "#9d7cd8" },
    escuro: { background: "#282a36", card: "#343746", border: "#44475a", text: "#f8f8f2", muted: "#a9b0c6", track: "#3d4054", accent: "#bd93f9" },
  },
  {
    id: "nord",
    nome: "Nord",
    claro: { background: "#eceff4", card: "#e5e9f0", border: "#d8dee9", text: "#2e3440", muted: "#4c566a", track: "#d8dee9", accent: "#5e81ac" },
    escuro: { background: "#2e3440", card: "#3b4252", border: "#4c566a", text: "#eceff4", muted: "#a3adc2", track: "#434c5e", accent: "#88c0d0" },
  },
  {
    id: "solarized",
    nome: "Solarized",
    claro: { background: "#fdf6e3", card: "#eee8d5", border: "#d6cdb2", text: "#073642", muted: "#657b83", track: "#e4ddc4", accent: "#b58900" },
    escuro: { background: "#002b36", card: "#073642", border: "#586e75", text: "#eee8d5", muted: "#93a1a1", track: "#0a4150", accent: "#b58900" },
  },
]);
{
  const ids = ADAPTERS.map((a) => a.id);
  for (const p of PALETAS) for (const k of ["claro", "escuro"]) if (p[k]) validarCores(p[k], ids, `${p.id}.${k}`); // constante inválida derruba o módulo, nunca o usuário
}

// ---------- entrada interativa (Ctrl+C / fim da entrada tratados) ----------

/** Leitor de linhas com UM readline para a sessão toda. Ctrl+C e Ctrl+D encerram com SetupCancelado. */
export function ioInterativo(input = process.stdin, output = process.stdout) {
  const rl = createInterface({ input, output });
  let fechado = false;
  const aguardando = new Set();
  rl.on("close", () => {
    fechado = true;
    for (const rej of aguardando) rej(new SetupCancelado("entrada encerrada"));
    aguardando.clear();
  });
  rl.on("SIGINT", () => rl.close());
  return {
    ask(pergunta) {
      if (fechado) return Promise.reject(new SetupCancelado("entrada encerrada"));
      return new Promise((res, rej) => {
        aguardando.add(rej);
        rl.question(pergunta, (r) => {
          aguardando.delete(rej);
          res(r);
        });
      });
    },
    fechar: () => rl.close(),
  };
}

// ---------- utilidades puras ----------

const afirmativa = (r) => /^\s*(s|sim|y|yes)\s*$/i.test(r ?? "");
const negativa = (r) => /^\s*(n|nao|não|no)\s*$/i.test(r ?? "");
const URL_RAW = (u, r, b) => `https://raw.githubusercontent.com/${u}/${r}/${b}`;

/** HH:MM ou H:MM -> "HH:MM" (00:00 a 23:59), ou null. */
export function normalizarHorario(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t));
  if (!m) return null;
  const h = m[1].padStart(2, "0");
  return /^(?:[01]\d|2[0-3])$/.test(h) && Number(m[2]) < 60 ? `${h}:${m[2]}` : null;
}

export const emailNoreply = (login, id) => (id ? `${id}+${login}${SUFIXO_NOREPLY}` : `${login}${SUFIXO_NOREPLY}`);
const ehNoreply = (e) => typeof e === "string" && e.toLowerCase().endsWith(SUFIXO_NOREPLY);
const idDoNoreply = (e, login) => {
  const m = /^(\d{1,15})\+([^@]+)@users\.noreply\.github\.com$/i.exec(e ?? "");
  return m && m[2].toLowerCase() === String(login).toLowerCase() ? Number(m[1]) : null;
};

/** Colunas fixas de um SVG: modelo -> dica de largura para o README do perfil. */
export function trechoMarkdown(url, modelo) {
  return modelo === "model-2" ? `<img src="${url}" width="420" alt="AI usage">` : `![AI usage](${url})`;
}

/** Grava de forma atômica (arquivo temporário na mesma pasta + rename), modo 0600 onde aplicável. */
export async function gravarAtomico(arquivo, texto) {
  await mkdir(resolve(arquivo, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${arquivo}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await writeFile(tmp, texto, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, arquivo);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

async function gravarSimples(arquivo, texto) {
  await mkdir(resolve(arquivo, ".."), { recursive: true, mode: 0o700 });
  await writeFile(arquivo, texto, { encoding: "utf8", mode: 0o600 });
  await chmod(arquivo, 0o600).catch(() => {});
}

const existe = (p) => stat(p).then(() => true, () => false);

/** Monta e VALIDA a configuração (mesmo normalizarConfig do init). Preserva do config atual o que o assistente não pergunta (history, remoteUrl, branch). */
export function montarConfig(d, existente) {
  const bruto = { ...(existente ?? {}) };
  Object.assign(bruto, {
    githubUser: d.githubUser,
    dataRepo: d.dataRepo,
    publicProjects: Array.isArray(d.publicProjects) || Object.keys(d.publicProjects ?? {}).length ? d.publicProjects : [], // vazio = [], como o init
    theme: d.theme,
    lang: d.lang,
    autoPublish: d.autoPublish,
    model: d.model,
  });
  const opcionais = { title: d.title, colors: d.colors, colorsDark: d.colorsDark, commitName: d.commitName, commitEmail: d.commitEmail };
  for (const [k, v] of Object.entries(opcionais)) {
    if (v === undefined) delete bruto[k];
    else bruto[k] = v;
  }
  return normalizarConfig(bruto);
}

const opcoesSvg = (d) => ({ tema: d.theme, titulo: d.title, idioma: d.lang, modelo: d.model, cores: d.colors, coresEscuro: d.colorsDark });

async function* coletar(adapters, ctx) {
  for (const ad of adapters) {
    if (!(await ad.available(ctx))) continue;
    yield* ad.events(ctx);
  }
}

/** Cria (ou substitui) a tarefa diária pelo MESMO código que o teste real usa: comando validado pela ferramenta + schtasks via execFile. */
export async function criarTarefaAgendada({ etapas, ext, nome = NOME_TAREFA, horario, node, bin, argsExtras = [], substituir = false, limite = LIMITE_TR }) {
  const todos = [node, bin, "run", "--non-interactive", ...argsExtras];
  try {
    etapas.schtasksParaCmd(todos, horario); // validação existente: recusa " e os caracteres que o cmd.exe interpretaria
  } catch (e) {
    return { ok: false, motivo: limparTexto(e.message, 240) };
  }
  const tr = etapas.valorTR(todos);
  if (tr.length > limite) return { ok: false, motivo: `o comando da tarefa tem ${tr.length} caracteres e o Agendador do Windows aceita no máximo ${LIMITE_TR} em /TR; use um --state-dir e uma instalação com caminhos mais curtos` };
  const r = await ext.criarTarefa({ nome, horario, tr, substituir });
  return { ...r, tr };
}

// ---------- o assistente ----------

export async function cmdSetup({ args, paths, configPath, home, io, out, etapas }) {
  if (!io.isTTY) {
    out("O assistente `setup` só funciona num terminal interativo; sem terminal (ou com --non-interactive) nada é feito.");
    out("Para automação use o init por flags, por exemplo:  ai-usage-metrics init --user <usuário-github> --public a,b --lang pt-BR");
    return;
  }
  const usaPadrao = io.padrao === true;
  const leitor = usaPadrao ? ioInterativo() : null;
  const ioReal = leitor ? { ...io, ask: leitor.ask, fechar: leitor.fechar } : io;
  const amb = {
    plataforma: process.platform,
    node: process.execPath,
    bin: etapas.bin,
    temp: tmpdir(),
    cores: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    ...(io.ambiente ?? {}),
  };
  amb.versao ??= JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  const ext = io.externos ?? externosPadrao();
  try {
    await new Assistente({ args, paths, configPath, home, io: ioReal, out, etapas, amb, ext }).executar();
  } catch (e) {
    if (!(e instanceof SetupCancelado)) throw e;
    out("");
    out(`Assistente encerrado (${e.message || "cancelado"}). Nada pela metade: a configuração só é gravada depois da confirmação do resumo.`);
  } finally {
    leitor?.fechar();
  }
}

class Assistente {
  constructor(o) {
    Object.assign(this, o);
    const c = this.amb.cores;
    this.neg = (s) => (c ? `\u001b[1m${s}\u001b[22m` : s);
    this.aviso = (s) => (c ? `\u001b[33m${s}\u001b[39m` : s);
    this.d = {};
    this.agg = null;
    this.gh = false; // gh autenticado e consentido nesta sessão
  }

  // ----- perguntas -----
  async ler(prompt) {
    const r = await this.io.ask(prompt);
    if (r === undefined || r === null) throw new SetupCancelado("entrada encerrada");
    return String(r);
  }

  async perguntar(texto, { padrao, rotulo, validar } = {}) {
    for (let i = 0; i < 3; i++) {
      const mostra = rotulo ?? padrao;
      const r = await this.ler(`${texto}${mostra ? ` [${mostra}]` : ""}: `);
      if (r.length > MAX_RESPOSTA) {
        this.out("  Resposta longa demais; tente de novo.");
        continue;
      }
      const t = r.trim();
      const v = t === "" && padrao !== undefined ? padrao : t;
      if (!validar) return v;
      const res = validar(v);
      if (res.ok) return res.valor;
      this.out(`  ${res.erro}`);
    }
    throw new SetupCancelado("respostas inválidas demais");
  }

  /** Confirmação [s/N]: Enter = padrão (N, exceto onde dito); qualquer resposta que não seja claramente "s" vale como "n". */
  async sim(texto, padrao = false) {
    const r = await this.ler(`${texto} ${padrao ? "[S/n]" : "[s/N]"} `);
    if (r.length > MAX_RESPOSTA) return false;
    if (r.trim() === "") return padrao;
    return afirmativa(r) ? true : negativa(r) ? false : false;
  }

  async menu(titulo, opcoes, padrao = 0) {
    this.out(titulo);
    opcoes.forEach((o, i) => this.out(`  ${i + 1}) ${o}`));
    const n = await this.perguntar("Escolha", {
      padrao: String(padrao + 1),
      validar: (v) => (/^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= opcoes.length ? { ok: true, valor: Number(v) - 1 } : { ok: false, erro: `Digite um número de 1 a ${opcoes.length}.` }),
    });
    return n;
  }

  etapa(n, titulo) {
    this.passo = (this.passo ?? 0) + 1; // numeração corrida: passos pulados (reexecução rápida) não deixam buracos
    this.out("");
    this.out(this.neg(n === 0 ? titulo : `Passo ${this.passo}: ${titulo}`));
  }

  async comLock(fn) {
    const liberar = await adquirirLock(this.paths.dir);
    try {
      return await fn();
    } finally {
      await liberar();
    }
  }

  // ----- fluxo -----
  async executar() {
    const { out } = this;
    const ex = await lerConfig(this.configPath).catch((e) => {
      out(this.aviso(`A configuração atual não pôde ser lida (${limparTexto(e.message, 160)}). O assistente começa do zero e, ao gravar, guarda uma cópia .bak.`));
      return null;
    });
    this.existente = ex;

    this.etapa(0, "Boas-vindas");
    out("Este assistente configura o ai-usage-metrics: lê só CONTAGENS das suas ferramentas de IA (nunca conversas) e publica, no SEU repositório público");
    out("de dados, um JSON agregado e 4 SVGs. Projetos saem anonimizados, a menos que você escolha o contrário. Nada é enviado nem agendado sem o seu \"s\".");
    out("Ele vai pedir: usuário do GitHub, repositório de dados, projetos com nome público, modelo/cores, horário do agendamento. Dá para refazer depois (setup de novo).");

    let rapido = false;
    if (ex) {
      this.carregar(ex);
      out("");
      out(`Configuração atual: ${ex.githubUser}/${ex.dataRepo}, modelo ${ex.model ?? MODELO_PADRAO}, ${Object.keys(lerAllowlistSegura(ex, this.home)).length} projeto(s) com nome público.`);
      const o = await this.menu("O que você quer fazer?", ["Rever tudo (Enter mantém o valor atual em cada pergunta)", "Só mudar modelo e cores", "Sair sem mudar nada"], 0);
      if (o === 2) return out("Nada foi alterado.");
      rapido = o === 1;
    } else this.padroes();

    await this.etapaFontes();
    if (!rapido) {
      await this.etapaIdentidade();
      await this.etapaRepositorio();
      await this.etapaProjetos();
    }
    await this.etapaAparencia(rapido);
    if (!rapido) {
      await this.etapaHistorico();
      await this.etapaAgendamento();
    }
    if (!(await this.etapaResumo())) return;
    await this.etapaPublicacao();
    this.etapaFim();
  }

  padroes() {
    Object.assign(this.d, { dataRepo: REPO_PADRAO, publicProjects: {}, model: MODELO_PADRAO, theme: PADROES.theme, lang: PADROES.lang, autoPublish: false });
  }

  carregar(c) {
    this.padroes();
    Object.assign(this.d, {
      githubUser: c.githubUser,
      dataRepo: c.dataRepo,
      publicProjects: c.publicProjects,
      model: c.model ?? MODELO_PADRAO,
      theme: c.theme,
      lang: c.lang,
      autoPublish: c.autoPublish,
      title: c.title,
      colors: c.colors,
      colorsDark: c.colorsDark,
      commitName: c.commitName,
      commitEmail: c.commitEmail,
    });
  }

  // 1) fontes
  async etapaFontes() {
    const { out, home } = this;
    this.etapa(1, "Fontes de dados (leitura local, nada sai do computador)");
    const ctx = { home, since: undefined };
    const meta = ADAPTERS.map(({ id, name, capabilities }) => ({ id, name, capabilities }));
    this.agg = await aggregate(coletar(ADAPTERS, { ...ctx, avisar: () => {} }), { home, tools: meta, avisar: () => {} });
    let achadas = 0;
    for (const a of ADAPTERS) {
      const ok = await a.available(ctx);
      const t = this.agg.tools.get(a.id);
      const s = t ? resumo(t.c).sessions : 0;
      if (ok) achadas++;
      out(`  ${ok ? "encontrada" : "ausente   "}  ${a.name}${ok ? ` (${s} sessões)` : ""}`);
    }
    if (!achadas) {
      out("Nenhuma fonte foi encontrada neste computador, então o painel sairia vazio. Se as ferramentas guardam dados em outro lugar, use --home <pasta>.");
      if (!(await this.sim("Continuar mesmo assim?"))) throw new SetupCancelado("sem fontes de dados");
    }
  }

  // 2) identidade
  async etapaIdentidade() {
    const { out, d, ext } = this;
    this.etapa(2, "Identidade no GitHub");
    out("O commit público usa SOMENTE o e-mail noreply do GitHub (ID+usuario@users.noreply.github.com). Para usar outro e-mail, edite \"commitEmail\" no config.json depois (veja SECURITY.md).");
    let login = null;
    let id = null;
    if (await this.sim("Consultar o gh instalado, executando `gh api user` (usa o login do próprio gh; esta ferramenta não lê token)?")) {
      const r = await ext.ghUsuario();
      if (r.estado === "ok" && usuarioValido(r.login) && idValido(r.id)) {
        out(`  O gh está autenticado como ${r.login} (id ${r.id}).`);
        if (await this.sim("Usar esta conta?", true)) {
          login = r.login;
          id = r.id;
          this.gh = true;
        }
      } else if (r.estado === "ausente") out("  O gh não foi encontrado; seguimos pelo caminho manual.");
      else if (r.estado === "sem-login") out("  O gh existe, mas não está autenticado (rode `gh auth login` se quiser usá-lo); seguimos pelo caminho manual.");
      else out("  A resposta do gh não pôde ser usada; seguimos pelo caminho manual.");
    }
    if (!login) {
      login = await this.perguntar("Seu usuário do GitHub", {
        padrao: this.existente?.githubUser,
        validar: (v) => (usuarioValido(v) ? { ok: true, valor: v } : { ok: false, erro: "Usuário inválido (letras, números e hífen, até 39 caracteres)." }),
      });
      id = d.commitEmail && login.toLowerCase() === String(d.githubUser).toLowerCase() ? idDoNoreply(d.commitEmail, login) : null;
      if (!id && (await this.sim(`Consultar a API pública do GitHub (um GET em https://api.github.com/users/${login}, sem credenciais) para descobrir o seu ID numérico?`))) {
        const r = await ext.apiUsuario(login);
        if (r.estado === "ok" && usuarioValido(r.login) && idValido(r.id)) {
          login = r.login;
          id = r.id;
          out(`  Encontrado: ${login} (id ${id}).`);
        } else out(`  ${r.estado === "inexistente" ? "O GitHub diz que esse usuário não existe." : `Não consegui consultar (${limparTexto(r.motivo ?? "erro", 60)}).`}`);
      }
      if (!id) {
        out(`  Seu ID aparece em https://api.github.com/users/${login} (campo "id") e em Settings > Emails.`);
        const bruto = await this.perguntar("ID numérico (Enter = continuar sem ID)", {
          padrao: "",
          rotulo: "",
          validar: (v) => (v === "" ? { ok: true, valor: "" } : /^[1-9]\d{0,14}$/.test(v) && idValido(Number(v)) ? { ok: true, valor: v } : { ok: false, erro: "O ID deve ser um número inteiro positivo." }),
        });
        id = bruto ? Number(bruto) : null;
      }
    }
    if (!id) {
      out(this.aviso("  Aviso: sem o ID, em contas novas o e-mail noreply do GitHub pode não vincular os commits ao seu perfil (o painel funciona igual)."));
    }
    const mudouUsuario = d.githubUser && d.githubUser.toLowerCase() !== login.toLowerCase();
    if (d.commitEmail && !ehNoreply(d.commitEmail) && !mudouUsuario) {
      out(`  Mantido o commitEmail personalizado da configuração atual (o assistente nunca grava outro e-mail pessoal): ${d.commitEmail}`);
    } else {
      if (d.commitEmail && !ehNoreply(d.commitEmail)) out(this.aviso("  O commitEmail personalizado anterior foi removido porque o usuário mudou."));
      d.githubUser = login;
      if (id) {
        d.commitName = login;
        d.commitEmail = emailNoreply(login, id);
      } else {
        delete d.commitName;
        delete d.commitEmail;
      }
    }
    d.githubUser = login;
    d.githubId = id;
    out(`  Autor do commit: ${d.commitName ?? login} <${d.commitEmail ?? emailNoreply(login, null)}>`);
  }

  // 3) repositório de dados
  async etapaRepositorio() {
    const { out, d, ext } = this;
    this.etapa(3, "Repositório de dados (PÚBLICO)");
    if (this.existente?.remoteUrl) {
      out(`  A configuração usa um remoto próprio (${limparTexto(this.existente.remoteUrl, 120)}); ele é mantido e as verificações de repositório são puladas.`);
      d.repoEstado = "personalizado";
      return;
    }
    d.dataRepo = await this.perguntar("Nome do repositório de dados", { padrao: d.dataRepo ?? REPO_PADRAO, validar: (v) => (repoValido(v) ? { ok: true, valor: v } : { ok: false, erro: "Nome inválido (letras, números, . _ -; até 100)." }) });
    const alvo = `${d.githubUser}/${d.dataRepo}`;
    d.repoEstado = "desconhecido";
    let r = null;
    if (this.gh) {
      if (await this.sim(`Consultar o repositório com \`gh repo view ${alvo}\` (rede, via gh)?`)) r = await ext.ghRepo(d.githubUser, d.dataRepo);
    } else if (await this.sim(`Consultar a API pública do GitHub (GET https://api.github.com/repos/${alvo}, sem credenciais; um repositório privado aparece como inexistente)?`)) {
      r = await ext.apiRepo(d.githubUser, d.dataRepo);
    }
    if (r?.estado === "existe" && r.privado === false) {
      d.repoEstado = "publico";
      out("  O repositório existe e é público: ok.");
    } else if (r?.estado === "existe" && r.privado === true) {
      d.repoEstado = "privado";
      out(this.aviso("  O repositório existe, mas é PRIVADO: a imagem não aparecerá no README para outras pessoas. Deixe-o público se quer exibir o painel."));
    } else if (r?.estado === "inexistente") {
      d.repoEstado = "inexistente";
      out(`  Não encontrei ${alvo}${this.gh ? "" : " publicamente (não existe ou é privado)"}.`);
    } else if (r) out(`  Não consegui verificar (${limparTexto(r.motivo ?? r.estado, 60)}).`);
    if (d.repoEstado === "inexistente" || d.repoEstado === "desconhecido") {
      if (this.gh && d.repoEstado === "inexistente") {
        d.criarRepo = await this.sim(`Criar o repositório PÚBLICO e VAZIO ${alvo} com \`gh repo create ${alvo} --public --description ...\`? Qualquer pessoa poderá vê-lo. (Será feito só depois do resumo.)`);
      }
      if (!d.criarRepo) {
        out(`  Passo manual: abra https://github.com/new e crie ${alvo} como PÚBLICO, sem README, .gitignore nem licença.`);
        d.criouManual = await this.sim("Você já criou (ou vai criar antes de publicar) o repositório?");
      }
    }
  }

  // 4) projetos com nome público
  async etapaProjetos() {
    const { out, d, home } = this;
    this.etapa(4, "Projetos com nome público");
    const linhas = [...this.agg.projetos.values()]
      .filter((p) => p.name !== SEM_PROJETO)
      .map((p) => ({ p, name: p.name, ...resumo(p.c) }))
      .sort(porAtividade)
      .slice(0, MAX_PROJETOS_LISTADOS);
    const atual = Object.keys(lerAllowlistSegura({ publicProjects: d.publicProjects }, home));
    out("Por padrão TODOS saem anonimizados (projeto-privado-N). Um nome público fica PERMANENTE no histórico do GitHub, mesmo que você o remova depois.");
    if (!linhas.length) {
      out("  Nenhum projeto detectado; nada para tornar público.");
      return;
    }
    out("Pastas detectadas (nomes reais, só neste terminal):");
    linhas.forEach((l, i) => out(`  ${String(i + 1).padStart(2)}) ${limparTexto(l.name, 50)}  (${l.userMessages} mensagens, ${l.sessions} sessões)`));
    const dica = atual.length ? `Enter = manter os atuais (${atual.length}); "nenhum" limpa` : 'Enter = nenhum';
    const resp = await this.perguntar(`Quais podem aparecer COM NOME? Números separados por vírgula (${dica})`, {
      padrao: atual.length ? "manter" : "nenhum",
      rotulo: "",
      validar: (v) => {
        if (/^(nenhum|manter)$/i.test(v)) return { ok: true, valor: v.toLowerCase() };
        if (!/^\d{1,2}(?:\s*,\s*\d{1,2})*$/.test(v)) return { ok: false, erro: 'Use números separados por vírgula, "nenhum" ou "manter".' };
        const n = [...new Set(v.split(",").map((x) => Number(x.trim())))];
        return n.every((x) => x >= 1 && x <= linhas.length) ? { ok: true, valor: n } : { ok: false, erro: `Os números vão de 1 a ${linhas.length}.` };
      },
    });
    if (resp === "manter") return;
    if (resp === "nenhum") {
      d.publicProjects = {};
      return;
    }
    const nomes = linhas.map((l) => l.name.toLowerCase());
    const novo = {};
    const usados = new Set();
    for (const n of resp) {
      const l = linhas[n - 1];
      let padrao = "";
      try {
        padrao = validarAlias(l.name, home);
      } catch {
        /* o nome real não serve como nome público: o usuário digita outro */
      }
      const alias = await this.perguntar(`Nome público para "${limparTexto(l.name, 50)}"`, {
        padrao,
        validar: (v) => {
          try {
            validarAlias(v, home);
          } catch (e) {
            return { ok: false, erro: limparTexto(e.message.replace(/"[^"]*"/, "esse nome"), 160) };
          }
          return usados.has(v.toLowerCase()) ? { ok: false, erro: "Esse nome público já foi usado nesta lista." } : { ok: true, valor: v };
        },
      });
      usados.add(alias.toLowerCase());
      novo[nomes.filter((x) => x === l.name.toLowerCase()).length > 1 ? l.p.caminho : l.name] = alias;
    }
    lerAllowlist({ publicProjects: novo }, { home }); // mesma validação do publish (repetidos, controle...)
    d.publicProjects = novo;
  }

  // 5) modelo, cores, título, idioma, tema
  async etapaAparencia(rapido) {
    const { out, d, home, paths } = this;
    this.etapa(5, "Modelo e cores");
    out("  model-1  painel completo (840x440): cartões, sessões por mês e ranking de projetos");
    out("  model-2  cartão estreito (420 de largura): números e barra empilhada por ferramenta");
    out("  model-3  calendário de atividade (807x262), estilo contribuições do GitHub");
    const previa = async (abrir) => {
      try {
        const arquivos = await this.gerarPrevia();
        out(this.previaMostrada ? "  Prévias atualizadas." : `  Prévias (locais, com os SEUS dados) em ${join(paths.saida, "preview")}`);
        this.previaMostrada = true;
        if (abrir && this.amb.plataforma === "win32" && (await this.sim("Abrir as prévias no navegador (executa o explorer com os 3 arquivos)?"))) for (const a of arquivos) await this.ext.abrir(a);
        else if (abrir && this.amb.plataforma !== "win32") for (const a of arquivos) out(`    ${a}`);
      } catch (e) {
        out(this.aviso(`  Não consegui gerar a prévia (${limparTexto(e.message, 160)}). Siga sem ela.`));
      }
    };
    await previa(true);
    d.model = MODELOS[await this.menu("Modelo do metrics.svg:", MODELOS, Math.max(0, MODELOS.indexOf(d.model)))];
    const opcoes = [...PALETAS.map((p) => p.nome), "Personalizar (destaque e fundos em hexadecimal)"];
    if (d.colors || d.colorsDark) opcoes.unshift("Manter as cores atuais");
    const temAtuais = Boolean(d.colors || d.colorsDark);
    for (;;) {
      const i = await this.menu("Cores:", opcoes, 0);
      const k = temAtuais ? i - 1 : i;
      if (k >= 0 && k < PALETAS.length) {
        d.colors = PALETAS[k].claro ? validarCores(PALETAS[k].claro, ADAPTERS.map((a) => a.id)) : undefined;
        d.colorsDark = PALETAS[k].escuro ? validarCores(PALETAS[k].escuro, ADAPTERS.map((a) => a.id)) : undefined;
      } else if (k === PALETAS.length) await this.coresPersonalizadas();
      await previa(false);
      if (await this.sim("Gostou do resultado?", true)) break;
    }
    if (rapido) return;
    d.lang = await this.perguntar(`Idioma (${IDIOMAS.join("/")})`, { padrao: d.lang, validar: (v) => (IDIOMAS.includes(v) ? { ok: true, valor: v } : { ok: false, erro: `Use ${IDIOMAS.join(" ou ")}.` }) });
    d.theme = await this.perguntar(`Tema (${TEMAS.join("/")})`, { padrao: d.theme, validar: (v) => (TEMAS.includes(v) ? { ok: true, valor: v } : { ok: false, erro: `Use ${TEMAS.join(", ")}.` }) });
    const padraoTitulo = d.lang === "pt-BR" ? "Uso de IA" : TITULO_PADRAO;
    const t = await this.perguntar(`Título do painel (até 60 caracteres; Enter = ${d.title ? "manter o atual" : `padrão "${padraoTitulo}"`})`, {
      padrao: d.title ?? "",
      rotulo: d.title ?? "",
      validar: (v) => {
        if (v === "") return { ok: true, valor: undefined };
        try {
          validarTitulo(v, home);
          return { ok: true, valor: v };
        } catch (e) {
          return { ok: false, erro: limparTexto(e.message.replace(/"[^"]*"/g, "o texto"), 160) };
        }
      },
    });
    d.title = t;
    await previa(false);
  }

  async coresPersonalizadas() {
    const { d } = this;
    const hex = (rotulo) => this.perguntar(`${rotulo} em hexadecimal (#rgb ou #rrggbb; Enter = padrão)`, {
      padrao: "",
      rotulo: "",
      validar: (v) => {
        if (v === "") return { ok: true, valor: "" };
        try {
          return { ok: true, valor: validarCores({ accent: v }, [], "cor").accent };
        } catch (e) {
          return { ok: false, erro: limparTexto(e.message, 120) };
        }
      },
    });
    const destaque = await hex("Cor de destaque");
    const claro = await hex("Fundo do tema claro");
    const escuro = await hex("Fundo do tema escuro");
    const montar = (fundo) => {
      const o = {};
      if (destaque) o.accent = destaque;
      if (fundo) {
        o.background = fundo;
        o.card = misturar(fundo, destaque || PADRAO_CLARO.accent, 0.06);
      }
      return Object.keys(o).length ? validarCores(o, []) : undefined;
    };
    d.colors = montar(claro);
    d.colorsDark = montar(escuro);
    this.out(this.aviso("  Atenção: legibilidade é por sua conta (o texto mantém as cores padrão do tema)."));
  }

  /** Gera os 3 SVGs de prévia com os dados reais em <state-dir>/out/preview/ (local). Devolve os caminhos. */
  async gerarPrevia() {
    const { d, home, paths } = this;
    const allow = lerAllowlist({ publicProjects: d.publicProjects }, { home });
    const json = toPublic(this.agg, { allowlist: allow, home, avisar: () => {} });
    exigirMetricasValidas(json);
    const arquivos = [];
    const svgs = MODELOS.map((m) => {
      const svg = gerarSvg(json, { ...opcoesSvg(d), modelo: m });
      garantirSvgSemVazamento(svg, home);
      return [join(paths.saida, "preview", `metrics.${m}.svg`), svg];
    });
    await this.comLock(async () => {
      for (const [arq, svg] of svgs) {
        await gravarSimples(arq, svg);
        arquivos.push(arq);
      }
    });
    return arquivos;
  }

  // 6) histórico
  async etapaHistorico() {
    const { out, d } = this;
    if (!["publico", "privado", "desconhecido"].includes(d.repoEstado) || (await existe(this.paths.historico))) return;
    this.etapa(6, "Histórico (computador novo)");
    out("Se você já publicou deste repositório em outro computador, dá para recuperar o histórico para o gráfico não recomeçar do zero.");
    if (!(await this.sim("Este é um computador novo, e o repositório já tem um painel publicado?"))) return;
    d.restore = await this.sim(`Executar o restore depois do resumo: baixar o último metrics.json de ${urlDoRemoto({ githubUser: d.githubUser, dataRepo: d.dataRepo })} com git (REDE)?`);
  }

  // 7) agendamento
  async etapaAgendamento() {
    const { out, d, amb, args } = this;
    this.etapa(7, "Agendamento diário");
    d.horario = await this.perguntar("Horário da atualização diária (HH:MM)", {
      padrao: "12:00",
      validar: (v) => {
        const h = normalizarHorario(v);
        return h ? { ok: true, valor: h } : { ok: false, erro: "Horário inválido (use HH:MM, de 00:00 a 23:59)." };
      },
    });
    out('  autoPublish: com ele ligado, a tarefa agendada também ENVIA o painel, mas só depois da aprovação do primeiro publish manual (passo 9) e enquanto destino, autor e nomes públicos não mudarem.');
    d.autoPublish = await this.sim("Ligar o autoPublish?", this.existente?.autoPublish === true);
    const instavel = instalacaoInstavel(amb.bin, { temp: amb.temp });
    d.binAgenda = amb.bin;
    d.argsExtras = [...(args["state-dir"] ? ["--state-dir", resolve(args["state-dir"])] : []), ...(args.config ? ["--config", this.configPath] : []), ...(args.home ? ["--home", this.home] : [])];
    if (amb.plataforma !== "win32") {
      out("  Neste sistema o assistente NÃO cria o agendamento: ao final imprime a linha de cron (não validada pelo autor; só o Windows foi testado).");
      d.semTarefa = true;
      return;
    }
    if (instavel) {
      out(this.aviso(`  O pacote está rodando de um cache temporário (${limparTexto(amb.bin, 100)}). Uma tarefa apontando para lá QUEBRARIA quando o cache for limpo.`));
      const alvo = pastaDoRuntime(this.home);
      if (await this.sim(`Instalar uma cópia fixa na versão ${amb.versao} em ${alvo} com \`npm install --prefix\` (REDE: baixa do registro do npm) e agendar a partir dela?`)) {
        d.instalarRuntime = true;
        d.binAgenda = binDoRuntime(this.home);
      } else {
        out("  Sem a cópia fixa, a tarefa não será criada (instale com `npm install -g ai-usage-metrics` e rode o setup de novo).");
        d.semTarefa = true;
        return;
      }
    }
    if (await this.sim(`Criar a tarefa diária "${NOME_TAREFA}" no Agendador de Tarefas do Windows, às ${d.horario}, rodando \`run --non-interactive\`?`)) {
      d.criarTarefa = true;
      if (await this.ext.tarefaExiste(NOME_TAREFA)) {
        out(this.aviso(`  Já existe uma tarefa "${NOME_TAREFA}".`));
        d.substituirTarefa = await this.sim("Substituir a tarefa existente?");
        if (!d.substituirTarefa) d.criarTarefa = false;
      }
    }
  }

  // 8) resumo e gravação
  async etapaResumo() {
    const { out, d } = this;
    this.etapa(8, "Resumo");
    let config;
    try {
      config = montarConfig(d, this.existente);
    } catch (e) {
      throw new Error(`A configuração montada é inválida (${limparTexto(e.message, 200)}); nada foi gravado.`);
    }
    this.config = config;
    const nomes = Object.values(lerAllowlistSegura(config, this.home));
    out(`  Usuário/repositório: ${config.githubUser}/${config.dataRepo} (${d.repoEstado ?? "mantido"})`);
    out(`  Autor do commit: ${config.commitName ?? config.githubUser} <${config.commitEmail ?? emailNoreply(config.githubUser, null)}>`);
    out(`  Projetos com nome público: ${nomes.length ? nomes.join(", ") : "nenhum (todos anonimizados)"}`);
    out(`  Modelo ${config.model}, idioma ${config.lang}, tema ${config.theme}, título ${config.title ? `"${config.title}"` : "padrão"}`);
    out(`  Cores: ${config.colors || config.colorsDark ? "personalizadas" : "padrão"}; autoPublish: ${config.autoPublish ? "ligado" : "desligado"}`);
    const acoes = [];
    if (d.criarRepo) acoes.push(`criar o repositório PÚBLICO ${config.githubUser}/${config.dataRepo} com o gh`);
    if (d.restore) acoes.push("restore do histórico (rede, git)");
    if (d.instalarRuntime) acoes.push(`npm install da cópia fixa em ${pastaDoRuntime(this.home)} (rede)`);
    if (d.criarTarefa) acoes.push(`${d.substituirTarefa ? "SUBSTITUIR" : "criar"} a tarefa "${NOME_TAREFA}" às ${d.horario}`);
    out(`  Vai gravar: ${this.configPath}${this.existente ? " (cópia anterior em config.json.bak)" : ""}`);
    out(`  Ações marcadas: ${acoes.length ? acoes.join("; ") : "nenhuma"}`);
    if (!(await this.sim("Gravar a configuração e executar as ações marcadas?"))) {
      out("Nada foi gravado nem executado (só as prévias locais em out/preview). Rode `setup` de novo quando quiser.");
      return false;
    }
    await this.executarAcoes(config);
    return true;
  }

  async executarAcoes(config) {
    const { out, d, ext } = this;
    this.pronto = true; // a publicação só segue se o destino existir
    await this.comLock(async () => {
      if (await existe(this.configPath)) {
        await copyFile(this.configPath, `${this.configPath}.bak`);
        await chmod(`${this.configPath}.bak`, 0o600).catch(() => {});
      }
      await gravarAtomico(this.configPath, JSON.stringify(config, null, 2) + "\n");
      out(`Configuração gravada em ${this.configPath}`);
      if (d.criarRepo) {
        const r = await ext.ghCriarRepo(config.githubUser, config.dataRepo);
        if (r.ok) out(`Repositório público ${config.githubUser}/${config.dataRepo} criado (vazio).`);
        else {
          this.pronto = false;
          out(this.aviso(`Não consegui criar o repositório (${limparTexto(r.motivo ?? "erro", 160)}). Crie-o à mão em https://github.com/new (público, vazio) antes de publicar.`));
        }
      }
      if (d.restore) {
        try {
          await this.etapas.cmdRestore({ args: { yes: true }, config, paths: this.paths, home: this.home, io: this.io, out });
        } catch (e) {
          out(this.aviso(`restore não concluído: ${limparTexto(e.message, 200)}`));
        }
      }
      let bin = d.binAgenda;
      if (d.instalarRuntime) {
        const r = await ext.npmInstalar({ prefixo: pastaDoRuntime(this.home), versao: this.amb.versao });
        if (r.ok) {
          bin = r.bin;
          out(`Cópia fixa instalada em ${pastaDoRuntime(this.home)}.`);
        } else {
          d.criarTarefa = false;
          out(this.aviso(`Não consegui instalar a cópia fixa (${limparTexto(r.motivo ?? "erro", 160)}); a tarefa NÃO foi criada.`));
        }
      }
      if (d.criarTarefa) {
        let substituir = false;
        if (await ext.tarefaExiste(NOME_TAREFA)) {
          substituir = d.substituirTarefa === true && (await this.sim(`Reconfirmando: SUBSTITUIR a tarefa existente "${NOME_TAREFA}"?`));
          if (!substituir) {
            out("Tarefa existente mantida (nada foi alterado no agendador).");
            return;
          }
        }
        const r = await criarTarefaAgendada({ etapas: this.etapas, ext, horario: d.horario, node: this.amb.node, bin, argsExtras: d.argsExtras, substituir, limite: this.amb.limiteTr });
        out(r.ok ? `Tarefa "${NOME_TAREFA}" criada: diária às ${d.horario}.` : this.aviso(`Não consegui criar a tarefa (${limparTexto(r.motivo ?? "erro", 200)}). Use as instruções impressas ao final.`));
        if (!r.ok) d.tarefaFalhou = true;
      }
    });
  }

  // 9) primeira publicação
  async etapaPublicacao() {
    const { out, paths, home, etapas, config } = this;
    this.etapa(9, "Primeira publicação");
    if (this.pronto === false) {
      out("  Pulada: o repositório de dados ainda não existe. Crie-o e rode `ai-usage-metrics publish` num terminal.");
      return;
    }
    out("Vou gerar o JSON e os SVGs e mostrar exatamente o que ficaria PÚBLICO (dry-run). Depois você decide se publica; é o mesmo `publish` manual.");
    this.publicou = false;
    try {
      await this.comLock(async () => {
        await etapas.etapaExport({ adapters: ADAPTERS, ctx: { home, since: undefined }, home, config, destino: paths.json, paths, out, historico: config.history !== false });
        await etapas.etapaRender({ jsonPath: paths.json, svgPath: paths.svg, dirModelos: paths.saida, opcoes: opcoesSvg(config), home, out });
        const r = await etapas.etapaPublish({ config, paths, jsonPath: paths.json, home, yes: false, dryRun: false, aceitaEmail: false, io: this.io, out, modo: "manual" });
        this.publicou = Boolean(r?.enviado || r?.jaPublicado);
      });
    } catch (e) {
      out(this.aviso(`A publicação não foi concluída: ${limparTexto(e.message, 240)}`));
    }
    if (!this.publicou) {
      out('  Nada foi publicado. Para aprovar depois, rode `ai-usage-metrics publish` neste terminal, confira o dry-run e confirme (isso também aprova o envio automático).');
      if (config.autoPublish) out(this.aviso("  Enquanto isso o autoPublish fica bloqueado (ele exige um publish manual confirmado)."));
    }
  }

  // 10) fim
  etapaFim() {
    const { out, config, d } = this;
    this.etapa(10, "Pronto");
    const base = URL_RAW(config.githubUser, config.dataRepo, config.branch);
    out("URLs dos 4 SVGs:");
    for (const a of ["metrics.svg", ...MODELOS.map((m) => `metrics.${m}.svg`)]) out(`  ${base}/${a}`);
    out(`Cole no README do seu perfil (repositório ${config.githubUser}/${config.githubUser})${config.model === "model-2" ? " (model-2: width de 420 px)" : " (largura total)"}:`);
    out(`  ${trechoMarkdown(`${base}/metrics.svg`, config.model)}`);
    if (d.repoEstado === "privado") out(this.aviso("  Lembrete: o repositório é privado; a imagem não aparecerá para os outros."));
    if (d.semTarefa || d.tarefaFalhou || this.amb.plataforma !== "win32") {
      out("");
      out(this.etapas.instrucoesDeAgendamento({ stateDir: this.args["state-dir"] ? resolve(this.args["state-dir"]) : null, configPath: this.args.config ? this.configPath : null, node: this.amb.node, bin: d.binAgenda ?? this.amb.bin, horario: d.horario ?? "12:00" }));
    }
    out("");
    out("Para refazer: `ai-usage-metrics setup` de novo (os valores atuais viram o padrão). Para mudar cores/modelo à mão, edite \"colors\", \"colorsDark\" e \"model\" no config.json (veja docs/modelos.md).");
    out(`Para remover a tarefa agendada: schtasks /Delete /TN "${NOME_TAREFA}"`);
  }
}

/** lerAllowlist que nunca lança (para só MOSTRAR escolhas): devolve { pasta: alias }. */
function lerAllowlistSegura(config, home) {
  try {
    return Object.fromEntries(lerAllowlist(config, { home }));
  } catch {
    return {};
  }
}
