// Robustez contra registros adversariais e travas de privacidade/operação. Fixtures sintéticas, pastas temporárias, sem rede.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, join, sep } from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { claudeCode } from "../src/adapters/claude-code.mjs";
import { cline } from "../src/adapters/cline.mjs";
import { MAX_TOKENS_POR_CAMPO, arquivoDentroDoLimite, lerLinhas, num, tsValido } from "../src/adapters/seguro.mjs";
import { aggregate } from "../src/aggregate.mjs";
import { instrucoesDeAgendamento } from "../src/cli.mjs";
import { main } from "../src/cli.mjs";
import { adquirirLock } from "../src/lock.mjs";
import { garantirSvgSemVazamento, lerAllowlist, validarAlias, validarTitulo } from "../src/privacy.mjs";
import { toPublic } from "../src/public.mjs";
import { renderTerminal } from "../src/report.mjs";
import { MAX_PONTOS, exigirMetricasValidas, validarMetricas } from "../src/schema.mjs";
import { gerarSvg, porMes } from "../src/svg.mjs";
import { clineFalso, homeFalsa } from "./fixtures.mjs";
import { metricasSinteticas } from "./sintetico.mjs";

const pastas = [];
after(async () => {
  for (const p of pastas) await rm(p, { recursive: true, force: true });
});
const tmp = async (prefixo = "ai-usage-metrics-rob-") => {
  const d = await mkdtemp(join(tmpdir(), prefixo));
  pastas.push(d);
  return d;
};
const coletar = async (adapter, ctx) => {
  const out = [];
  for await (const e of adapter.events(ctx)) out.push(e);
  return out;
};
const comAvisos = (ctx) => {
  const avisos = [];
  return { ...ctx, avisar: (m) => avisos.push(m), avisos };
};
const HOME = "C:\\Users\\fulano";

// ---------- 7. DoS por registros adversariais ----------

test("tsValido/num: datas fora de 2000..amanhã e números fora de faixa são descartados", () => {
  assert.equal(tsValido(Date.parse("2026-03-01T00:00:00Z")), true);
  for (const ruim of [1e300, 1e20, -1, 0, NaN, Infinity, "2026", null, Date.UTC(1999, 11, 31), Date.now() + 3 * 86_400_000]) assert.equal(tsValido(ruim), false, String(ruim));
  assert.equal(num(5), 5);
  for (const ruim of [1e300, 1.5, -1, 0, 2 ** 53, MAX_TOKENS_POR_CAMPO + 1, "5", NaN, Infinity, null]) assert.equal(num(ruim), 0, String(ruim));
  assert.equal(num(MAX_TOKENS_POR_CAMPO), MAX_TOKENS_POR_CAMPO);
});

test("cline: ts gigante (1e300) não derruba a agregação; eventos inválidos são descartados e os válidos contam", async () => {
  const home = await homeFalsa();
  pastas.push(home);
  await clineFalso(home);
  const msgs = join(home, ".cline", "data", "sessions", "s1", "s1.messages.json");
  const ok = Date.parse("2026-03-02T09:00:00.000Z");
  await writeFile(
    msgs,
    JSON.stringify({
      messages: [
        { role: "user", ts: 1e300, content: "x" },
        { role: "user", ts: 1e20, content: "x" },
        { role: "user", ts: -5, content: "x" },
        { role: "user", ts: ok, content: "x" },
        { role: "assistant", ts: ok, metrics: { inputTokens: 1e300, outputTokens: 7, cacheReadTokens: -3, cacheWriteTokens: 2.5 } },
      ],
    }),
  );
  const ev = await coletar(cline, { home });
  assert.equal(ev.filter((e) => e.kind === "user").length, 1, "só o ts válido");
  const asst = ev.find((e) => e.kind === "assistant");
  assert.deepEqual(asst.tokens, { input: 0, output: 7, cacheRead: 0, cacheWrite: 0 }, "tokens inválidos descartados");
  const agg = await aggregate(ev, { home });
  assert.ok(agg.dias.size >= 1);
});

