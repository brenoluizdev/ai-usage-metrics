#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { ADAPTERS } from "./adapters/index.mjs";
import { aggregate } from "./aggregate.mjs";
import { PADROES, autorDoCommit, caminhos, gravarConfig, gravarEstado, lerConfig, lerEstado, normalizarConfig, normalizarRemoto, pastaPadrao, urlDoRemoto, validarStateDir } from "./config.mjs";
import { adquirirLock } from "./lock.mjs";
import { ARQUIVO_HISTORICO, apagarHistorico, carregarBaseline, gravarBaseline, gravarHistoricoMonotonico, lerArquivoLimitado, linhasDoHistorico, mesclarBaselines, mesclarHistorico, motivoCaminhoDeRede, normalizarMotivos, normalizarResumoGravado, validarTextoDeBaseline } from "./historico.mjs";
import { FRASE_PERDA, MOTIVOS_VALIDOS, linhasDeRegressao, piorRegressao } from "./regressao.mjs";
import { garantirSemVazamento, garantirSvgSemVazamento, lerAllowlist, validarTitulo } from "./privacy.mjs";
import { baixarMetricasPublicadas, descreverPlano, enviar, planejar, semCredenciais } from "./publish.mjs";
import { toPublic } from "./public.mjs";
import { renderTerminal } from "./report.mjs";
import { exigirMetricasValidas } from "./schema.mjs";
import { IDIOMAS, MODELOS, MODELO_PADRAO, TEMAS, gerarSvg } from "./svg.mjs";

const COMANDOS = ["sources", "report", "export", "render", "publish", "init", "run", "restore", "history"];
const BOOLEANAS = ["help", "yes", "dry-run", "overwrite", "accept-public-email", "non-interactive", "no-history", "accept-history-loss"];
const BIN = fileURLToPath(new URL("../bin/ai-usage-metrics.mjs", import.meta.url));

const FRASE_PERDA_AJUDA = "publicar com perda de histórico";
const AJUDA = `ai-usage-metrics: mede o uso das suas ferramentas de IA (100% local, só leitura, sem IA no meio).

Uso: ai-usage-metrics <comando> [opções]

Comandos
  sources   lista as fontes e se existem neste computador
  report    resumo no terminal (mostra nomes reais de projetos: não publique)
  export    gera o JSON agregado e anonimizado (esquema v1)
  render    gera os SVGs (3 modelos) a partir do JSON
  publish   DRY-RUN por padrão: mostra o que seria enviado ao seu repositório de dados
            (metrics.json, metrics.svg e metrics.model-1/2/3.svg);
            só envia com confirmação (--yes ou pergunta interativa)
  init      cria a configuração local e imprime o trecho de README e o agendamento
  run       export -> render -> publish numa etapa (para o agendador)
  history   "history reset": apaga o history.json local (só com confirmação [s/N] ou --yes); o histórico publicado não é tocado
  restore   computador novo: baixa o último metrics.json publicado no SEU repositório de dados e o grava como histórico local
            (history.json); é uma etapa de REDE e pede confirmação (--yes). --from-file <json> faz o mesmo 100% offline

Opções gerais
  --state-dir <pasta>       configuração, estado, clone e saídas (padrão ~/.ai-usage-metrics)
  --config <arquivo>        configuração (padrão <state-dir>/config.json)
  --home <pasta>            pasta do usuário de onde ler as fontes (para testes)
  --since <30d|AAAA-MM-DD>  considera só atividade a partir de
  --tool <id>               limita a uma ferramenta (repetível)
  --top <n>                 tamanho do ranking no report (padrão 10)

export:   --out <arquivo>   (padrão <state-dir>/out/metrics.json)
          --no-history      não mescla a série diária com o último JSON publicado (history.json) só nesta execução
                            (configuração: "history": false desliga sempre). --since também desliga a mescla.
render:   --input <json> --theme auto|light|dark --title <texto> --lang en|pt-BR --model model-1|model-2|model-3
          sem --out: grava metrics.svg (o modelo escolhido; padrão: "model" da configuração ou model-1) e também
          metrics.model-1.svg, metrics.model-2.svg e metrics.model-3.svg em <state-dir>/out
          --out <arquivo.svg>   grava SÓ esse arquivo (um único modelo)
          --out-dir <pasta>     grava o conjunto completo (os 4 SVGs) nessa pasta
          As cores vêm da configuração ("colors" e "colorsDark", só hexadecimal #rgb ou #rrggbb).
publish:  --input <json> --yes (envia sem perguntar) --dry-run (nunca envia nem pergunta)
          --accept-public-email (sem terminal: aceita publicar um e-mail que não é noreply do GitHub)
          --accept-history-loss (sem terminal: aceita publicar um JSON MENOR que o histórico; em terminal pede a frase
                            "publicar com perda de histórico"; o envio automático nunca aceita)
init:     --user <usuário GitHub> --repo <nome> --branch <nome> --public a,b --theme --lang --title --remote <url> --overwrite
          --model model-1|model-2|model-3  --colors '{"accent":"#22c55e"}'  --colors-dark '{"background":"#1a1033"}'
restore:  --yes (sem perguntar [s/N]) --from-file <json> (offline; sem rede e sem confirmação)
run:      aceita as opções do export (--no-history); em modo não interativo só envia se autoPublish for true e houver um publish manual confirmado
          --non-interactive (nunca pergunta nada, mesmo que haja um console: use no agendador; o Agendador do Windows
          dá um console ao processo, e sem esta opção o "run" esperaria a resposta de [s/N] para sempre)
`;

