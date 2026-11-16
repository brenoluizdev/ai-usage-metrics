// Histórico persistente: mescla da série diária, validação do baseline, history.json, restore. Sem rede (remoto = repositório bare local).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { aggregate } from "../src/aggregate.mjs";
import { main } from "../src/cli.mjs";
import { caminhos } from "../src/config.mjs";
import { carregarBaseline, gravarBaseline, mesclarHistorico, validarBaseline, validarTextoDeBaseline } from "../src/historico.mjs";
import { garantirSemVazamento } from "../src/privacy.mjs";
import { toPublic } from "../src/public.mjs";
import { exigirMetricasValidas } from "../src/schema.mjs";
import { claudeFalso } from "./fixtures.mjs";

const ENV = {
  GIT_CONFIG_GLOBAL: join(tmpdir(), "ai-usage-metrics-sem-config"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Teste",
  GIT_AUTHOR_EMAIL: "teste@exemplo.invalid",
  GIT_COMMITTER_NAME: "Teste",
  GIT_COMMITTER_EMAIL: "teste@exemplo.invalid",
  GIT_TERMINAL_PROMPT: "0",
  AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE: "1",
};
Object.assign(process.env, ENV);

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

/** dias: [{ d: "2026-03-01", tool?, s?, u?, a?, tok?: [in,out,cr,cw], proj? }] -> JSON público válido (sintético). */
async function gerar(dias, { projeto = "segredo-x" } = {}) {
  const ev = [];
  for (const x of dias) {
    const tool = x.tool ?? "claude-code";
    const ts = Date.parse(`${x.d}T10:00:00Z`);
    const base = { tool, project: `${HOME}/dev/${x.proj ?? projeto}`, session: x.s ?? `s-${x.d}` };
    for (let i = 0; i < (x.u ?? 1); i++) ev.push({ ...base, ts: ts + i, kind: "user" });
    for (let i = 0; i < (x.a ?? 1); i++) {
      const [input, output, cacheRead, cacheWrite] = i === 0 ? (x.tok ?? [10, 5, 100, 10]) : [0, 0, 0, 0];
      ev.push({ ...base, ts: ts + 100 + i, kind: "assistant", tokens: { input, output, cacheRead, cacheWrite } });
    }
  }
  const agg = await aggregate(ev, { home: HOME, tools: META });
  return toPublic(agg, { allowlist: new Map(), home: HOME, now: AGORA });
}
const dias = (inicio, n, extra = {}) => Array.from({ length: n }, (_, i) => ({ d: new Date(Date.parse(`${inicio}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), ...extra }));
const mesclar = (l, b, extra = {}) => mesclarHistorico(l, b, { tools: META, hoje: AGORA, ...extra });
const clone = (o) => JSON.parse(JSON.stringify(o));
const semData = (j) => ({ ...j, generatedAt: "x" });

test("mescla: dias disjuntos vêm do histórico e do local; totais, período, dias ativos e ferramentas são recalculados", async () => {
  const base = await gerar([...dias("2026-01-01", 5), { d: "2026-01-03", tool: "cline", s: "c1" }]);
  const local = await gerar(dias("2026-02-10", 3));
  const { json, resumo } = mesclar(local, base);
  exigirMetricasValidas(json);
  garantirSemVazamento(JSON.stringify(json), HOME);
  assert.equal(json.timeline.points.length, 8);
  assert.deepEqual(resumo, { diasLocais: 3, diasBaseline: 5, diasDoHistorico: 5, diasSoLocais: 3, diasElevados: 0, diasFinal: 8, locaisComMuitoMenos: false });
  assert.deepEqual(json.period, { from: "2026-01-01", to: "2026-02-12" });
  assert.equal(json.totals.activeDays, 8);
  assert.equal(json.totals.sessions, base.totals.sessions + local.totals.sessions);
  assert.equal(json.totals.userMessages, base.totals.userMessages + local.totals.userMessages);
  assert.equal(json.totals.assistantMessages, base.totals.assistantMessages + local.totals.assistantMessages);
  // tokens: baseline + o que o local acrescentou, com o total batendo com a soma (exigirMetricasValidas) e com a série
  assert.equal(json.totals.tokens.total, json.timeline.points.reduce((a, p) => a + p.tokens, 0));
  const cc = json.tools.find((t) => t.id === "claude-code");
  const cl = json.tools.find((t) => t.id === "cline");
  assert.equal(cc.firstActivity, "2026-01-01");
  assert.equal(cc.lastActivity, "2026-02-12");
  assert.equal(cl.firstActivity, "2026-01-03");
  assert.equal(cl.lastActivity, "2026-01-03");
  assert.equal(cc.sessions, 5 + 3);
});

test("mescla: dia nos dois lados fica com o MAIOR valor campo a campo; elevados são contados", async () => {
  const base = await gerar([{ d: "2026-03-01", u: 5, a: 4, tok: [100, 50, 1000, 100] }, { d: "2026-03-02", u: 1, a: 1, tok: [1, 1, 1, 1] }]);
  const local = await gerar([{ d: "2026-03-01", u: 2, a: 1, tok: [1, 1, 1, 1] }, { d: "2026-03-02", u: 3, a: 2, tok: [50, 50, 50, 50] }]);
  const { json, resumo } = mesclar(local, base);
  const [p1, p2] = json.timeline.points;
  assert.equal(p1.userMessages, 5);
  assert.equal(p1.assistantMessages, 4);
  assert.equal(p1.tokens, 1250);
  assert.equal(p2.userMessages, 3);
  assert.equal(p2.tokens, 200);
  assert.equal(p1.byTool["claude-code"].userMessages, 5);
  assert.equal(resumo.diasElevados, 1, "só o dia 1 mudou em relação ao local (o dia 2 já era o maior no local)");
  assert.equal(resumo.diasSoLocais + resumo.diasDoHistorico, 0);
  exigirMetricasValidas(json);
});

test("mescla: baseline vazio não muda nada; local vazio devolve exatamente a série e os totais do baseline (PC formatado)", async () => {
  const vazio = await gerar([]);
  const local = await gerar(dias("2026-03-01", 4));
  assert.deepEqual(mesclar(local, vazio).json, local);
  const { json, resumo } = mesclar(vazio, local);
  assert.deepEqual(json.timeline.points, local.timeline.points);
  assert.deepEqual(json.totals, { ...local.totals, projects: 0 });
  assert.deepEqual(json.tools, local.tools);
  assert.deepEqual(json.period, local.period);
  assert.equal(resumo.locaisComMuitoMenos, true);
  assert.equal(json.projects.length, 0, "o ranking de projetos NÃO é restaurado");
});

test("baseline inválido, adulterado, sintético ou grande demais é recusado com motivo (sem repetir o conteúdo)", async () => {
  const bom = await gerar(dias("2026-03-01", 2));
  assert.equal(validarBaseline(bom, { home: HOME }).ok, true);
  const casos = [
    [(j) => (j.extra = "x"), /esquema/],
    [(j) => (j.totals.tokens.total += 1), /esquema/],
    [(j) => (j.timeline.points[0].date = "2026-13-45"), /esquema/],
    [(j) => (j.schemaVersion = 2), /esquema/],
    [(j) => (j.synthetic = true), /sintético/],
  ];
  for (const [mut, padrao] of casos) {
    const j = clone(bom);
    mut(j);
    const r = validarBaseline(j, { home: HOME });
    assert.equal(r.ok, false);
    assert.match(r.motivo, padrao);
  }
  assert.match(validarTextoDeBaseline("{ não é json SEGREDO", { home: HOME }).motivo, /^JSON ilegível$/);
  assert.match(validarTextoDeBaseline(" ".repeat(5 * 1024 * 1024 + 1), { home: HOME }).motivo, /grande demais/);
});

test("mescla: ferramenta fora do registro é descartada com aviso e não entra nos totais nem nas ferramentas", async () => {
  const base = await gerar([{ d: "2026-01-01", u: 2, a: 2 }, { d: "2026-01-01", tool: "cline", s: "c", u: 4, a: 3, tok: [7, 7, 7, 7] }]);
  const meta = clone(base);
  // renomeia "cline" para uma ferramenta que este registro não conhece
  const txt = JSON.stringify(meta).replaceAll('"cline"', '"ferramenta-nova"').replace("Cline (CLI)", "Cline (CLI)");
  const adulterado = JSON.parse(txt);
  const local = await gerar([]);
  const avisos = [];
  const { json } = mesclar(local, adulterado, { avisar: (m) => avisos.push(m) });
  assert.ok(avisos.some((a) => /ferramenta-nova/.test(a)));
  assert.ok(!JSON.stringify(json).includes("ferramenta-nova"));
  const p = json.timeline.points[0];
  assert.equal(p.userMessages, 2, "mensagens da ferramenta descartada saem do dia");
  assert.equal(p.tokens, 125, "tokens da ferramenta descartada saem do dia");
  assert.deepEqual(json.tools.map((t) => t.id), ["claude-code"]);
  assert.equal(json.totals.userMessages, 2);
  exigirMetricasValidas(json);
  // o registro também restringe: com --tool só entra o que está em opts.tools
  const so = mesclarHistorico(local, base, { tools: [META[0]], hoje: AGORA }).json;
  assert.deepEqual(so.tools.map((t) => t.id), ["claude-code"]);
});

test("mescla: projetos e totals.projects vêm só do local; nomes do baseline nunca entram", async () => {
  const base = await gerar(dias("2026-01-01", 3, { proj: "so-no-baseline" }));
  const local = await gerar(dias("2026-03-01", 2, { proj: "so-no-local" }));
  const { json } = mesclar(local, base);
  assert.deepEqual(json.projects, local.projects);
  assert.equal(json.totals.projects, local.totals.projects);
  assert.ok(json.projects.every((p) => /^projeto-privado-\d+$/.test(p.name)));
});

test("mescla: datas fora de 2000..amanhã no baseline são descartadas e o resultado continua válido", async () => {
  const base = await gerar(dias("2026-03-01", 2));
  base.timeline.points.push({ ...clone(base.timeline.points[0]), date: "2026-12-31" }, { ...clone(base.timeline.points[0]), date: "1999-01-01" });
  const avisos = [];
  const { json } = mesclar(await gerar([]), base, { avisar: (m) => avisos.push(m) });
  assert.equal(json.timeline.points.length, 2);
  assert.ok(avisos.some((a) => /fora de 2000/.test(a)));
  assert.deepEqual(json.period, { from: "2026-03-01", to: "2026-03-02" });
});

test("mescla: idempotente (mesmo baseline e registros = mesmo JSON; reaplicar sobre o próprio resultado não infla)", async () => {
  const base = await gerar([...dias("2026-01-01", 6, { u: 3, a: 2 }), ...dias("2026-03-01", 2, { tool: "cline", s: "cx" })]);
  const local = await gerar([...dias("2026-03-01", 4, { u: 5, a: 3, tok: [9, 9, 9, 9] }), ...dias("2026-03-02", 1, { tool: "cline", s: "cy", u: 9 })]);
  const a = mesclar(local, base).json;
  assert.deepEqual(mesclar(local, base).json, a);
  assert.deepEqual(mesclar(local, a).json, a, "o resultado vira o baseline seguinte e nada muda");
  assert.deepEqual(mesclar(a, a).json, a);
  assert.deepEqual(mesclar(a, mesclar(local, a).json).json, a);
  exigirMetricasValidas(a);
});

test("mescla: sem nada a acrescentar o detalhamento de tokens local é mantido exato; com acréscimo o total da série é respeitado", async () => {
  const local = await gerar(dias("2026-03-01", 3, { tok: [11, 22, 33, 44] }));
  const igual = mesclar(local, clone(local)).json;
  assert.deepEqual(igual.totals.tokens, local.totals.tokens);
  const base = await gerar(dias("2026-01-01", 2, { tok: [1000, 0, 0, 0] }));
  const { json } = mesclar(local, base);
  // detalhamento = baseline + o excedente (dias só locais) na proporção do local
  assert.equal(json.totals.tokens.total, json.timeline.points.reduce((a, p) => a + p.tokens, 0));
  assert.ok(json.totals.tokens.input >= 2000);
});

test("mescla: respeita o teto de pontos do esquema (mais recentes) com aviso", async () => {
  const base = await gerar([{ d: "2026-03-01" }]);
  const antigos = Array.from({ length: 4001 }, (_, i) => ({ ...clone(base.timeline.points[0]), date: new Date(Date.UTC(2010, 0, 1) + i * 86_400_000).toISOString().slice(0, 10) }));
  const grande = { ...clone(base), timeline: { ...base.timeline, points: antigos.slice(0, 4000) } };
  const avisos = [];
  const { json } = mesclar(await gerar([{ d: "2026-03-05" }]), grande, { avisar: (m) => avisos.push(m) });
  assert.equal(json.timeline.points.length, 4000);
  assert.equal(json.timeline.points.at(-1).date, "2026-03-05");
  assert.ok(avisos.some((a) => /4000 mais recentes/.test(a)));
  assert.ok(json.totals.activeDays >= 4001);
  exigirMetricasValidas(json);
});

// ---------- history.json: gravação e leitura ----------

test("gravarBaseline: atômico, 0600, sem sobras .tmp, recusa texto inválido e link simbólico", async () => {
  const dir = await tmp("ai-usage-metrics-teste-");
  const paths = caminhos(join(dir, "estado"));
  const bom = JSON.stringify(await gerar(dias("2026-03-01", 2)), null, 2) + "\n";
  await gravarBaseline(paths, bom, { home: HOME });
  assert.equal(await readFile(paths.historico, "utf8"), bom);
  if (process.platform !== "win32") assert.equal((await stat(paths.historico)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(paths.dir)).filter((n) => n.endsWith(".tmp")), []);
  await assert.rejects(gravarBaseline(paths, "{}", { home: HOME }), /não gravei o histórico/);
  await assert.rejects(gravarBaseline(paths, bom.replace('"synthetic": false', '"synthetic": true'), { home: HOME }), /sintético/);
  assert.equal(await readFile(paths.historico, "utf8"), bom, "falha não altera o arquivo anterior");

  // link simbólico no destino: recusado (se o SO deixar criar o link)
  const alvo = join(dir, "alheio.txt");
  await writeFile(alvo, "alheio");
  await rm(paths.historico);
  try {
    await symlink(alvo, paths.historico);
  } catch {
    return; // sem privilégio para criar links neste SO
  }
  await assert.rejects(gravarBaseline(paths, bom, { home: HOME }), /link simbólico/);
  assert.equal(await readFile(alvo, "utf8"), "alheio");
  const avisos = [];
  assert.equal(await carregarBaseline({ paths, config: null, home: HOME, avisar: (m) => avisos.push(m) }), null);
  assert.ok(avisos.some((a) => /histórico ignorado: history\.json: é um link simbólico/.test(a)));
});

test("carregarBaseline: arquivo adulterado é ignorado com aviso; ausente é silencioso", async () => {
  const dir = await tmp("ai-usage-metrics-teste-");
  const paths = caminhos(join(dir, "estado"));
  const avisos = [];
  assert.equal(await carregarBaseline({ paths, config: null, home: HOME, avisar: (m) => avisos.push(m) }), null);
  assert.deepEqual(avisos, []);
  await mkdir(paths.dir, { recursive: true });
  const j = await gerar(dias("2026-03-01", 2));
  j.projects = [{ nome: "x" }];
  await writeFile(paths.historico, JSON.stringify(j));
  assert.equal(await carregarBaseline({ paths, config: null, home: HOME, avisar: (m) => avisos.push(m) }), null);
  assert.match(avisos.join("\n"), /histórico ignorado: history\.json: fora do esquema v1/);
  await writeFile(paths.historico, "{ lixo");
  await carregarBaseline({ paths, config: null, home: HOME, avisar: (m) => avisos.push(m) });
  assert.match(avisos.join("\n"), /JSON ilegível/);
});

// ---------- CLI: export, publish, restore ----------

const CINCO = ["metrics.json", "metrics.model-1.svg", "metrics.model-2.svg", "metrics.model-3.svg", "metrics.svg"];
const gitRemoto = (remoto, ...args) => execFileSync("git", [`--git-dir=${remoto}`, ...args], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "ignore"] }).trim();

async function maquina({ remoto, raiz, publicos = "projeto-alfa" } = {}) {
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
  await cmd(["init", "--user", "fulano", "--remote", remoto, "--public", publicos, "--title", "Meu painel"]);
  return { raiz, remoto, stateDir, paths, home, cmd, io, saidas, texto: () => saidas.join("\n"), json: async () => JSON.parse(await readFile(paths.json, "utf8")) };
}

test("export: baseline em history.json é mesclado, mostra o resumo e o AVISO de registros locais com muito menos dias; --no-history, history:false e --since desligam", async () => {
  const m = await maquina();
  await claudeFalso(m.home, { dia: "2026-03-01" });
  const base = await gerar(dias("2026-01-01", 10));
  await mkdir(m.stateDir, { recursive: true });
  await writeFile(m.paths.historico, JSON.stringify(base));

  await m.cmd(["export"]);
  const j = await m.json();
  assert.equal(j.timeline.points.length, 11);
  assert.match(m.texto(), /Histórico: série diária mesclada .*history\.json.*: 10 dia\(s\) vieram só do histórico, 1 são só locais, 0 foram elevados/);
  assert.match(m.texto(), /ATENÇÃO: os registros locais têm só 1 dia\(s\) e o histórico mantém 10/);
  exigirMetricasValidas(j);
  assert.equal(j.projects.length, 1, "projetos só dos registros locais");
  assert.deepEqual(j.projects.map((p) => p.name), ["projeto-alfa"]);

  // dry-run do publish repete o resumo e o aviso (vindos do último export)
  await m.cmd(["publish", "--dry-run"]);
  assert.match(m.texto(), /\(do último export\) Histórico: .*10 dia\(s\)/);
  assert.match(m.texto(), /\(do último export\) ATENÇÃO/);

  // idempotência pelo CLI
  const antes = semData(await m.json());
  await m.cmd(["export"]);
  assert.deepEqual(semData(await m.json()), antes);

  await m.cmd(["export", "--no-history"]);
  assert.equal((await m.json()).timeline.points.length, 1);
  assert.doesNotMatch(m.texto().split("JSON gravado").at(-1), /Histórico: série/);

  await m.cmd(["export", "--since", "2026-02-01"]);
  assert.equal((await m.json()).timeline.points.length, 1);
  assert.match(m.texto(), /--since limita o período/);

  const cfg = JSON.parse(await readFile(m.paths.config, "utf8"));
  cfg.history = false;
  await writeFile(m.paths.config, JSON.stringify(cfg));
  await m.cmd(["export"]);
  assert.equal((await m.json()).timeline.points.length, 1);
  cfg.history = "talvez";
  await writeFile(m.paths.config, JSON.stringify(cfg));
  await assert.rejects(m.cmd(["export"]), /history deve ser true ou false/);
  cfg.history = true;
  cfg.historia = true;
  await writeFile(m.paths.config, JSON.stringify(cfg));
  await assert.rejects(m.cmd(["export"]), /chave desconhecida "historia"/);
});

test("export: history.json adulterado é ignorado com aviso e o export segue com os registros locais", async () => {
  const m = await maquina();
  await claudeFalso(m.home, { dia: "2026-03-01" });
  const base = await gerar(dias("2026-01-01", 3));
  base.tools[0].tokens.total += 99;
  await mkdir(m.stateDir, { recursive: true });
  await writeFile(m.paths.historico, JSON.stringify(base));
  await m.cmd(["export"]);
  assert.equal((await m.json()).timeline.points.length, 1);
  assert.match(m.texto(), /Aviso: histórico ignorado: history\.json: fora do esquema v1/);
});

test("publish: history.json só aparece DEPOIS de um envio bem-sucedido e é cópia do metrics.json publicado; 'nada mudou' também o restaura", async () => {
  const m = await maquina();
  await claudeFalso(m.home, { dia: "2026-03-01" });
  await m.cmd(["export"]);
  assert.equal(existsSync(m.paths.historico), false);
  await m.cmd(["publish", "--dry-run"]);
  assert.equal(existsSync(m.paths.historico), false, "dry-run não grava histórico");
  await writeFile(m.paths.json, "{ quebrado");
  await assert.rejects(m.cmd(["publish", "--yes"]));
  assert.equal(existsSync(m.paths.historico), false, "publish que falha não grava histórico");
  await m.cmd(["export"]);
  await m.cmd(["publish", "--yes"]);
  assert.equal(existsSync(m.paths.historico), true);
  assert.equal(await readFile(m.paths.historico, "utf8"), gitRemoto(m.remoto, "show", "main:metrics.json") + "\n");
  assert.match(m.texto(), /Histórico local atualizado/);
  await rm(m.paths.historico);
  await m.cmd(["publish", "--yes"]);
  assert.match(m.texto(), /Nada enviado: nada mudou/);
  assert.equal(existsSync(m.paths.historico), true, "quando nada mudou, o conteúdo já publicado vira o baseline");

  // com history:false o publish não grava history.json
  const cfg = JSON.parse(await readFile(m.paths.config, "utf8"));
  cfg.history = false;
  await writeFile(m.paths.config, JSON.stringify(cfg));
  await rm(m.paths.historico);
  await m.cmd(["publish", "--yes"]);
  assert.equal(existsSync(m.paths.historico), false);
});

test("export sem history.json usa o metrics.json do clone local (nosso) como baseline; clone adulterado é ignorado", async () => {
  const m = await maquina();
  await claudeFalso(m.home, { dia: "2026-03-01" });
  await m.cmd(["run", "--yes"], { isTTY: true, ask: async () => "s" });
  assert.deepEqual(gitRemoto(m.remoto, "ls-tree", "-r", "--name-only", "main").split("\n").sort(), CINCO);
  await rm(m.paths.historico);
  await rm(join(m.home, ".claude"), { recursive: true, force: true }); // "apagou as sessões"
  await m.cmd(["export"]);
  const j = await m.json();
  assert.equal(j.timeline.points.length, 1);
  assert.match(m.texto(), /clone local/);
  assert.equal(j.totals.sessions, 1);

  // clone com a config alterada (pushurl) deixa de ser confiável
  execFileSync("git", [`--git-dir=${join(m.paths.clone, ".git")}`, "config", "remote.origin.pushurl", "https://example.com/x.git"], { env: process.env });
  m.saidas.length = 0;
  await m.cmd(["export"]);
  assert.equal((await m.json()).timeline.points.length, 0);
  assert.match(m.texto(), /histórico ignorado: clone local: a configuração do clone tinha chaves inesperadas/);
});

test("restore: confirmação, repositório vazio, JSON inválido no remoto, --from-file e o cenário completo 'formatar o PC'", async () => {
  // PC antigo: registros em 3 dias, publicados
  const a = await maquina();
  await claudeFalso(a.home, { dia: "2026-03-01", sessao: "s1" });
  await claudeFalso(a.home, { dia: "2026-03-02", sessao: "s2", pasta: "proj-b" });
  await claudeFalso(a.home, { dia: "2026-03-03", sessao: "s3", pasta: "proj-c" });
  await a.cmd(["export"]);
  const original = await a.json();
  assert.equal(original.timeline.points.length, 3);

  // repositório ainda vazio: diz claramente e não grava nada
  const vazio = await maquina({ remoto: a.remoto, raiz: a.raiz });
  await vazio.cmd(["restore", "--yes"]);
  assert.match(vazio.texto(), /Nada para restaurar: o repositório de dados está vazio/);
  assert.equal(existsSync(vazio.paths.historico), false);

  await a.cmd(["publish", "--yes"]);

  // PC novo: estado novo e vazio -> init -> restore
  const b = await maquina({ remoto: a.remoto, raiz: a.raiz });
  // sem --yes e sem terminal: nada de rede
  await b.cmd(["restore"]);
  assert.match(b.texto(), /Nada feito \(sem terminal interativo\)/);
  assert.equal(existsSync(b.paths.clone), false, "sem confirmação não houve rede nem clone");
  // terminal respondendo n
  b.io.isTTY = true;
  b.io.resposta = "n";
  await b.cmd(["restore"]);
  assert.match(b.texto(), /Cancelado: nada foi baixado/);
  assert.equal(existsSync(b.paths.clone), false);
  assert.match(b.io.perguntas.at(-1), /\[s\/N\]/);
  // terminal respondendo s
  b.io.resposta = "s";
  await b.cmd(["restore"]);
  assert.match(b.texto(), /Histórico restaurado em .*3 dias \(2026-03-01 a 2026-03-03\)/);
  assert.match(b.texto(), /ranking de projetos NÃO é restaurado/);
  assert.equal(existsSync(b.paths.historico), true);
  assert.equal(existsSync(join(b.paths.clone, ".git")), true, "usa o mesmo clone marcado do publish");
  assert.equal(existsSync(join(b.stateDir, "repo.owner.json")), true);

  // export com registros VAZIOS no PC novo: a série e os totais continuam
  b.io.isTTY = false;
  await b.cmd(["export"]);
  const novo = await b.json();
  assert.deepEqual(novo.timeline, original.timeline);
  assert.deepEqual(novo.totals, { ...original.totals, projects: 0 });
  assert.deepEqual(novo.period, original.period);
  assert.deepEqual(novo.tools, original.tools);
  assert.deepEqual(novo.projects, []);
  assert.match(b.texto(), /ATENÇÃO: os registros locais têm só 0 dia\(s\)/);
  // e segue válido para publicar (o publish confere esquema, ferramentas e allowlist)
  await b.cmd(["publish", "--dry-run"]);
  assert.match(b.texto(), /Validação: esquema v1 estrito OK/);

  // remoto com metrics.json inválido: restore recusa e não grava
  const c = await maquina({ remoto: a.remoto, raiz: a.raiz });
  const trabalho = join(a.raiz, "trabalho");
  execFileSync("git", ["clone", "-q", a.remoto, trabalho], { env: process.env });
  await writeFile(join(trabalho, "metrics.json"), JSON.stringify({ ...original, dono: "fulano" }));
  execFileSync("git", ["-C", trabalho, "commit", "-qam", "adulterado"], { env: process.env });
  execFileSync("git", ["-C", trabalho, "push", "-q", "origin", "main"], { env: process.env });
  await assert.rejects(c.cmd(["restore", "--yes"]), /restore recusado: o JSON fora do esquema v1/);
  assert.equal(existsSync(c.paths.historico), false);

  // --from-file: 100% offline
  const arq = join(a.raiz, "backup.json");
  await writeFile(arq, JSON.stringify(original));
  const d = await maquina({ remoto: a.remoto, raiz: a.raiz });
  await d.cmd(["restore", "--from-file", arq]);
  assert.match(d.texto(), /Histórico restaurado/);
  assert.equal(existsSync(d.paths.clone), false, "--from-file não toca na rede nem no clone");
  const sint = join(a.raiz, "sintetico.json");
  await writeFile(sint, JSON.stringify({ ...original, synthetic: true }));
  await assert.rejects(d.cmd(["restore", "--from-file", sint]), /sintético/);
  await assert.rejects(d.cmd(["restore", "--from-file", join(a.raiz, "nao-existe.json")]), /não existe/);
  await writeFile(sint, "lixo");
  await assert.rejects(d.cmd(["restore", "--from-file", sint]), /JSON ilegível/);
});