test("aggregate: evento com ts absurdo vindo de qualquer fonte é descartado com aviso (não lança RangeError)", async () => {
  const avisos = [];
  const agg = await aggregate(
    [
      { tool: "a", project: null, session: "s", ts: 1e300, kind: "user" },
      { tool: "a", project: null, session: "s", ts: Date.parse("2026-01-01T00:00:00Z"), kind: "user" },
    ],
    { home: HOME, avisar: (m) => avisos.push(m) },
  );
  assert.equal(agg.total.userMessages, 1);
  assert.match(avisos.join(" "), /1 evento\(s\) com data inválida/);
});

test("aggregate: soma de tokens satura em vez de passar do limite do esquema", async () => {
  const ev = [];
  const t = { input: MAX_TOKENS_POR_CAMPO, output: MAX_TOKENS_POR_CAMPO, cacheRead: MAX_TOKENS_POR_CAMPO, cacheWrite: MAX_TOKENS_POR_CAMPO };
  for (let i = 0; i < 3; i++) ev.push({ tool: "claude-code", project: null, session: "s", ts: Date.parse("2026-01-01T00:00:00Z") + i, kind: "assistant", tokens: t });
  const agg = await aggregate(ev, { home: HOME });
  const pub = toPublic(agg, { allowlist: new Map(), home: HOME, now: new Date("2026-02-01T00:00:00Z") });
  assert.equal(pub.totals.tokens.total, 12_000_000_000);
  assert.equal(validarMetricas(pub).ok, true);
});

test("lerLinhas: descarta linha acima do limite sem estourar e segue com as próximas; trata CRLF e última linha sem quebra", async () => {
  const dir = await tmp();
  const f = join(dir, "x.jsonl");
  await writeFile(f, "curta1\r\n" + "x".repeat(500) + "\ncurta2\n" + "y".repeat(300) + "\nultima", "utf8");
  let descartadas = 0;
  const linhas = [];
  for await (const l of lerLinhas(f, { maxLinha: 100, aoDescartar: () => descartadas++ })) linhas.push(l);
  assert.deepEqual(linhas, ["curta1", "curta2", "ultima"]);
  assert.equal(descartadas, 2);
});

test("claude-code: linha gigante (acima de 16 MiB) é ignorada com aviso; ts absurdo não aborta; o resto da sessão conta", async () => {
  const home = await homeFalsa();
  pastas.push(home);
  const dir = join(home, ".claude", "projects", "proj-a");
  await mkdir(dir, { recursive: true });
  const cwd = "C:\\Users\\fulano\\Desktop\\projeto-alfa";
  const L = (o) => JSON.stringify(o);
  const conteudo = [
    L({ type: "user", cwd, timestamp: "2026-03-01T10:00:00.000Z", message: { role: "user", content: "oi" } }),
    L({ type: "user", cwd, timestamp: "2026-03-01T10:00:00.000Z", message: { role: "user", content: "x".repeat(17 * 1024 * 1024) } }),
    L({ type: "user", cwd, timestamp: "+275760-09-13T00:00:00.000Z", message: { role: "user", content: "futuro" } }),
    L({ type: "user", cwd, timestamp: "1970-01-01T00:00:00.000Z", message: { role: "user", content: "passado" } }),
    L({ type: "user", cwd, timestamp: "2026-03-01T11:00:00.000Z", message: { role: "user", content: "de novo" } }),
    L({ type: "assistant", cwd, timestamp: "2026-03-01T11:00:01.000Z", message: { id: "m1", model: "m", usage: { input_tokens: 1e300, output_tokens: 4, cache_read_input_tokens: -1, cache_creation_input_tokens: 0.5 } } }),
  ].join("\n");
  await writeFile(join(dir, "sess-1.jsonl"), conteudo + "\n", "utf8");
  const ctx = comAvisos({ home });
  const ev = await coletar(claudeCode, ctx);
  assert.equal(ev.filter((e) => e.kind === "user").length, 2, "só as duas linhas normais e válidas");
  assert.deepEqual(ev.find((e) => e.kind === "assistant").tokens, { input: 0, output: 4, cacheRead: 0, cacheWrite: 0 });
  assert.match(ctx.avisos.join(" "), /1 linha\(s\) maiores que o limite/);
});