function lerArgs(argv) {
  const a = { _: [], tool: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (!x.startsWith("--")) a._.push(x);
    else if (BOOLEANAS.includes(x.slice(2))) a[x.slice(2)] = true;
    else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Falta o valor de ${x}.`);
      if (x === "--tool") a.tool.push(v);
      else a[x.slice(2)] = v;
    }
  }
  return a;
}

function parseSince(v) {
  if (!v) return undefined;
  const m = /^(\d+)d$/.exec(v);
  if (m) return Date.now() - Number(m[1]) * 86_400_000;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`--since inválido: ${v} (use 30d ou AAAA-MM-DD).`);
  return t;
}

async function* coletar(adapters, ctx) {
  for (const ad of adapters) {
    if (!(await ad.available(ctx))) continue;
    yield* ad.events(ctx);
  }
}

/** Interação padrão no terminal. Injetável nos testes. */
export function ioPadrao() {
  return {
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async ask(pergunta) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(pergunta);
      } finally {
        rl.close();
      }
    },
  };
}

const afirmativa = (r) => /^\s*(s|sim|y|yes)\s*$/i.test(r ?? "");

async function lerJsonDoDisco(arquivo) {
  try {
    return JSON.parse(await readFile(arquivo, "utf8"));
  } catch (e) {
    throw new Error(`Não consegui ler um JSON válido em ${arquivo}: ${e.code === "ENOENT" ? "arquivo não existe" : e.message}.`);
  }
}

async function gravar(arquivo, texto) {
  await mkdir(dirname(arquivo), { recursive: true, mode: 0o700 }); // pastas novas só do usuário (Linux/macOS); no Windows valem as ACLs do perfil
  // 0600 ao criar (Linux/macOS) e de novo se já existia; no Windows o modo quase não tem efeito (valem as ACLs do perfil).
  await writeFile(arquivo, texto, { encoding: "utf8", mode: 0o600 });
  await chmod(arquivo, 0o600).catch(() => {});
}

// ---------- etapas reutilizadas por export, render, publish e run ----------

/** Avisos não fatais (dados descartados, pastas homônimas...). Sem caminhos nem nomes reais de projeto. */
function novosAvisos() {
  const lista = new Set();
  return { lista, avisar: (m) => lista.add(String(m)) };
}

/** O avisos.json é só um arquivo local: o texto pode ter sido adulterado. Sem sequências ANSI/OSC nem caracteres de controle, até 300 caracteres. */
export function limparAviso(t) {
  return String(t)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "") // OSC (título da janela, links)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "") // CSI (cores, cursor)
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

async function lerAvisosDoExport(paths) {
  try {
    const l = JSON.parse(await readFile(join(paths.saida, "avisos.json"), "utf8"));
    return Array.isArray(l) ? l.filter((x) => typeof x === "string").slice(0, 20).map(limparAviso).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function lerResumoDoHistorico(paths) {
  try {
    const b = JSON.parse(await readFile(join(paths.saida, "historico.json"), "utf8"));
    return { hist: normalizarResumoGravado(b), motivos: normalizarMotivos(b) };
  } catch {
    return { hist: null, motivos: [] };
  }
}

async function etapaExport({ adapters, ctx, home, config, destino, paths, out, historico = true, motivos = [] }) {
  const meta = adapters.map(({ id, name, capabilities }) => ({ id, name, capabilities }));
  const { lista, avisar } = novosAvisos();
  const agg = await aggregate(coletar(adapters, { ...ctx, avisar }), { home, tools: meta, avisar });
  if (!config) out("Aviso: sem configuração; todos os projetos serão anonimizados.");
  let json = toPublic(agg, { allowlist: lerAllowlist(config ?? {}, { home }), home, avisar });
  exigirMetricasValidas(json); // o que sai do código também passa pela allowlist estrita
  // Histórico persistente: mescla a série diária com o último JSON publicado (baseline validado estritamente). Falha = ignora.
  let resumoHist = { usado: false };
  // O baseline é carregado mesmo com a mescla desligada, só para avisar quando o JSON gerado fica MENOR que o histórico.
  let base = null;
  try {
    base = await carregarBaseline({ paths, config, home, avisar });
  } catch {
    avisar("histórico ignorado: não consegui ler o baseline.");
  }
  if (historico && base) {
    try {
      const m = mesclarHistorico(json, base.json, { tools: meta, avisar, hoje: new Date() });
      json = m.json;
      resumoHist = { usado: true, origem: base.origem, ...m.resumo };
    } catch {
      avisar("histórico ignorado: não consegui mesclar (os números saem só dos registros locais).");
    }
  }
  exigirMetricasValidas(json);
  garantirSemVazamento(JSON.stringify(json), home); // barreira de privacidade sobre o resultado final
  const perda = base ? piorRegressao(json, [base.json]) : null;
  await gravar(destino, JSON.stringify(json, null, 2) + "\n");
  // Sempre na pasta de saída do estado (nunca ao lado de --out: não sobrescreve arquivo alheio). Só local; o publish repete na tela.
  await gravar(join(paths.saida, "avisos.json"), JSON.stringify([...lista]) + "\n");
  await gravar(join(paths.saida, "historico.json"), JSON.stringify({ ...resumoHist, motivos }) + "\n"); // só números: o publish mostra no dry-run
  const publicos = json.projects.filter((p) => p.public).length;
  out(`JSON gravado em ${destino}`);
  out(`${json.projects.length} projetos (${publicos} com nome público, ${json.projects.length - publicos} anonimizados), ${json.totals.sessions} sessões.`);
  if (resumoHist.usado) for (const l of linhasDoHistorico(resumoHist)) out(l);
  if (perda) for (const l of linhasDeRegressao(perda, motivos)) out(l);
  for (const a of lista) out(`Aviso: ${a}`);
  return json;
}

/**
 * Gera os SVGs a partir do JSON validado. `svgPath`: o arquivo do modelo escolhido (metrics.svg). `dirModelos`: se informado,
 * também grava metrics.model-N.svg dos 3 modelos nessa pasta (mesmas cores). Tudo é gerado e verificado ANTES de gravar qualquer arquivo.
 */
async function etapaRender({ jsonPath, svgPath, dirModelos, opcoes, home, out }) {
  const json = exigirMetricasValidas(await lerJsonDoDisco(jsonPath));
  const gerar = (modelo) => {
    const svg = gerarSvg(json, { ...opcoes, modelo });
    garantirSvgSemVazamento(svg, home); // cada SVG final também passa pela barreira de privacidade
    return svg;
  };
  const arquivos = [[svgPath, gerar(opcoes.modelo)]];
  if (dirModelos) for (const m of MODELOS) arquivos.push([join(dirModelos, `metrics.${m}.svg`), gerar(m)]);
  for (const [arquivo, svg] of arquivos) {
    await gravar(arquivo, svg);
    out(`SVG gravado em ${arquivo}`);
  }
}

/** Destino e pastas públicas que o dono aprovou num publish manual: o envio automático só vale para exatamente isto. */
function aprovacaoAtual(config, plano, home) {
  const pares = Object.create(null);
  for (const [pasta, alias] of lerAllowlist(config, { home })) if (plano.publicos.some((n) => n.toLowerCase() === alias.toLowerCase())) pares[pasta] = alias;
  const autor = autorDoCommit(config); // valores EFETIVOS (inclusive o padrão noreply): o autor vai para o histórico público
  return { target: { remote: normalizarRemoto(urlDoRemoto(config)), branch: config.branch, commitName: autor.name, commitEmail: autor.email }, pares };
}

/** Lista o que mudou desde a última aprovação manual (vazio = tudo igual). */
function divergenciasDaAprovacao(estado, atual) {
  const d = [];
  if (!estado.approvedTarget) d.push("não há destino aprovado registrado (aprovação antiga ou inexistente)");
  else {
    if (estado.approvedTarget.remote !== atual.target.remote) d.push("o repositório de destino mudou");
    if (estado.approvedTarget.branch !== atual.target.branch) d.push("a branch de destino mudou");
    if (estado.approvedTarget.commitName === null || estado.approvedTarget.commitEmail === null) d.push("a aprovação anterior não cobre o autor do commit (nome e e-mail)");
    else {
      if (estado.approvedTarget.commitName !== atual.target.commitName) d.push("o nome do autor do commit mudou");
      if (estado.approvedTarget.commitEmail !== atual.target.commitEmail) d.push("o e-mail do autor do commit mudou");
    }
  }
  for (const [pasta, alias] of Object.entries(atual.pares)) {
    if (estado.approvedFolders[pasta] !== alias) d.push(`a pasta/nome "${pasta}" -> nome público "${alias}" não foi aprovada`);
  }
  return d;
}

/** Fluxo de publicação. modo "manual": dry-run + confirmação. modo "auto": só com as travas do run. */
async function etapaPublish({ config, paths, jsonPath, home, yes, dryRun, aceitaEmail, aceitaPerda = false, io, out, modo }) {
  const plano = await planejar({ config, caminhos: paths, jsonPath, home });
  out(descreverPlano(plano));
  const { hist, motivos } = await lerResumoDoHistorico(paths);
  if (hist) for (const l of linhasDoHistorico(hist)) out(`(do último export) ${l}`);
  // Guarda de regressão: compara com o melhor baseline local (history.json + clone) e com o metrics.json já publicado (anterior).
  let baseline = null;
  try {
    baseline = await carregarBaseline({ paths, config, home, avisar: (m) => out(`Aviso: ${m}`) });
  } catch {
    baseline = null;
  }
  const perda = piorRegressao(plano.json, [baseline?.json, plano.anteriorJson]);
  if (perda) for (const l of linhasDeRegressao(perda, motivos)) out(l);
  for (const av of await lerAvisosDoExport(paths)) out(`Aviso (do último export): ${av}`);
  const estado = await lerEstado(paths.estado);
  const atual = aprovacaoAtual(config, plano, home);

  if (modo === "auto") {
    const novos = plano.publicos.filter((n) => !estado.approvedPublicNames.includes(n));
    if (novos.length) {
      out(`Envio automático BLOQUEADO: nomes públicos novos que você ainda não aprovou num publish manual: ${novos.join(", ")}. Rode "publish" manualmente.`);
      return { enviado: false };
    }
    const div = divergenciasDaAprovacao(estado, atual);
    if (div.length) {
      out(`Envio automático BLOQUEADO: ${div.join("; ")}.`);
      out('Para reaprovar: rode "ai-usage-metrics publish" num terminal interativo, confira o dry-run e confirme (isso grava o destino e as pastas aprovadas).');
      return { enviado: false };
    }
    if (!plano.autor.noreply) {
      out(`Envio automático BLOQUEADO: o e-mail do commit (${plano.autor.email}) não é um noreply do GitHub; só um publish manual pode publicá-lo (veja SECURITY.md).`);
      return { enviado: false };
    }
    if (perda) {
      out("Envio automático BLOQUEADO: o JSON gerado tem menos histórico que o já publicado/guardado (veja a PERDA DE HISTÓRICO acima). Só um publish manual pode aceitar essa perda; o envio automático nunca a aprova.");
      return { enviado: false };
    }
  } else {
    if (dryRun || (!yes && !io.isTTY)) {
      out(dryRun ? "Dry-run: nada foi enviado." : "Dry-run: nada foi enviado (sem terminal interativo). Para enviar, rode de novo com --yes após conferir o que está acima.");
      return { enviado: false };
    }
    if (!yes) {
      const r = await io.ask("Enviar estes arquivos para o repositório público acima? [s/N] ");
      if (!afirmativa(r)) {
        out("Cancelado: nada foi enviado.");
        return { enviado: false };
      }
    }
    if (!plano.autor.noreply) {
      if (io.isTTY) {
        const r = await io.ask(`O e-mail ${plano.autor.email} ficará PÚBLICO e permanente no histórico. Para continuar digite exatamente: publicar meu e-mail\n> `);
        if (r.trim() !== "publicar meu e-mail") {
          out("Cancelado: e-mail do commit não confirmado; nada foi enviado.");
          return { enviado: false };
        }
      } else if (!aceitaEmail) {
        out(`Bloqueado: o e-mail do commit (${plano.autor.email}) não é um noreply do GitHub. Defina "commitEmail" com o noreply na configuração, ou rode com --accept-public-email se aceita publicá-lo.`);
        return { enviado: false };
      }
    }
  }

  let permitirPerda = false;
  if (modo === "manual") {
    permitirPerda = Boolean(aceitaPerda);
    if (perda && !permitirPerda) {
      if (!io.isTTY) {
        out("Bloqueado: o JSON gerado perderia histórico (veja acima). Sem terminal, só com --accept-history-loss; nada foi enviado.");
        return { enviado: false };
      }
      const r = await io.ask(`Para publicar MESMO ASSIM, perdendo histórico, digite exatamente: ${FRASE_PERDA}\n> `);
      if (r.trim() !== FRASE_PERDA) {
        out("Cancelado: a perda de histórico não foi confirmada; nada foi enviado.");
        return { enviado: false };
      }
      permitirPerda = true;
    }
  }
  const r = await enviar(plano, { config, caminhos: paths, interativo: modo === "manual" && io.isTTY, avisar: (m) => out(`Aviso: ${m}`), permitirPerda });
  const novo = { ...estado };
  if (r.enviado) {
    out(`Enviado para ${urlDoRemoto(config)}.`);
    novo.lastPublishAt = new Date().toISOString();
  } else out(`Nada enviado: ${r.motivo}.`);
  // history.json = MESCLA POR MÁXIMO do anterior com o metrics.json PUBLICADO com sucesso (ou já publicado, quando nada mudou):
  // monotônico, nunca encolhe. Nunca antes do envio dar certo.
  if ((r.enviado || r.jaPublicado) && config.history !== false) {
    try {
      await gravarHistoricoMonotonico(paths, plano.arquivos.find((a) => a.nome === "metrics.json").conteudo, { home, avisar: (m) => out(`Aviso: ${m}`) });
      out(`Histórico local atualizado (${ARQUIVO_HISTORICO}).`);
    } catch (e) {
      out(`Aviso: não consegui atualizar o histórico local: ${limparAviso(e.message)}`);
    }
  }
  if (modo === "manual" && !r.bloqueado) {
    if (io.isTTY) {
      // Só uma pessoa num terminal interativo pode aprovar o envio automático (vale também quando nada mudou: serve para reaprovar).
      novo.manualPublishConfirmed = true;
      novo.approvedPublicNames = plano.publicos;
      novo.approvedTarget = atual.target;
      novo.approvedFolders = atual.pares;
    } else if (r.enviado) {
      out('Aviso: sem terminal interativo, este envio NÃO conta como aprovação para o envio automático. Para aprovar, rode "publish" num terminal.');
    }
  }
  await gravarEstado(paths.estado, novo);
  return r;
}

// ---------- init: configuração + instruções (não instala nada) ----------

/** Aspas de shell POSIX: tudo entre aspas simples, aspas simples internas viram '\'' . Recusa quebra de linha. */
export function aspasPosix(s) {
  if (/[\r\n\0]/.test(s)) throw new Error("Um dos caminhos tem quebra de linha e não pode ser citado com segurança no comando do cron.");
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Valor do /TR do schtasks: cada argumento entre aspas duplas (a CRT do Windows lê "..." e barra+aspas). Barras invertidas
 * no fim do argumento são dobradas, senão barra+aspas fecharia a citação errada. Aspas duplas no argumento não têm como ser citadas.
 */
function valorTR(args) {
  return args
    .map((a) => {
      if (/["\r\n\0]/.test(a) || /\p{Cc}/u.test(a)) throw new Error('um dos caminhos tem " ou caractere de controle');
      return `"${a.replace(/\\+$/, (m) => m + m)}"`;
    })
    .join(" ");
}

/** Escapa o valor para ir DENTRO de "..." numa linha de comando do Windows: barras antes de aspas dobram, aspas viram barra+aspas. */
const escCRT = (v) => v.replace(/(\\*)"/g, '$1$1\\"');

/** schtasks digitado no cmd.exe: barra+aspas dentro de "...". Caracteres que o cmd interpreta fora de aspas (& | < > ^ % !) não são citáveis. */
export function schtasksParaCmd(args) {
  for (const a of args) if (/[&|<>^%!]/.test(a)) throw new Error("um dos caminhos tem um destes caracteres, que o cmd.exe interpreta e não dá para citar: & | < > ^ % !");
  return `schtasks /Create /SC DAILY /ST 12:00 /TN "ai-usage-metrics" /TR "${escCRT(valorTR(args))}"`;
}

/**
 * schtasks no PowerShell. Passar barra+aspas direto a um .exe se comporta diferente entre o Windows PowerShell 5.1 e o 7+; por isso
 * usamos Start-Process -ArgumentList com UMA string entre aspas simples (repassada crua, igual nas duas versões).
 * Só as aspas simples (inclusive as tipográficas, que o PowerShell também trata como aspas) precisam de tratamento: são dobradas.
 */
export function schtasksParaPowerShell(args) {
  for (const a of args) if (a.includes("%")) throw new Error("um dos caminhos tem '%', que o Windows pode expandir como variável de ambiente e não dá para citar com segurança");
  const inner = `/Create /SC DAILY /ST 12:00 /TN "ai-usage-metrics" /TR "${escCRT(valorTR(args))}"`;
  return `Start-Process -FilePath schtasks -ArgumentList '${inner.replace(/['‘’‚‛]/g, (q) => q + q)}' -Wait -NoNewWindow`;
}

