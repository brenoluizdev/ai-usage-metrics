// Falsos positivos da guarda de regressão (não podem travar o agendador), referência inutilizável, mesclarBaselines e history.json ilegível.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { aggregate } from "../src/aggregate.mjs";
import { main } from "../src/cli.mjs";
import { caminhos } from "../src/config.mjs";
import { gravarHistoricoMonotonico, mesclarBaselines } from "../src/historico.mjs";
import { toPublic } from "../src/public.mjs";
import { avaliarRegressao, piorRegressao } from "../src/regressao.mjs";
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

const pastas = [];
after(async () => {
  for (const p of pastas) await rm(p, { recursive: true, force: true });
});
const tmp = async (prefixo) => {
  const p = await mkdtemp(join(tmpdir(), prefixo));
  pastas.push(p);
  return p;
};
const HOME = "/home/exemplo";
const AGORA = new Date("2026-03-20T12:00:00Z");
const META = [
  { id: "claude-code", name: "Claude Code", capabilities: { messages: true, tokens: true } },
  { id: "cline", name: "Cline (CLI)", capabilities: { messages: true, tokens: true } },
];
const clone = (o) => JSON.parse(JSON.stringify(o));

async function gerarJson(dias) {
  const ev = [];
  for (const x of dias) {
    const ts = Date.parse(`${x}T10:00:00Z`);
    const base = { tool: "claude-code", project: `${HOME}/dev/segredo-x`, session: `s-${x}` };
    ev.push({ ...base, ts, kind: "user" }, { ...base, ts: ts + 100, kind: "assistant", tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 10 } });
  }
  return toPublic(await aggregate(ev, { home: HOME, tools: META }), { allowlist: new Map(), home: HOME, now: AGORA });
}

/** Acrescenta a ferramenta "ghost" (fora do registro) em todos os dias: 1 sessão, 1 mensagem, 100 tokens por dia. */
function comGhost(j) {
  const r = clone(j);
  const n = r.timeline.points.length;
  for (const p of r.timeline.points) {
    p.byTool.ghost = { sessions: 1, userMessages: 1, tokens: 100 };
    p.sessions += 1;
    p.userMessages += 1;
    p.tokens += 100;
  }
  r.tools.push({ id: "ghost", name: "Ghost", provides: { messages: true, tokens: true }, sessions: n, userMessages: n, assistantMessages: 0, tokens: { input: 100 * n, output: 0, cacheRead: 0, cacheWrite: 0, total: 100 * n }, firstActivity: r.period.from, lastActivity: r.period.to });
  r.totals.sessions += n;
  r.totals.userMessages += n;
  r.totals.tokens.input += 100 * n;
  r.totals.tokens.total += 100 * n;
  return r;
}

const dia = (i) => new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);

test("guarda: ferramenta desconhecida na referência não dispara; perda real em ferramenta conhecida continua disparando", async () => {
  const plano = await gerarJson(["2026-03-01", "2026-03-02", "2026-03-03"]);
  const ref = comGhost(plano);
  exigirMetricasValidas(ref);
  assert.equal(avaliarRegressao(plano, ref), null);
  assert.equal(piorRegressao(plano, [ref]), null);
  const menor = await gerarJson(["2026-03-01", "2026-03-02"]);
  const r = avaliarRegressao(menor, ref);
  assert.ok(r, "perda real continua barrada");
  assert.equal(r.removidos, 1);
  assert.equal(r.antes.dias, 3);
  assert.equal(r.antes.tokens, plano.timeline.points.reduce((a, p) => a + p.tokens, 0), "números da referência já sem a ferramenta desconhecida");
});

test("guarda: datas futuras na referência (relógio adiantado em outro computador) são ignoradas", async () => {
  const plano = await gerarJson(["2026-03-01", "2026-03-02"]);
  const ref = clone(plano);
  ref.timeline.points.push({ ...clone(ref.timeline.points[0]), date: "2099-01-01" }, { ...clone(ref.timeline.points[0]), date: "1990-01-01" });
  assert.equal(avaliarRegressao(plano, ref), null);
});

test("guarda: janela de 4000 pontos: série cheia deslocada em um dia não dispara; remover um dia dentro da janela dispara", async () => {
  const base = await gerarJson(["2026-03-01"]);
  const molde = base.timeline.points[0];
  const montar = (indices) => {
    const j = clone(base);
    j.timeline.points = indices.map((i) => ({ ...clone(molde), date: dia(i) }));
    j.period = { from: dia(indices[0]), to: dia(indices.at(-1)) };
    j.totals.sessions = indices.length * 1;
    return j;
  };
  const faixa = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
  const ref = montar(faixa(0, 4000));
  const deslocado = montar(faixa(1, 4001));
  assert.equal(deslocado.timeline.points.length, 4000);
  assert.equal(avaliarRegressao(deslocado, ref), null, "o dia mais antigo saiu da janela: não é perda");
  const furado = montar([...faixa(1, 2000), ...faixa(2001, 4001), 4001]);
  assert.equal(furado.timeline.points.length, 4000);
  const r = avaliarRegressao(furado, ref);
  assert.ok(r && r.removidos === 1, "o dia 2000 sumiu de dentro da janela");
});