test("arquivoDentroDoLimite: recusa arquivo grande demais (com aviso sem caminho) e não-arquivo", async () => {
  const dir = await tmp();
  const f = join(dir, "grande.json");
  await writeFile(f, "x".repeat(2000));
  const ctx = comAvisos({});
  assert.equal(await arquivoDentroDoLimite(f, 1000, ctx, "Teste"), false);
  assert.equal(await arquivoDentroDoLimite(f, 5000, ctx, "Teste"), true);
  assert.equal(await arquivoDentroDoLimite(dir, 5000, ctx, "Teste"), false, "pasta não é arquivo comum");
  assert.equal(ctx.avisos.length, 1);
  assert.ok(!ctx.avisos[0].includes(dir), "o aviso não vaza caminho");
});

test("MAX_PONTOS: mais dias que o esquema aceita degrada (fica com os mais recentes e avisa) em vez de falhar", async () => {
  const ev = [];
  const base = Date.UTC(2005, 0, 1);
  const dias = MAX_PONTOS + 120;
  for (let d = 0; d < dias; d++) ev.push({ tool: "claude-code", project: null, session: `s${d}`, ts: base + d * 86_400_000, kind: "user" });
  const avisos = [];
  const agg = await aggregate(ev, { home: HOME });
  const pub = toPublic(agg, { allowlist: new Map(), home: HOME, now: new Date("2026-06-01T00:00:00Z"), avisar: (m) => avisos.push(m) });
  assert.equal(pub.timeline.points.length, MAX_PONTOS);
  assert.equal(pub.totals.activeDays, dias);
  assert.match(avisos.join(" "), /só os 4000 mais recentes/);
  assert.doesNotThrow(() => exigirMetricasValidas(pub));
});

// ---------- 8. messages_path ----------

async function clineComMensagens(home, caminhoDasMensagens) {
  const db = join(home, ".cline", "data", "db");
  await mkdir(db, { recursive: true });
  const d = new DatabaseSync(join(db, "sessions.db"));
  d.exec("CREATE TABLE sessions (session_id TEXT, started_at TEXT, cwd TEXT, workspace_root TEXT, is_subagent INTEGER, messages_path TEXT)");
  d.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?)").run("s1", "2026-03-02T09:00:00.000Z", HOME + "\\Desktop\\p", HOME + "\\Desktop\\p", 0, caminhoDasMensagens);
  d.close();
}
const mensagensDeUsuario = JSON.stringify({ messages: [1, 2, 3].map((i) => ({ role: "user", ts: Date.parse("2026-03-02T09:00:00Z") + i, content: "x" })) });

test("cline: messages_path fora de ~/.cline não é lido (o aviso não mostra o caminho)", async () => {
  const home = await homeFalsa();
  const fora = await tmp();
  pastas.push(home);
  const alvo = join(fora, "alheio.json");
  await writeFile(alvo, mensagensDeUsuario);
  await clineComMensagens(home, alvo);
  const ctx = comAvisos({ home });
  const ev = await coletar(cline, ctx);
  assert.equal(ev.filter((e) => e.kind === "user").length, 0, "o arquivo de fora não pode ter sido lido");
  assert.equal(ev.filter((e) => e.kind === "session").length, 1, "a sessão em si continua contando");
  assert.match(ctx.avisos.join(" "), /fora de ~\/\.cline foi ignorado/);
  assert.ok(!ctx.avisos.join(" ").includes(fora));
});