/**
 * Comandos de agendamento (só IMPRESSOS). Todos os argumentos são citados; "%" é escapado no cron; o log respeita
 * --state-dir e é criado com umask 077 (modo 0600) no Linux/macOS.
 * @param {{ stateDir?: string|null, configPath?: string|null, node?: string, bin?: string }} [o]
 */
export function instrucoesDeAgendamento({ stateDir = null, configPath = null, node = process.execPath, bin = BIN } = {}) {
  const args = ["run", "--non-interactive"];
  if (stateDir) args.push("--state-dir", stateDir);
  if (configPath) args.push("--config", configPath);
  const todos = [node, bin, ...args];
  const gerar = (f) => {
    try {
      return f(todos);
    } catch (e) {
      return `(comando não gerado para este shell) ${e.message}. Mova a pasta ou escolha outro --state-dir.`; // nunca imprime um comando que a shell expandiria ou quebraria
    }
  };
  const winCmd = gerar(schtasksParaCmd);
  const winPs = gerar(schtasksParaPowerShell);
  let cron;
  try {
    const log = stateDir ? aspasPosix(`${stateDir.replace(/[\\/]+$/, "")}/run.log`) : '"$HOME/.ai-usage-metrics/run.log"';
    cron = `0 12 * * * umask 077; ${todos.map(aspasPosix).join(" ")} >> ${log} 2>&1`.replace(/%/g, "\\%");
  } catch (e) {
    cron = `(comando não gerado) ${e.message}`;
  }
  return [
    "Agendamento diário (este comando só IMPRIME as instruções; nada foi instalado):",
    "",
    "  Windows (Agendador de Tarefas). Use UMA das duas versões, conforme o terminal onde vai colar:",
    "  cmd.exe:",
    `    ${winCmd}`,
    "  PowerShell (Start-Process repassa o /TR sem a reescrita de aspas do PowerShell):",
    `    ${winPs}`,
    '    remover depois: schtasks /Delete /TN "ai-usage-metrics"',
    `    ATENÇÃO: o schtasks grava o caminho do Node usado AGORA (${node}). Se você atualizar ou mover o Node, apague e recrie a tarefa.`,
    "    A tarefa do Windows não grava log; as pastas do seu usuário já são privadas por padrão (o modo 0600 do Linux não existe no Windows).",
    "",
    "  Linux/macOS (cron; NÃO validado pelo autor, só Windows foi testado). Rode `crontab -e` e adicione:",
    `    ${cron}`,
    "    (o log run.log é criado com permissão 0600 pelo umask; o cron grava o caminho do Node acima, recrie se mudar de versão.)",
    "",
    "Notas: a tarefa roda sem terminal, então o git precisa já ter credencial salva (gerenciador de credenciais ou chave SSH).",
    'O envio automático só acontece se você pôr "autoPublish": true na configuração, depois de um publish manual confirmado em terminal.',
    "Qualquer mudança de repositório, branch ou nome público bloqueia o automático até você aprovar de novo com um publish manual.",
  ].join("\n");
}

