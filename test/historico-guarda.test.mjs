// Guarda de regressão, history.json monotônico, baseline coerente/por máximo, restore sem sobrescrever, history reset, UNC, leitura limitada.
// Sem rede: o remoto é um repositório git bare local.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { aggregate } from "../src/aggregate.mjs";
import { main } from "../src/cli.mjs";
import { caminhos } from "../src/config.mjs";
import { coerenciaBaseline, lerArquivoLimitado, mesclarHistorico, motivoCaminhoDeRede, validarBaseline } from "../src/historico.mjs";
import { toPublic } from "../src/public.mjs";
import { exigirMetricasValidas } from "../src/schema.mjs";
import { claudeFalso } from "./fixtures.mjs";

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(tmpdir(), "ai-usage-metrics-sem-config"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Teste",
  GIT_AUTHOR_EMAIL: "teste@exemplo.invalid",
  GIT_COMMITTER_NAME: "Teste",
  GIT_COMMITTER_EMAIL: "teste@exemplo.invalid",
  GIT_TERMINAL_PROMPT: "0",
  AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE: "1",
});

const FRASE = "publicar com perda de histórico";
const pastas = [];
after(async () => {
  for (const p of pastas) await rm(p, { recursive: true, force: true });
});
const tmp = async (prefixo) => {
  const p = await mkdtemp(join(tmpdir(), prefixo));
  pastas.push(p);
  return p;
};
const gitRemoto = (remoto, ...args) => execFileSync("git", [`--git-dir=${remoto}`, ...args], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "ignore"] }).trim();
const commits = (remoto) => gitRemoto(remoto, "log", "--format=%s", "main").split("\n").filter(Boolean).length;
const diasRemoto = (m) => JSON.parse(gitRemoto(m.remoto, "show", "main:metrics.json")).timeline.points.length;
const diasHist = async (m) => JSON.parse(await readFile(m.paths.historico, "utf8")).timeline.points.length;

async function maquina({ remoto, raiz } = {}) {
  raiz ??= await tmp("ai-usage-metrics-teste-");
  if (!remoto) {
    remoto = join(raiz, "remote.git");
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", remoto], { env: process.env });
  }
  const stateDir = join(raiz, `estado-${Math.random().toString(36).slice(2, 8)}`);
  const paths = caminhos(stateDir);
  const home = await tmp("ai-usage-metrics-home-");
  const saidas = [];
  const io = { isTTY: false, perguntas: [], resposta: "n", async ask(p) { this.perguntas.push(p); return this.resposta; } };
  const cmd = (args, ioLocal = io) => main([...args, "--state-dir", stateDir, "--home", home], (l) => saidas.push(l), ioLocal);
  await cmd(["init", "--user", "fulano", "--remote", remoto, "--public", "projeto-alfa", "--title", "Meu painel"]);
  return { raiz, remoto, stateDir, paths, home, cmd, io, saidas, texto: () => saidas.join("\n"), limpar: () => (saidas.length = 0), json: async () => JSON.parse(await readFile(paths.json, "utf8")) };
}

/** Máquina com N dias de registros, já publicada num terminal (aprovação manual registrada). */
async function preparar(n = 3, { apagarAntigos = false } = {}) {
  const m = await maquina();
  for (let i = 0; i < n; i++) await claudeFalso(m.home, { dia: `2026-03-0${i + 1}`, sessao: `s${i}`, pasta: `p${i}` });
  await m.cmd(["export"]);
  m.io.isTTY = true;
  m.io.resposta = "s";
  await m.cmd(["publish"]);
  m.io.isTTY = false;
  m.io.perguntas.length = 0;
  m.limpar();
  assert.equal(diasRemoto(m), n);
  assert.equal(await diasHist(m), n);
  // "o Claude Code apagou as sessões antigas": só o último dia continua nos registros locais
  if (apagarAntigos) for (let i = 0; i < n - 1; i++) await rm(join(m.home, ".claude", "projects", `p${i}`), { recursive: true, force: true });
  return m;
}

const VARIANTES = [
  ["--no-history", ["export", "--no-history"], /--no-history/, 1],
  ["--since", ["export", "--since", "2026-03-03"], /--since/, 1],
  ["--tool", ["export", "--tool", "cline"], /--tool/, 0],
  ["history:false", null, /"history": false/, 1],
];

