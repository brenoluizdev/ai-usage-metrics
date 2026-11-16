// Segunda rodada: N7 (avisos.json), N8 (trava velha e modos), N5 (tetos de entradas distintas). Sintético, sem rede.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { claudeCode } from "../src/adapters/claude-code.mjs";
import { MAX_IDS_POR_ARQUIVO } from "../src/adapters/seguro.mjs";
import { aggregate } from "../src/aggregate.mjs";
import { limparAviso, main } from "../src/cli.mjs";
import { caminhos, gravarConfig, gravarEstado } from "../src/config.mjs";
import { adquirirLock } from "../src/lock.mjs";
import { claudeFalso } from "./fixtures.mjs";

process.env.GIT_CONFIG_GLOBAL = join(tmpdir(), "ai-usage-metrics-sem-config-r2m");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE = "1"; // somente testes

const pastas = [];
after(async () => {
  for (const p of pastas) await rm(p, { recursive: true, force: true });
});
const tmp = async (prefixo = "ai-usage-metrics-r2m-") => {
  const d = await mkdtemp(join(tmpdir(), prefixo));
  pastas.push(d);
  return d;
};
const SEM_TTY = { isTTY: false, async ask() { assert.fail("não deveria perguntar"); } };

// ---------- N7 ----------
test("N7: limparAviso tira ANSI/OSC/controle e limita o tamanho", () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  assert.equal(limparAviso(`${ESC}[31mvermelho${ESC}[0m`), "vermelho");
  assert.equal(limparAviso(`${ESC}]0;titulo falso${BEL}texto`), "texto");
  assert.equal(limparAviso(`a${ESC}b\u0000c\u0085d`), "a b c d");
  assert.equal(limparAviso("x".repeat(1000)).length, 300);
});

test("N7: avisos.json adulterado não injeta ANSI no terminal; export --out não grava avisos.json ao lado do arquivo de saída", async () => {
  const raiz = await tmp();
  const stateDir = join(raiz, "estado");
  const paths = caminhos(stateDir);
  const saidas = [];
  const cmd = (args) => main([...args, "--state-dir", stateDir], (l) => saidas.push(l), SEM_TTY);
  const home = await tmp();
  await claudeFalso(home);
  await cmd(["init", "--user", "fulano", "--remote", join(raiz, "remoto.git"), "--public", "projeto-alfa"]);
  await cmd(["export", "--home", home]);
  assert.equal(existsSync(join(paths.saida, "avisos.json")), true, "avisos.json fica na pasta de saída do estado");

  const alheia = await tmp("ai-usage-metrics-r2m-alheia-");
  await writeFile(join(alheia, "avisos.json"), "ARQUIVO-ALHEIO");
  await cmd(["export", "--home", home, "--out", join(alheia, "m.json")]);
  assert.equal(await readFile(join(alheia, "avisos.json"), "utf8"), "ARQUIVO-ALHEIO", "não sobrescreve arquivo ao lado de --out");

  const ESC = String.fromCharCode(27);
  await writeFile(join(paths.saida, "avisos.json"), JSON.stringify([`${ESC}[2J${ESC}]0;pwn${String.fromCharCode(7)}aviso ${ESC}[31mfalso${ESC}[0m`, 42]));
  saidas.length = 0;
  await cmd(["publish", "--dry-run"]);
  const texto = saidas.join("\n");
  assert.ok(!texto.includes(ESC), "nenhum ESC chega ao terminal");
  assert.match(texto, /Aviso \(do último export\): aviso falso/);
});