async function cmdInit({ args, paths, io, out }) {
  const arquivo = resolve(args.config ?? paths.config);
  if (!args.overwrite) {
    const existente = await lerConfig(arquivo);
    if (existente) throw new Error(`Já existe configuração em ${arquivo}. Use --overwrite para recriar.`);
  }

  let user = args.user;
  if (!user && io.isTTY) user = (await io.ask("Seu usuário do GitHub: ")).trim();
  if (!user) throw new Error("Informe o usuário do GitHub: --user <usuário>.");
  const bruto = {
    githubUser: user,
    dataRepo: args.repo ?? PADROES.dataRepo,
    branch: args.branch ?? PADROES.branch,
    publicProjects: args.public ? args.public.split(",").map((s) => s.trim()).filter(Boolean) : [],
    theme: args.theme ?? PADROES.theme,
    lang: args.lang ?? PADROES.lang,
    autoPublish: false,
  };
  if (args.title) bruto.title = args.title;
  if (args.remote) bruto.remoteUrl = args.remote;
  if (args.model) bruto.model = args.model;
  // Cores só entram na configuração se o usuário as passar (JSON); a validação estrita é a de normalizarConfig.
  for (const [opcao, chave] of [["colors", "colors"], ["colors-dark", "colorsDark"]]) {
    if (args[opcao] === undefined) continue;
    try {
      bruto[chave] = JSON.parse(args[opcao]);
    } catch {
      throw new Error(`--${opcao} deve ser um JSON, por exemplo '{"accent":"#22c55e"}'.`);
    }
  }
  const config = normalizarConfig(bruto);

  await gravarConfig(arquivo, config);
  out(`Configuração gravada em ${arquivo}`);
  out(`  repositório de dados: ${urlDoRemoto(config)} (branch ${config.branch})`);
  out(`  modelo do metrics.svg: ${config.model ?? MODELO_PADRAO}`);
  out(`  projetos públicos: ${config.publicProjects.length ? JSON.stringify(config.publicProjects) : "nenhum (todos anonimizados)"}`);
  out("");
  out(`1) Crie o repositório PÚBLICO vazio ${config.githubUser}/${config.dataRepo} no GitHub (este comando não cria nada).`);
  out("2) Teste sem enviar:   ai-usage-metrics export && ai-usage-metrics render && ai-usage-metrics publish");
  out("3) Envie a primeira vez, conferindo o que aparece:   ai-usage-metrics publish --yes");
  out("4) Cole no README do seu perfil (repositório <usuário>/<usuário>):");
  out("");
  const base = `https://raw.githubusercontent.com/${config.githubUser}/${config.dataRepo}/${config.branch}`;
  out(`   ![AI usage](${base}/metrics.svg)`);
  out("");
  out("   O publish envia 4 SVGs; troque a URL para escolher o modelo (metrics.svg = o modelo da configuração):");
  for (const arq of ["metrics.svg", ...MODELOS.map((m) => `metrics.${m}.svg`)]) out(`     ${base}/${arq}`);
  out("");
  out('5) Cores (opcional): edite o config.json e acrescente, por exemplo (só hexadecimal #rgb ou #rrggbb; legibilidade é por sua conta):');
  out('   "colors": { "accent": "#22c55e", "tools": { "claude-code": "#16a34a" } },');
  out('   "colorsDark": { "background": "#1a1033", "card": "#241747", "text": "#f3e8ff" }');
  out("   Chaves: background, card, border, text, muted, track, accent, tools. Veja docs/modelos.md.");
  out("");
  out(instrucoesDeAgendamento({ stateDir: args["state-dir"] ? resolve(args["state-dir"]) : null, configPath: args.config ? arquivo : null }));
}