test("cline: messages_path com '..' que escapa de ~/.cline, symlink para fora e diretório são recusados; o legítimo dentro de ~/.cline é lido", async () => {
  const home = await homeFalsa();
  const fora = await tmp();
  pastas.push(home);
  await mkdir(join(home, ".cline", "data"), { recursive: true });
  const alvo = join(fora, "alheio.json");
  await writeFile(alvo, mensagensDeUsuario);

  await clineComMensagens(home, [home, ".cline", "..", "..", basename(fora), "alheio.json"].join(sep));
  assert.equal((await coletar(cline, { home })).filter((e) => e.kind === "user").length, 0);

  await rm(join(home, ".cline", "data", "db"), { recursive: true });
  await clineComMensagens(home, join(home, ".cline", "data"));
  assert.equal((await coletar(cline, { home })).filter((e) => e.kind === "user").length, 0, "diretório não é arquivo comum");

  await rm(join(home, ".cline", "data", "db"), { recursive: true });
  const link = join(home, ".cline", "data", "link.json");
  try {
    await symlink(alvo, link);
    await clineComMensagens(home, link);
    assert.equal((await coletar(cline, { home })).filter((e) => e.kind === "user").length, 0, "symlink que sai de ~/.cline");
    await rm(join(home, ".cline", "data", "db"), { recursive: true });
  } catch (e) {
    if (e.code !== "EPERM" && e.code !== "EACCES") throw e;
  }

  const dentro = join(home, ".cline", "data", "ok.json");
  await writeFile(dentro, mensagensDeUsuario);
  await clineComMensagens(home, dentro);
  assert.equal((await coletar(cline, { home })).filter((e) => e.kind === "user").length, 3);
});

// ---------- 13. sqlite somente leitura ----------

test("sqlite: o adaptador abre os bancos em modo somente leitura (a opção readOnly funciona) e não altera o arquivo", async () => {
  const home = await homeFalsa();
  pastas.push(home);
  await clineFalso(home);
  const dbArquivo = join(home, ".cline", "data", "db", "sessions.db");
  const antes = await readFile(dbArquivo);
  const ro = new DatabaseSync(dbArquivo, { readOnly: true });
  assert.throws(() => ro.exec("INSERT INTO sessions (session_id) VALUES ('x')"), /readonly|read-only|attempt to write/i);
  ro.close();
  await coletar(cline, { home });
  assert.deepEqual(await readFile(dbArquivo), antes, "o banco do Cline não pode mudar");
  const fonte = await readFile(new URL("../src/adapters/cline.mjs", import.meta.url), "utf8");
  const fonte2 = await readFile(new URL("../src/adapters/chatgpt-codex-app.mjs", import.meta.url), "utf8");
  for (const src of [fonte, fonte2]) assert.match(src, /readOnly: true/);
});

// ---------- 9. colisão de nomes e caminho completo na allowlist ----------

const evento = (cwd, sessao, dia) => ({ tool: "claude-code", project: cwd, session: sessao, ts: Date.parse(`2026-03-${dia}T10:00:00Z`), kind: "user" });
const duasPastas = [
  evento("C:\\Users\\fulano\\Desktop\\app", "s1", "01"),
  evento("C:\\Users\\fulano\\trabalho\\cliente\\app", "s2", "02"),
  evento("C:\\Users\\fulano\\trabalho\\cliente\\app", "s3", "03"),
];

test("allowlist por nome: duas pastas homônimas viram um nome público e geram aviso", async () => {
  const avisos = [];
  const agg = await aggregate(duasPastas, { home: HOME });
  const pub = toPublic(agg, { allowlist: lerAllowlist({ publicProjects: ["app"] }, { home: HOME }), home: HOME, avisar: (m) => avisos.push(m) });
  assert.equal(pub.projects.length, 1);
  assert.equal(pub.projects[0].name, "app");
  assert.equal(pub.projects[0].sessions, 3);
  assert.match(avisos.join(" "), /nome público "app" junta 2 pastas distintas/);
});