for (const [nome, argsExport, causa, diasDepois] of VARIANTES) {
  test(`guarda de regressão (${nome}): dry-run avisa com números; sem a flag nada é enviado; com a flag envia mas o history.json não encolhe`, async () => {
    const m = await preparar(3, { apagarAntigos: true });
    if (argsExport) await m.cmd(argsExport);
    else {
      const cfg = JSON.parse(await readFile(m.paths.config, "utf8"));
      cfg.history = false;
      await writeFile(m.paths.config, JSON.stringify(cfg));
      await m.cmd(["export"]);
    }
    assert.match(m.texto(), /ATENÇÃO: PERDA DE HISTÓRICO/, "o export já avisa");
    assert.match(m.texto(), causa);
    m.limpar();
    await m.cmd(["publish", "--dry-run"]);
    assert.match(m.texto(), new RegExp(`PERDA DE HISTÓRICO.* 3 -> ${diasDepois} dia\\(s\\)`));
    assert.match(m.texto(), /\(\d+ dia\(s\) seriam removidos\)/);
    m.limpar();
    await m.cmd(["publish", "--yes"]);
    assert.match(m.texto(), /Bloqueado: o JSON gerado perderia histórico/);
    assert.equal(diasRemoto(m), 3, "nada foi enviado");
    assert.equal(commits(m.remoto), 1);
    assert.equal(await diasHist(m), 3);
    await m.cmd(["publish", "--yes", "--accept-history-loss"]);
    assert.equal(commits(m.remoto), 2);
    assert.equal(diasRemoto(m), diasDepois, "com a flag o envio acontece");
    assert.equal(await diasHist(m), 3, "o history.json NÃO encolhe");
  });
}

test("guarda de regressão: publish --input <JSON menor> também é barrado; a frase exata é exigida em terminal", async () => {
  const m = await preparar(3);
  const menor = JSON.parse(await readFile(m.paths.json, "utf8"));
  menor.timeline.points = menor.timeline.points.slice(0, 1);
  menor.totals = { ...menor.totals, activeDays: 1, sessions: 1, userMessages: menor.timeline.points[0].userMessages, assistantMessages: menor.timeline.points[0].assistantMessages };
  menor.totals.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  menor.tools = [];
  menor.period = { from: menor.timeline.points[0].date, to: menor.timeline.points[0].date };
  const arq = join(m.raiz, "menor.json");
  await writeFile(arq, JSON.stringify(menor));
  await m.cmd(["publish", "--input", arq, "--yes"]);
  assert.match(m.texto(), /Bloqueado/);
  assert.equal(diasRemoto(m), 3);

  // terminal: frase errada cancela; frase exata envia
  const tty = { isTTY: true, perguntas: [], resposta: "frase errada", async ask(p) { this.perguntas.push(p); return this.resposta; } };
  await m.cmd(["publish", "--input", arq, "--yes"], tty);
  assert.match(tty.perguntas.at(-1), new RegExp(FRASE));
  assert.match(m.texto(), /Cancelado: a perda de histórico não foi confirmada/);
  assert.equal(diasRemoto(m), 3);
  tty.resposta = FRASE;
  await m.cmd(["publish", "--input", arq, "--yes"], tty);
  assert.equal(diasRemoto(m), 1);
  assert.equal(await diasHist(m), 3, "history.json monotônico");
});

test("guarda de regressão: o run agendado (autoPublish) BLOQUEIA e o remoto não muda", async () => {
  const m = await preparar(3, { apagarAntigos: true });
  const cfg = JSON.parse(await readFile(m.paths.config, "utf8"));
  cfg.autoPublish = true;
  await writeFile(m.paths.config, JSON.stringify(cfg));
  await m.cmd(["run", "--non-interactive", "--no-history"]);
  assert.match(m.texto(), /Envio automático BLOQUEADO: o JSON gerado tem menos histórico/);
  assert.equal(diasRemoto(m), 3);
  assert.equal(commits(m.remoto), 1);
  // sem a causa (histórico ligado) o automático segue normalmente
  m.limpar();
  await m.cmd(["run", "--non-interactive"]);
  assert.doesNotMatch(m.texto(), /BLOQUEADO/);
});