// ---------- history reset ----------

async function cmdHistory({ args, paths, io, out }) {
  if (args._[1] !== "reset") throw new Error('Use "ai-usage-metrics history reset" (apaga o history.json local, com confirmação).');
  out(`history reset: vai apagar o histórico local (${ARQUIVO_HISTORICO} no estado). O que já foi publicado no repositório de dados NÃO é tocado.`);
  out("Atenção: o metrics.json do clone local (repo/) também serve de baseline até o próximo publish. Para recomeçar de verdade, use \"history\": false na configuração e publique com --accept-history-loss.");
  if (!args.yes) {
    if (!io.isTTY) {
      out("Nada feito (sem terminal interativo). Rode de novo com --yes para apagar.");
      return;
    }
    if (!afirmativa(await io.ask("Apagar o histórico local? [s/N] "))) {
      out("Cancelado: nada foi apagado.");
      return;
    }
  }
  out((await apagarHistorico(paths)) ? "Histórico local apagado." : "Não havia histórico local para apagar.");
}

// ---------- restore: computador novo ----------

async function cmdRestore({ args, config, paths, home, io, out }) {
  let texto;
  if (args["from-file"]) {
    const rede = motivoCaminhoDeRede(args["from-file"]);
    if (rede) throw new Error(`restore --from-file: recuso ${rede}; o modo offline só lê arquivos locais. Copie o arquivo para uma pasta local.`);
    const arquivo = resolve(args["from-file"]);
    const r = await lerArquivoLimitado(arquivo, { seguirLink: true });
    if (r === null) throw new Error(`restore --from-file: o arquivo não existe: ${arquivo}`);
    if (r.motivo) throw new Error(`restore --from-file: ${r.motivo}.`);
    texto = r.texto;
  } else {
    if (!config) throw new Error('Sem configuração. Rode "ai-usage-metrics init --user <usuário-github>" primeiro (ou use restore --from-file <json>).');
    out(`restore: vai baixar o último metrics.json publicado de ${semCredenciais(urlDoRemoto(config))} (branch ${config.branch}) e gravá-lo como ${ARQUIVO_HISTORICO}. É uma etapa de REDE.`);
    if (!args.yes) {
      if (!io.isTTY) {
        out("Nada feito (sem terminal interativo). Confira o destino acima e rode de novo com --yes.");
        return;
      }
      if (!afirmativa(await io.ask("Baixar agora? [s/N] "))) {
        out("Cancelado: nada foi baixado.");
        return;
      }
    }
    const r = await baixarMetricasPublicadas({ config, caminhos: paths, interativo: io.isTTY, avisar: (m) => out(`Aviso: ${m}`) });
    if (r.vazio) {
      out(`Nada para restaurar: ${r.motivo}. Nada foi gravado.`);
      return;
    }
    texto = r.texto;
  }
  const v = validarTextoDeBaseline(texto, { home });
  if (!v.ok) throw new Error(`restore recusado: o JSON ${v.motivo}. Nada foi gravado.`);
  const conhecidas = new Set(ADAPTERS.map((a) => a.id));
  const fora = [...new Set([...v.json.tools.map((t) => t.id), ...v.json.timeline.points.flatMap((p) => Object.keys(p.byTool))])].filter((id) => !conhecidas.has(id));
  if (fora.length) out(`Aviso: ferramenta(s) fora do registro desta versão (${fora.join(", ")}) serão ignoradas ao mesclar.`);
  // Já existe history.json válido: NUNCA sobrescreve. Grava a mescla por máximo (existente + restaurado), com a comparação.
  let final = v.json;
  const atual = await lerArquivoLimitado(paths.historico);
  if (atual && !atual.motivo) {
    const va = validarTextoDeBaseline(atual.texto, { home });
    if (va.ok) {
      final = mesclarBaselines(v.json, va.json).json;
      const f = (j) => `${j.timeline.points.length} dias, ${j.totals.sessions} sessões, ${j.totals.userMessages} mensagens, ${j.totals.tokens.total} tokens`;
      out(`Já existe um histórico local. Comparação (o restaurado nunca reduz o local; vale o máximo):`);
      out(`  local atual: ${f(va.json)}`);
      out(`  restaurado:  ${f(v.json)}`);
      out(`  resultado:   ${f(final)}`);
      if (!args.yes && args["from-file"]) {
        if (!io.isTTY) {
          out("Nada gravado (sem terminal interativo). Confira a comparação acima e rode de novo com --yes.");
          return;
        }
        if (!afirmativa(await io.ask("Gravar a mescla no history.json? [s/N] "))) {
          out("Cancelado: nada foi gravado.");
          return;
        }
      }
    } else out(`Aviso: o history.json atual é inválido (${va.motivo}) e será substituído pelo restaurado.`);
  }
  await gravarBaseline(paths, JSON.stringify(final, null, 2) + "\n", { home });
  const t = final.totals;
  v.json = final;
  out(`Histórico restaurado em ${paths.historico}: ${v.json.timeline.points.length} dias${v.json.period ? ` (${v.json.period.from} a ${v.json.period.to})` : ""}, ${t.sessions} sessões, ${t.userMessages} mensagens.`);
  out('Aviso: o ranking de projetos NÃO é restaurado (vem só dos registros locais). Rode "run" (ou "export") para mesclar com este computador.');
}