// ---------- CLI ----------
const gitRemoto = (remoto, ...args) => execFileSync("git", [`--git-dir=${remoto}`, ...args], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "ignore"] }).trim();

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
  const io = { isTTY: false, async ask() { return "n"; } };
  const cmd = (args, ioLocal = io) => main([...args, "--state-dir", stateDir, "--home", home], (l) => saidas.push(l), ioLocal);
  await cmd(["init", "--user", "fulano", "--remote", remoto, "--public", "projeto-alfa"]);
  return { raiz, remoto, stateDir, paths, home, cmd, saidas, texto: () => saidas.join("\n"), limpar: () => (saidas.length = 0) };
}

test("referência inutilizável (metrics.json inválido no remoto): o publish segue, mas avisa explicitamente que a proteção não pôde ser aplicada", async () => {
  const m = await maquina();
  const trabalho = join(m.raiz, "trabalho");
  execFileSync("git", ["clone", "-q", m.remoto, trabalho], { env: process.env });
  await writeFile(join(trabalho, "metrics.json"), "{ lixo");
  execFileSync("git", ["-C", trabalho, "add", "metrics.json"], { env: process.env });
  execFileSync("git", ["-C", trabalho, "commit", "-qm", "ruim"], { env: process.env });
  execFileSync("git", ["-C", trabalho, "push", "-q", "origin", "HEAD:main"], { env: process.env });
  await claudeFalso(m.home, { dia: "2026-03-01" });
  await m.cmd(["export"]);
  await m.cmd(["publish", "--yes"]);
  assert.match(m.texto(), /sem referência válida para comparar .*a proteção contra perda de histórico não pôde ser aplicada/);
  assert.equal(JSON.parse(gitRemoto(m.remoto, "show", "main:metrics.json")).timeline.points.length, 1, "não bloqueou");
});

test("referência inutilizável (baseline incoerente, sem clone): export e dry-run avisam com o motivo, sem repetir conteúdo", async () => {
  const m = await maquina();
  await claudeFalso(m.home, { dia: "2026-03-01" });
  const ruim = await gerarJson(["2026-02-01", "2026-02-02"]);
  ruim.totals.sessions = 1e15;
  await mkdir(m.stateDir, { recursive: true });
  await writeFile(m.paths.historico, JSON.stringify(ruim));
  await m.cmd(["export"]);
  assert.match(m.texto(), /sem referência válida para comparar \(o histórico local existe mas foi ignorado: history\.json: INCOERENTE/);
  m.limpar();
  await m.cmd(["publish", "--dry-run"]);
  assert.match(m.texto(), /sem referência válida para comparar/);
  assert.doesNotMatch(m.texto(), /1000000000000000/);
});

test("mesclarBaselines: ferramenta desconhecida é descartada com aviso (em qualquer dos lados) e não dá TypeError", async () => {
  const a = await gerarJson(["2026-03-01", "2026-03-02"]);
  const b = comGhost(await gerarJson(["2026-03-02", "2026-03-03"]));
  for (const [x, y] of [[a, b], [b, a]]) {
    x.generatedAt = "2026-03-10T00:00:00.000Z";
    y.generatedAt = "2026-03-09T00:00:00.000Z";
    const avisos = [];
    const { json } = mesclarBaselines(x, y, { avisar: (m) => avisos.push(m), hoje: AGORA });
    assert.ok(avisos.some((m) => /ghost/.test(m)));
    assert.ok(!JSON.stringify(json).includes("ghost"));
    assert.equal(json.timeline.points.length, 3);
    exigirMetricasValidas(json);
  }
});

test("history.json ilegível (aqui: é uma pasta) nunca é sobrescrito sem aviso; o publish em si não falha", async () => {
  const dir = await tmp("ai-usage-metrics-teste-");
  const paths = caminhos(join(dir, "estado"));
  await mkdir(paths.historico, { recursive: true }); // existe mas não é um arquivo comum
  const avisos = [];
  const texto = JSON.stringify(await gerarJson(["2026-03-01"]), null, 2) + "\n";
  const gravou = await gravarHistoricoMonotonico(paths, texto, { home: HOME, avisar: (m) => avisos.push(m) });
  assert.equal(gravou, false);
  assert.match(avisos.join("\n"), /ATENÇÃO: o history\.json existe mas está ilegível/);
  // continua sendo a pasta (não foi trocada por arquivo)
  await assert.rejects(readFile(paths.historico), /EISDIR|EPERM|EACCES/);
});

test("restore com baseline que tem ferramenta desconhecida e history.json existente: mensagem amigável, sem erro cru", async () => {
  const m = await maquina();
  await claudeFalso(m.home, { dia: "2026-03-01" });
  await m.cmd(["export"]);
  await m.cmd(["publish", "--yes"]);
  const arq = join(m.raiz, "novo.json");
  await writeFile(arq, JSON.stringify(comGhost(await gerarJson(["2026-02-10", "2026-02-11"]))));
  m.limpar();
  await m.cmd(["restore", "--from-file", arq, "--yes"]);
  assert.match(m.texto(), /ferramenta\(s\) fora do registro atual descartada\(s\): ghost/);
  assert.match(m.texto(), /Histórico restaurado/);
  assert.doesNotMatch(await readFile(m.paths.historico, "utf8"), /ghost/);
  assert.doesNotMatch(m.texto(), /TypeError|undefined/);
});