test("guarda no envio: se outro computador publicou mais, este publish (que só vê o clone antigo) é barrado", async () => {
  const a = await preparar(3);
  const b = await maquina({ remoto: a.remoto, raiz: a.raiz });
  await b.cmd(["restore", "--yes"]);
  await claudeFalso(b.home, { dia: "2026-03-04", sessao: "s9", pasta: "p9" });
  await claudeFalso(b.home, { dia: "2026-03-05", sessao: "s10", pasta: "p10" });
  await b.cmd(["export"]);
  await b.cmd(["publish", "--yes"]);
  assert.equal(diasRemoto(a), 5, "o segundo computador, depois do restore, publica 5 dias sem aviso de perda");
  assert.doesNotMatch(b.texto(), /PERDA DE HISTÓRICO/);
  // A ainda tem 3 dias em history.json e no clone: o plano parece normal, mas o remoto tem 5
  await a.cmd(["export"]);
  a.limpar();
  await a.cmd(["publish", "--yes"]);
  assert.match(a.texto(), /bloqueado pela guarda de regressão/);
  assert.equal(diasRemoto(a), 5);
  assert.equal(commits(a.remoto), 2);
});

test("baseline incoerente (totals.sessions = 1e15 e outros) é ignorado com aviso, não derruba o export e a guarda do publish dispara", async () => {
  const m = await preparar(3);
  const bom = JSON.parse(await readFile(m.paths.historico, "utf8"));
  const ruim = JSON.parse(JSON.stringify(bom));
  ruim.totals.sessions = 1e15;
  ruim.totals.userMessages = 1e15;
  ruim.totals.tokens = { input: 1e15, output: 0, cacheRead: 0, cacheWrite: 0, total: 1e15 };
  assert.match(coerenciaBaseline(ruim), /INCOERENTE/);
  assert.equal(validarBaseline(ruim).ok, false);
  await writeFile(m.paths.historico, JSON.stringify(ruim));
  // o clone local também foi adulterado (mesmo conteúdo ruim)
  await writeFile(join(m.paths.clone, "metrics.json"), JSON.stringify(ruim, null, 2) + "\n");
  // registros locais: só o último dia
  await rm(join(m.home, ".claude"), { recursive: true, force: true });
  await claudeFalso(m.home, { dia: "2026-03-03", sessao: "s2", pasta: "p2" });
  m.limpar();
  await m.cmd(["export"]);
  assert.match(m.texto(), /histórico ignorado: history\.json: INCOERENTE/);
  assert.match(m.texto(), /histórico ignorado: clone local: INCOERENTE/);
  const j = await m.json();
  exigirMetricasValidas(j);
  assert.equal(j.timeline.points.length, 1);
  m.limpar();
  await m.cmd(["publish", "--dry-run"]);
  assert.match(m.texto(), /PERDA DE HISTÓRICO.* 3 -> 1 dia/, "a guarda usa o anterior (clone) mesmo com o baseline ignorado");
  await m.cmd(["publish", "--yes"]);
  assert.match(m.texto(), /Bloqueado/);
  assert.equal(diasRemoto(m), 3);
});

test("coerência do baseline: activeDays, período e totais maiores que a série são recusados; série cortada em 4000 só confere o período", async () => {
  const base = await gerarJson([{ d: "2026-03-01" }, { d: "2026-03-02" }]);
  assert.equal(coerenciaBaseline(base), null);
  const casos = [
    [(j) => (j.totals.activeDays = 9), /activeDays/],
    [(j) => (j.totals.userMessages += 1), /userMessages/],
    [(j) => (j.totals.assistantMessages += 1), /assistantMessages/],
    [(j) => (j.period.from = "2026-02-01"), /primeira data/],
    [(j) => (j.period.to = "2026-04-01"), /última data/],
    [(j) => (j.period = null), /sem período/],
    [(j) => (j.tools[0].userMessages += 100), /ferramenta/],
  ];
  for (const [mut, padrao] of casos) {
    const j = JSON.parse(JSON.stringify(base));
    mut(j);
    assert.match(coerenciaBaseline(j) ?? "", padrao);
  }
});