// ---------- main ----------

/**
 * @param {string[]} argv
 * @param {(linha: string) => void} [out]
 * @param {{ isTTY: boolean, ask: (p: string) => Promise<string> }} [io]
 */
export async function main(argv, out = console.log, io = ioPadrao()) {
  const args = lerArgs(argv);
  // O Agendador do Windows dá um console ao processo (stdin.isTTY fica verdadeiro), então o "run" agendado seguiria o fluxo
  // manual e ficaria esperando uma resposta que ninguém vai dar. Com esta opção a ferramenta nunca pergunta.
  if (args["non-interactive"]) io = { ...io, isTTY: false };
  const cmd = args._[0];
  if (!cmd || args.help || cmd === "help") return out(AJUDA);
  if (!COMANDOS.includes(cmd)) throw new Error(`Comando desconhecido: ${cmd}. Use --help.`);

  const home = resolve(args.home ?? homedir());
  const paths = caminhos(resolve(args["state-dir"] ?? pastaPadrao()));
  const configPath = resolve(args.config ?? paths.config);
  const ctx = { home, since: parseSince(args.since) };

  if (["init", "export", "render", "publish", "run", "restore", "history"].includes(cmd)) await validarStateDir(args["state-dir"] ?? paths.dir, { homes: [home] }); // a grafia CRUA é validada (resolve() esconderia ponto/espaço final)
  if (cmd === "init") return cmdInit({ args, paths, io, out });

  // Escritas na pasta de estado não podem rodar em paralelo (lockfile com detecção de trava velha).
  const liberar = ["export", "render", "publish", "run", "restore", "history"].includes(cmd) ? await adquirirLock(paths.dir) : null;
  try {
    return await executar({ cmd, args, home, paths, configPath, ctx, io, out });
  } finally {
    await liberar?.();
  }
}