test("allowlist por caminho completo: só a pasta indicada fica pública; a homônima continua anonimizada, sem aviso", async () => {
  const avisos = [];
  const agg = await aggregate(duasPastas, { home: HOME });
  const allow = lerAllowlist({ publicProjects: { "C:\\Users\\fulano\\Desktop\\App\\": "app-pessoal" } }, { home: HOME });
  assert.deepEqual([...allow], [["c:/users/fulano/desktop/app", "app-pessoal"]]);
  const pub = toPublic(agg, { allowlist: allow, home: HOME, avisar: (m) => avisos.push(m) });
  const publico = pub.projects.find((p) => p.public);
  assert.equal(publico.name, "app-pessoal");
  assert.equal(publico.sessions, 1);
  const privado = pub.projects.find((p) => !p.public);
  assert.match(privado.name, /^projeto-privado-\d+$/);
  assert.equal(privado.sessions, 2);
  assert.deepEqual(avisos, []);
  assert.doesNotMatch(JSON.stringify(pub), /cliente|trabalho/i);
});

test("report: soma homônimos mas avisa, e remove caracteres de controle dos nomes de pasta", async () => {
  const agg = await aggregate(
    [...duasPastas, evento("C:\\Users\\fulano\\dev\\ev\u001b[31mil\u0007x", "s9", "04")],
    { home: HOME },
  );
  const txt = renderTerminal(agg, { top: 10 });
  assert.match(txt, /AVISO: 2 pastas distintas se chamam "app"/);
  assert.ok(!/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/.test(txt), "nada de caractere de controle/escape na saída");
});

// ---------- 10. texto livre fora do esquema ----------

test("validarAlias: recusa usuário do SO, pasta pessoal, e-mail, caminho e nome de arquivo", () => {
  assert.doesNotThrow(() => validarAlias("meu-site", HOME));
  const usuario = userInfo().username;
  assert.doesNotThrow(() => validarAlias(`${usuario}-site`, HOME), "contém o usuário, mas não é igual: permitido");
  assert.throws(() => validarAlias(usuario, HOME), /igual ao seu usuário do sistema/);
  assert.throws(() => validarAlias("FULANO", HOME), /igual ao seu usuário/, "o nome da pasta pessoal também conta, sem diferenciar maiúsculas");
  for (const ruim of ["a@b.com", "C:\\x", "dados.json", "base.sqlite", "/home/x", "x/y", "<b>", ""]) assert.throws(() => validarAlias(ruim, HOME), /Nome público inválido/, ruim);
  assert.throws(() => lerAllowlist({ publicProjects: { pasta: "a@b.com" } }, { home: HOME }), /Nome público inválido/);
});

test("título hostil: e-mail, caminho, controle e tamanho são recusados na config e no --title; o SVG final também passa pela barreira", async () => {
  for (const ruim of ["contato fulano@mail.com", "C:\\Users\\fulano\\meu painel", "meu.json", "a\u0007b", "x".repeat(61), "/home/fulano/x"]) {
    assert.throws(() => validarTitulo(ruim, HOME), /title/, ruim);
  }
  assert.doesNotThrow(() => validarTitulo("Meu painel de IA", HOME));

  const j = await metricasSinteticas();
  garantirSvgSemVazamento(gerarSvg(j, { titulo: "Painel" }), "/home/exemplo"); // SVG normal (com xmlns) passa
  const hostil = gerarSvg(j, { titulo: "C:\\Users\\fulano\\segredo" });
  assert.throws(() => garantirSvgSemVazamento(hostil, "/home/exemplo"), /privacidade/);
  const comScript = gerarSvg(j, { titulo: '</title><script>alert(1)</script>' });
  assert.ok(!comScript.includes("<script"), "o escape do SVG continua valendo");

  const raiz = await tmp();
  const saidas = [];
  const io = { isTTY: false, ask: async () => "" };
  await main(["init", "--user", "fulano", "--state-dir", raiz], () => {}, io);
  await mkdir(join(raiz, "out"), { recursive: true });
  await writeFile(join(raiz, "out", "metrics.json"), JSON.stringify(j));
  await assert.rejects(main(["render", "--state-dir", raiz, "--title", "oi fulano@mail.com"], (l) => saidas.push(l), io), /title recusado/);
  await assert.rejects(main(["init", "--user", "fulano", "--title", "ver C:\\Users\\x", "--state-dir", join(raiz, "b")], () => {}, io), /title recusado/);
});