test("mescla: totais saem da série (totais declarados incoerentes não contaminam), tetos do esquema viram aviso e activeDays é estável na borda de 4000", async () => {
  const base = await gerarJson([{ d: "2026-03-01", u: 2 }]);
  const mentiroso = JSON.parse(JSON.stringify(base));
  mentiroso.totals.userMessages = 5_000_000;
  mentiroso.totals.tokens = { input: 9e14, output: 0, cacheRead: 0, cacheWrite: 0, total: 9e14 };
  const local = await gerarJson([{ d: "2026-03-05" }]);
  const { json } = mesclarHistorico(local, mentiroso, { tools: META, hoje: AGORA });
  assert.equal(json.totals.userMessages, 3, "só a série conta");
  exigirMetricasValidas(json);
  // teto: ponto com 1e15 + outro dia não derruba a mescla (limita, com aviso)
  const enorme = JSON.parse(JSON.stringify(base));
  enorme.timeline.points[0].tokens = 1e15;
  enorme.timeline.points[0].byTool["claude-code"].tokens = 1e15;
  const avisos = [];
  const r = mesclarHistorico(await gerarJson([{ d: "2026-03-05", tok: [10, 10, 10, 10] }]), enorme, { tools: META, hoje: AGORA, avisar: (m) => avisos.push(m) });
  exigirMetricasValidas(r.json);
  assert.ok(avisos.some((a) => /limite do esquema/.test(a)));
  // borda de 4000 pontos
  const molde = base.timeline.points[0];
  const muitos = { ...JSON.parse(JSON.stringify(base)), timeline: { ...base.timeline, points: Array.from({ length: 4000 }, (_, i) => ({ ...JSON.parse(JSON.stringify(molde)), date: new Date(Date.UTC(2012, 0, 1) + i * 86_400_000).toISOString().slice(0, 10) })) } };
  muitos.period = { from: muitos.timeline.points[0].date, to: muitos.timeline.points.at(-1).date };
  muitos.totals = { ...muitos.totals, activeDays: 4000, sessions: 100, userMessages: 100, assistantMessages: 100 };
  const a = mesclarHistorico(await gerarJson([{ d: "2026-03-05" }]), muitos, { tools: META, hoje: AGORA }).json;
  assert.equal(a.timeline.points.length, 4000);
  assert.equal(a.totals.activeDays, 4000);
  const b = mesclarHistorico(await gerarJson([{ d: "2026-03-05" }]), a, { tools: META, hoje: AGORA }).json;
  assert.deepEqual(b, a, "reaplicar na borda dá o mesmo resultado");
});