async function executar({ cmd, args, home, paths, configPath, ctx, io, out }) {
  let adapters = ADAPTERS;
  if (args.tool.length) {
    const desconhecidas = args.tool.filter((t) => !ADAPTERS.some((a) => a.id === t));
    if (desconhecidas.length) throw new Error(`Ferramenta desconhecida: ${desconhecidas.join(", ")}. Use o comando sources.`);
    adapters = ADAPTERS.filter((a) => args.tool.includes(a.id));
  }

  if (cmd === "sources") {
    for (const a of ADAPTERS) out(`${a.id.padEnd(14)} ${(await a.available(ctx)) ? "encontrada" : "ausente   "}  ${a.name}`);
    return;
  }

  if (cmd === "report") {
    const meta = adapters.map(({ id, name, capabilities }) => ({ id, name, capabilities }));
    const { lista, avisar } = novosAvisos();
    const agg = await aggregate(coletar(adapters, { ...ctx, avisar }), { home, tools: meta, avisar });
    out(renderTerminal(agg, { top: args.top ? Number(args.top) : 10 }));
    for (const a of lista) out(`Aviso: ${a}`);
    return;
  }

  const config = await lerConfig(configPath);
  const exigirConfig = () => {
    if (!config) throw new Error(`Sem configuração em ${configPath}. Rode "ai-usage-metrics init --user <usuário-github>" primeiro.`);
  };
  const opcoesSvg = () => {
    const o = {
      tema: args.theme ?? config?.theme ?? PADROES.theme,
      titulo: args.title ?? config?.title,
      idioma: args.lang ?? config?.lang ?? PADROES.lang,
      modelo: args.model ?? config?.model ?? MODELO_PADRAO,
      cores: config?.colors, // já validadas na carga da configuração (e de novo no renderizador)
      coresEscuro: config?.colorsDark,
    };
    if (!MODELOS.includes(o.modelo)) throw new Error(`--model deve ser ${MODELOS.join("|")}.`);
    if (!TEMAS.includes(o.tema)) throw new Error(`--theme deve ser ${TEMAS.join("|")}.`);
    if (!IDIOMAS.includes(o.idioma)) throw new Error(`--lang deve ser ${IDIOMAS.join("|")}.`);
    if (o.titulo !== undefined) validarTitulo(o.titulo, home); // até 60, sem controle, mesma barreira de privacidade
    return o;
  };

  if (cmd === "history") return cmdHistory({ args, paths, io, out });
  if (cmd === "restore") return cmdRestore({ args, config, paths, home, io, out });

  // Mescla com o histórico: ligada por padrão; "history": false na configuração, --no-history ou --since a desligam.
  const historico = config?.history !== false && !args["no-history"] && !ctx.since;
  const motivos = [args["no-history"] && "no-history", ctx.since && "since", args.tool.length > 0 && "tool", config?.history === false && "config"].filter((m) => m && MOTIVOS_VALIDOS.includes(m));
  if (ctx.since && config?.history !== false && !args["no-history"] && ["export", "run"].includes(cmd)) out("Aviso: --since limita o período, então o histórico não foi mesclado nesta execução.");

  if (cmd === "export") {
    await etapaExport({ adapters, ctx, home, config, destino: resolve(args.out ?? paths.json), paths, out, historico, motivos });
    return;
  }

  if (cmd === "render") {
    if (args.out && args["out-dir"]) throw new Error("Use --out (um arquivo só) OU --out-dir (os 4 SVGs numa pasta), não os dois.");
    const jsonPath = resolve(args.input ?? paths.json);
    if (args.out) return etapaRender({ jsonPath, svgPath: resolve(args.out), opcoes: opcoesSvg(), home, out });
    const dir = resolve(args["out-dir"] ?? paths.saida);
    return etapaRender({ jsonPath, svgPath: join(dir, "metrics.svg"), dirModelos: dir, opcoes: opcoesSvg(), home, out });
  }

  if (cmd === "publish") {
    exigirConfig();
    await etapaPublish({ config, paths, jsonPath: resolve(args.input ?? paths.json), home, yes: args.yes, dryRun: args["dry-run"], aceitaEmail: args["accept-public-email"], aceitaPerda: args["accept-history-loss"], io, out, modo: "manual" });
    return;
  }

  if (cmd === "run") {
    exigirConfig();
    const o = opcoesSvg();
    await etapaExport({ adapters, ctx, home, config, destino: paths.json, paths, out, historico, motivos });
    await etapaRender({ jsonPath: paths.json, svgPath: paths.svg, dirModelos: paths.saida, opcoes: o, home, out });
    if (io.isTTY) {
      await etapaPublish({ config, paths, jsonPath: paths.json, home, yes: args.yes, dryRun: args["dry-run"], aceitaEmail: args["accept-public-email"], aceitaPerda: args["accept-history-loss"], io, out, modo: "manual" });
      return;
    }
    // Sem terminal (agendador): ninguém pode confirmar, então só envia com as travas explícitas do usuário.
    const estado = await lerEstado(paths.estado);
    if (!config.autoPublish) return out("Gerado localmente; nada enviado (autoPublish está desligado na configuração).");
    if (!estado.manualPublishConfirmed) return out('Gerado localmente; nada enviado: faça antes um "publish" manual confirmado (autoPublish exige isso).');
    await etapaPublish({ config, paths, jsonPath: paths.json, home, yes: true, dryRun: false, io, out, modo: "auto" });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`Erro: ${e.message}`);
    process.exitCode = 1;
  });
}