// ---------- N8 ----------
test("N8: vários processos disputando a MESMA trava velha: só um adquire, os outros recebem 'Outra execução', sem sobras", async () => {
  for (let rodada = 0; rodada < 5; rodada++) {
    const dir = await tmp();
    await writeFile(join(dir, ".lock"), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: "2020-01-01T00:00:00.000Z" }) + "\n");
    const resultados = await Promise.allSettled(Array.from({ length: 8 }, () => adquirirLock(dir)));
    const ok = resultados.filter((r) => r.status === "fulfilled");
    assert.equal(ok.length, 1, `rodada ${rodada}: exatamente um processo pode ficar com a trava`);
    for (const r of resultados.filter((x) => x.status === "rejected")) assert.match(r.reason.message, /Outra execução|Não consegui obter a trava/);
    assert.deepEqual((await readdir(dir)).filter((n) => n.includes(".velha.")), [], "nenhuma trava renomeada sobra");
    await ok[0].value();
  }
});

test("N8: pasta de estado 0700 e config.json 0600 (Linux/macOS)", async (t) => {
  if (process.platform === "win32") return t.skip("PULADO: modos 0700/0600 não existem no Windows (vale a ACL do perfil do usuário); NÃO verificado aqui");
  const dir = join(await tmp(), "estado");
  const p = caminhos(dir);
  await gravarConfig(p.config, { githubUser: "fulano" });
  await gravarEstado(p.estado, {});
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(p.config)).mode & 0o777, 0o600);
  assert.equal((await stat(p.estado)).mode & 0o777, 0o600);
  await writeFile(p.config, "{}", { mode: 0o644 });
  await gravarConfig(p.config, { githubUser: "fulano" });
  assert.equal((await stat(p.config)).mode & 0o777, 0o600, "config pré-existente também é restringida");
});

// ---------- N5 ----------
const ev = (i, extra = {}) => ({ tool: "claude-code", project: `C:\\Users\\fulano\\proj-${i}`, session: `s${i}`, ts: Date.parse("2026-03-01T10:00:00Z"), kind: "user", ...extra });

test("N5: acima de 10 000 pastas distintas o excedente vai para '(sem projeto)', com aviso, sem derrubar", async () => {
  const avisos = [];
  const agg = await aggregate((function* () { for (let i = 0; i < 10_050; i++) yield ev(i); })(), { home: "C:\\Users\\fulano", avisar: (m) => avisos.push(m) });
  assert.ok(agg.projetos.size <= 10_001, `projetos guardados: ${agg.projetos.size}`);
  assert.equal(agg.total.userMessages, 10_050, "o total continua certo");
  assert.match(avisos.join(" "), /pastas de projeto distintas: 50 evento/);
});

test("N5: teto de sessões distintas (configurável nos testes) ignora o excedente com aviso", async () => {
  const avisos = [];
  const agg = await aggregate([ev(1), ev(2), ev(3), ev(4), ev(1)], { home: "C:\\Users\\fulano", limites: { sessoes: 3 }, avisar: (m) => avisos.push(m) });
  assert.equal(agg.total.sessions.size, 3);
  assert.equal(agg.total.userMessages, 4, "eventos de sessões já vistas continuam contando");
  assert.match(avisos.join(" "), /sessões distintas: 1 evento/);
});

test("N5: arquivo do Claude Code com mais ids de resposta distintos que o teto: corta com aviso e a execução continua", async () => {
  const home = await tmp();
  const dir = join(home, ".claude", "projects", "p");
  await mkdir(dir, { recursive: true });
  const total = MAX_IDS_POR_ARQUIVO + 50;
  const linhas = [];
  for (let i = 0; i < total; i++) linhas.push(`{"type":"assistant","timestamp":"2026-03-01T10:00:00.000Z","message":{"id":"i${i}","usage":{"input_tokens":1}}}`);
  await writeFile(join(dir, "s.jsonl"), linhas.join("\n") + "\n");
  const avisos = [];
  const out = [];
  for await (const e of claudeCode.events({ home, avisar: (m) => avisos.push(m) })) out.push(e);
  assert.equal(out.length, MAX_IDS_POR_ARQUIVO);
  assert.match(avisos.join(" "), /teto de entradas distintas.*50 registro/);
});