test("restore com history.json existente: grava a mescla por máximo (nunca reduz), mostra a comparação e confirma", async () => {
  const m = await preparar(5);
  const antes = await readFile(m.paths.historico, "utf8");
  const menor = JSON.parse(antes);
  menor.timeline.points = menor.timeline.points.slice(0, 2);
  menor.totals = { ...menor.totals, activeDays: 2, sessions: 2, userMessages: 2, assistantMessages: 2, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  menor.tools = [];
  menor.period = { from: menor.timeline.points[0].date, to: menor.timeline.points[1].date };
  const arq = join(m.raiz, "menor.json");
  await writeFile(arq, JSON.stringify(menor));
  m.limpar();
  await m.cmd(["restore", "--from-file", arq]);
  assert.match(m.texto(), /Já existe um histórico local/);
  assert.match(m.texto(), /Nada gravado \(sem terminal interativo\)/);
  assert.equal(await readFile(m.paths.historico, "utf8"), antes);
  await m.cmd(["restore", "--from-file", arq, "--yes"]);
  assert.match(m.texto(), /local atual: 5 dias/);
  assert.match(m.texto(), /restaurado:  2 dias/);
  assert.match(m.texto(), /resultado:   5 dias/);
  assert.equal(await diasHist(m), 5, "o restaurado menor nunca reduz o histórico local");
  // terminal respondendo n
  const tty = { isTTY: true, perguntas: [], resposta: "n", async ask(p) { this.perguntas.push(p); return this.resposta; } };
  await m.cmd(["restore", "--from-file", arq], tty);
  assert.match(m.texto(), /Cancelado: nada foi gravado/);
});

test("baseline = MÁXIMO de history.json (velho) e metrics.json do clone (novo); se um é inválido usa o outro com aviso", async () => {
  const m = await preparar(3);
  const velho = await readFile(m.paths.historico, "utf8");
  await claudeFalso(m.home, { dia: "2026-03-04", sessao: "s7", pasta: "p7" });
  await claudeFalso(m.home, { dia: "2026-03-05", sessao: "s8", pasta: "p8" });
  await m.cmd(["export"]);
  await m.cmd(["publish", "--yes"]);
  assert.equal(await diasHist(m), 5);
  // history.json fica velho (3 dias) e os registros somem: o clone (5 dias) completa
  await writeFile(m.paths.historico, velho);
  await rm(join(m.home, ".claude"), { recursive: true, force: true });
  m.limpar();
  await m.cmd(["export"]);
  assert.equal((await m.json()).timeline.points.length, 5);
  assert.match(m.texto(), /history\.json \+ clone local/);
  // history.json inválido: usa o clone com aviso
  await writeFile(m.paths.historico, "{ lixo");
  m.limpar();
  await m.cmd(["export"]);
  assert.equal((await m.json()).timeline.points.length, 5);
  assert.match(m.texto(), /histórico ignorado: history\.json: JSON ilegível/);
});

test("history reset: só com confirmação ([s/N] ou --yes), sem terminal nada é apagado", async () => {
  const m = await preparar(2);
  await m.cmd(["history", "reset"]);
  assert.match(m.texto(), /Nada feito \(sem terminal interativo\)/);
  assert.equal(existsSync(m.paths.historico), true);
  const tty = { isTTY: true, perguntas: [], resposta: "n", async ask(p) { this.perguntas.push(p); return this.resposta; } };
  await m.cmd(["history", "reset"], tty);
  assert.match(tty.perguntas[0], /\[s\/N\]/);
  assert.equal(existsSync(m.paths.historico), true);
  tty.resposta = "s";
  await m.cmd(["history", "reset"], tty);
  assert.equal(existsSync(m.paths.historico), false);
  assert.match(m.texto(), /Histórico local apagado/);
  await assert.rejects(m.cmd(["history"]), /history reset/);
  await m.cmd(["history", "reset", "--yes"]);
  assert.match(m.texto(), /Não havia histórico local/);
  assert.equal(diasRemoto(m), 2, "o publicado não é tocado");
});

test("restore --from-file recusa caminho de rede/UNC no Windows (modo offline)", async () => {
  for (const p of ["\\\\servidor\\pasta\\x.json", "//servidor/pasta/x.json", "\\\\?\\C:\\x.json", "\\\\.\\pipe\\x"]) assert.ok(motivoCaminhoDeRede(p, "win32"), p);
  assert.equal(motivoCaminhoDeRede("C:\\Users\\x\\metrics.json", "win32"), null);
  assert.equal(motivoCaminhoDeRede("//servidor/pasta/x.json", "linux"), null);
  const m = await maquina();
  if (process.platform === "win32") {
    await assert.rejects(m.cmd(["restore", "--from-file", "\\\\servidor-que-nao-existe\\pasta\\x.json"]), /recuso caminho de rede\/UNC/);
    await assert.rejects(m.cmd(["restore", "--from-file", "//servidor-que-nao-existe/pasta/x.json"]), /recuso caminho de rede\/UNC/);
  }
  await assert.rejects(m.cmd(["restore", "--from-file", "\\\\?\\C:\\x.json"]), /recuso/);
});

test("lerArquivoLimitado: lê no máximo limite+1 bytes (arquivo maior que o teto é recusado sem ser lido inteiro)", async () => {
  const dir = await tmp("ai-usage-metrics-teste-");
  const f = join(dir, "grande.json");
  await writeFile(f, "x".repeat(1000));
  assert.match((await lerArquivoLimitado(f, { limite: 100 })).motivo, /grande demais/);
  assert.equal((await lerArquivoLimitado(f, { limite: 1000 })).texto.length, 1000, "exatamente no teto passa");
  assert.match((await lerArquivoLimitado(f, { limite: 999 })).motivo, /grande demais/);
  assert.equal(await lerArquivoLimitado(join(dir, "nao-existe")), null);
  assert.match((await lerArquivoLimitado(dir)).motivo, /não é um arquivo comum/);
});

// ---------- helpers de JSON sintético ----------
const HOME = "/home/exemplo";
const AGORA = new Date("2026-03-20T12:00:00Z");
const META = [
  { id: "claude-code", name: "Claude Code", capabilities: { messages: true, tokens: true } },
  { id: "cline", name: "Cline (CLI)", capabilities: { messages: true, tokens: true } },
];
async function gerarJson(dias) {
  const ev = [];
  for (const x of dias) {
    const ts = Date.parse(`${x.d}T10:00:00Z`);
    const base = { tool: "claude-code", project: `${HOME}/dev/segredo-x`, session: `s-${x.d}` };
    for (let i = 0; i < (x.u ?? 1); i++) ev.push({ ...base, ts: ts + i, kind: "user" });
    const [input, output, cacheRead, cacheWrite] = x.tok ?? [10, 5, 100, 10];
    ev.push({ ...base, ts: ts + 100, kind: "assistant", tokens: { input, output, cacheRead, cacheWrite } });
  }
  const agg = await aggregate(ev, { home: HOME, tools: META });
  return toPublic(agg, { allowlist: new Map(), home: HOME, now: AGORA });
}
void mkdir;