// ---------- 11. agendamento ----------

test("agendamento: argumentos citados (inclusive --state-dir), % escapado no cron, aspas simples tratadas, log respeita --state-dir", () => {
  const stateDir = "C:\\Meus Dados\\it's 50%\\estado";
  const comPorcento = instrucoesDeAgendamento({ stateDir, node: "C:\\Program Files\\nodejs\\node.exe", bin: "C:\\bin\\x.mjs" });
  assert.match(comPorcento, /cmd\.exe:\n {4}\(comando não gerado para este shell\)/, "% no cmd não é suportado no schtasks: não imprime um comando que expande variável");
  assert.doesNotMatch(comPorcento, /schtasks \/Create/);

  const t = instrucoesDeAgendamento({ stateDir: "/home/o'neil/estado dir", node: "/usr/bin/node", bin: "/opt/ai usage/bin.mjs" });
  assert.match(t, /\/TR "\\"\/usr\/bin\/node\\" \\"\/opt\/ai usage\/bin\.mjs\\" \\"run\\" \\"--non-interactive\\" \\"--state-dir\\" \\"\/home\/o'neil\/estado dir\\""/);
  assert.match(t, /0 12 \* \* \* umask 077; '\/usr\/bin\/node' '\/opt\/ai usage\/bin\.mjs' 'run' '--non-interactive' '--state-dir' '\/home\/o'\\''neil\/estado dir' >> '\/home\/o'\\''neil\/estado dir\/run\.log' 2>&1/);
  assert.match(t, /o schtasks grava o caminho do Node usado AGORA \(\/usr\/bin\/node\)/);

  const cron = instrucoesDeAgendamento({ stateDir: "/x/100%", node: "/n", bin: "/b" }).split("\n").find((l) => l.includes("umask"));
  assert.match(cron, /100\\%/);
  assert.ok(!/[^\\]%/.test(cron), "todo % do cron está escapado");

  const padrao = instrucoesDeAgendamento({ node: "/n", bin: "/b" });
  assert.match(padrao, />> "\$HOME\/\.ai-usage-metrics\/run\.log" 2>&1/);
});

// ---------- 12. lock ----------

test("lock: segunda execução na mesma pasta é recusada com mensagem clara; libera ao terminar", async () => {
  const dir = await tmp();
  const liberar = await adquirirLock(dir);
  await assert.rejects(adquirirLock(dir), /Outra execução do ai-usage-metrics \(pid \d+/);
  await assert.rejects(adquirirLock(dir), /apague .*\.lock/);
  await liberar();
  const de_novo = await adquirirLock(dir);
  await de_novo();
});

test("lock: trava de processo morto ou velha demais é recuperada; trava de processo vivo e recente não", async () => {
  const dir = await tmp();
  // pid de um processo que já terminou
  const filho = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  const pidMorto = filho.pid;
  await new Promise((r) => filho.on("exit", r));
  await writeFile(join(dir, ".lock"), JSON.stringify({ pid: pidMorto, startedAt: new Date().toISOString() }));
  const l1 = await adquirirLock(dir);
  await l1();

  // pid vivo (o nosso), mas iniciada há mais de 6 h: velha
  await writeFile(join(dir, ".lock"), JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 7 * 3600_000).toISOString() }));
  const l2 = await adquirirLock(dir);
  await l2();

  // pid vivo e recente: bloqueia
  await writeFile(join(dir, ".lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await assert.rejects(adquirirLock(dir), /Outra execução/);
  await rm(join(dir, ".lock"));

  // arquivo ilegível e antigo: recupera
  await writeFile(join(dir, ".lock"), "lixo");
  const velho = new Date(Date.now() - 3600_000);
  const { utimes } = await import("node:fs/promises");
  await utimes(join(dir, ".lock"), velho, velho);
  await (await adquirirLock(dir))();
});

test("comando run/export/publish/render usam a trava e a soltam mesmo com erro", async () => {
  const raiz = await tmp();
  const io = { isTTY: false, ask: async () => "" };
  await main(["init", "--user", "fulano", "--state-dir", raiz], () => {}, io);
  const trava = await adquirirLock(raiz);
  for (const cmd of ["export", "render", "publish", "run"]) await assert.rejects(main([cmd, "--state-dir", raiz], () => {}, io), /Outra execução/, cmd);
  await main(["sources", "--state-dir", raiz, "--home", await homeFalsa()], () => {}, io); // leitura não precisa de trava
  await trava();
  await assert.rejects(main(["render", "--state-dir", raiz], () => {}, io), /não existe|arquivo/); // erro de outro tipo
  await assert.rejects(stat(join(raiz, ".lock")), /ENOENT/, "a trava foi solta apesar do erro");
});

// ---------- 13. informativos ----------

test("svg/schema: ids como constructor e __proto__ não viram propriedades herdadas", async () => {
  const pontos = [{ date: "2026-01-02", byTool: JSON.parse('{"__proto__":{"sessions":2,"userMessages":1},"constructor":{"sessions":3,"userMessages":0}}') }];
  const meses = porMes(pontos);
  assert.equal(meses[0].porFerramenta.get("__proto__").sessions, 2);
  assert.equal(meses[0].porFerramenta.get("constructor").sessions, 3);
  assert.equal(Object.getPrototypeOf(Object.prototype), null, "Object.prototype intacto");
  assert.equal(({}).sessions, undefined);

  const j = await metricasSinteticas();
  const ruim = JSON.parse(JSON.stringify(j));
  ruim.tools[0].id = "constructor";
  assert.equal(validarMetricas(ruim).ok, false);
  const ruim2 = JSON.parse(JSON.stringify(j));
  ruim2.timeline.points[0].byTool = JSON.parse('{"__proto__":{"sessions":1,"userMessages":1,"tokens":0}}');
  assert.equal(validarMetricas(ruim2).ok, false);
});

test("template do Actions: ações fixadas por SHA de commit (com a tag em comentário), versão do pacote fixa e branches ligada à config", async () => {
  const y = await readFile(new URL("../templates/github-actions/render-svg.yml", import.meta.url), "utf8");
  // SHAs resolvidos com `git ls-remote` em 2026-11-15 (tags v4.2.2 e v4.1.0, ambas leves: apontam direto para o commit).
  assert.match(y, /uses: actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4\.2\.2/);
  assert.match(y, /uses: actions\/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4\.1\.0/);
  // Toda ação "uses:" precisa estar fixada por um SHA de 40 hex (nenhuma por tag ou branch móvel).
  const usos = [...y.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(usos.length >= 2);
  for (const u of usos) assert.match(u, /@[0-9a-f]{40}$/, `ação sem SHA fixo: ${u}`);
  // A versão do pacote no template precisa ser uma versão fixa (semver exato), igual à do package.json.
  const versaoPkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  assert.match(y, new RegExp(`AI_USAGE_METRICS_VERSION: "${versaoPkg.replace(/\./g, "\\.")}"`));
  assert.match(y, /branches: \[main\][^\n]*TODO[^\n]*branch/);
});
