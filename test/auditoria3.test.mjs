// Terceira auditoria: A1 (posse da pasta 'repo'), M1 (SCP x ssh://), M2 (política de host), M3 (cwd gigante), B1.
// 100% local: repositórios bare temporários, dados sintéticos, nenhuma rede. Tudo é apagado no final.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { chatgptCodexApp } from "../src/adapters/chatgpt-codex-app.mjs";
import { claudeCode } from "../src/adapters/claude-code.mjs";
import { cline } from "../src/adapters/cline.mjs";
import { SEM_PROJETO, aggregate } from "../src/aggregate.mjs";
import { main } from "../src/cli.mjs";
import { caminhos, hostDoRemoto, normalizarRemoto, validarRemoto } from "../src/config.mjs";
import { descreverPlano } from "../src/publish.mjs";
import { claudeFalso, clineFalso, codexFalso, homeFalsa } from "./fixtures.mjs";
import { metricasSinteticas } from "./sintetico.mjs";

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(tmpdir(), "ai-usage-metrics-sem-config-a3"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Teste",
  GIT_AUTHOR_EMAIL: "teste@exemplo.invalid",
  GIT_COMMITTER_NAME: "Teste",
  GIT_COMMITTER_EMAIL: "teste@exemplo.invalid",
  GIT_TERMINAL_PROMPT: "0",
  AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE: "1", // somente testes
});

const pastas = [];
after(async () => {
  for (const p of pastas) await rm(p, { recursive: true, force: true });
});
const tmp = async (prefixo) => {
  const d = await mkdtemp(join(tmpdir(), prefixo));
  pastas.push(d);
  return d;
};
const barra = (p) => p.replace(/\\/g, "/");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] }).trim();
const commits = (remoto) => {
  try {
    return git(undefined, `--git-dir=${remoto}`, "log", "--format=%s", "main").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const TTY = () => ({ isTTY: true, async ask() { return "s"; } });
const SEM_TTY = () => ({ isTTY: false, async ask() { assert.fail("não deveria perguntar"); } });
const bare = async (nome) => {
  const d = join(await tmp("ai-usage-a3pub-"), `${nome}.git`);
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", d], { env: process.env });
  return d;
};

async function ambiente({ remoto } = {}) {
  const raiz = await tmp("ai-usage-a3-");
  remoto ??= await bare("remoto");
  const stateDir = join(raiz, "estado");
  const paths = caminhos(stateDir);
  const saidas = [];
  const out = (l) => saidas.push(l);
  const cmd = (args, io = SEM_TTY()) => main([...args, "--state-dir", stateDir], out, io);
  const home = await tmp("ai-usage-a3home-");
  await claudeFalso(home);
  await cmd(["init", "--user", "fulano", "--remote", remoto, "--public", "projeto-alfa", "--title", "Painel um"]);
  const config = async (muda) => {
    const c = JSON.parse(await readFile(paths.config, "utf8"));
    muda(c);
    await writeFile(paths.config, JSON.stringify(c), "utf8");
  };
  return { raiz, remoto, stateDir, paths, saidas, cmd, config, home, exportar: () => cmd(["export", "--home", home]), texto: () => saidas.join("\n") };
}

/** Cria um repositório "do usuário" (com um commit local nunca enviado) no caminho dado. */
function repoAlheio(pasta, origin) {
  execFileSync("git", ["init", "-q", "-b", "main", pasta], { env: process.env });
  git(pasta, "remote", "add", "origin", barra(origin));
  execFileSync("git", ["-C", pasta, "commit", "--allow-empty", "-q", "-m", "trabalho-local-importante"], { env: process.env });
}
const velhos = async (stateDir) => (await readdir(stateDir)).filter((n) => /^repo\.velho-\d{13}-[0-9a-f]{6}$/.test(n));
const espera = () => new Promise((r) => setTimeout(r, 5)); // nomes de repo.velho-* com timestamps distintos

// ---------------- A1 ----------------
test("A1: 'repo' preexistente do usuário SEM marcador e com config divergente: nada é apagado e o erro é claro", async () => {
  const a = await ambiente();
  await a.exportar();
  repoAlheio(a.paths.clone, await bare("outro"));
  await writeFile(join(a.paths.clone, "anotacao.txt"), "não perca\n");
  await assert.rejects(a.cmd(["publish", "--yes"], TTY()), /NÃO foi criada por esta ferramenta[\s\S]*Mova ou renomeie[\s\S]*--state-dir/);
  assert.equal(git(a.paths.clone, "log", "--format=%s"), "trabalho-local-importante");
  assert.equal(await readFile(join(a.paths.clone, "anotacao.txt"), "utf8"), "não perca\n");
  assert.deepEqual(await velhos(a.stateDir), []);
  assert.equal(commits(a.remoto).length, 0);
});

test("A1: o mesmo cenário no modo automático (run sem terminal) também recusa sem apagar nada", async () => {
  const a = await ambiente();
  await a.exportar();
  await a.cmd(["publish", "--yes"], TTY()); // aprovação manual
  await a.config((c) => (c.autoPublish = true));
  await rm(a.paths.clone, { recursive: true, force: true });
  repoAlheio(a.paths.clone, await bare("outro"));
  await assert.rejects(a.cmd(["run", "--home", a.home]), /NÃO foi criada por esta ferramenta/);
  assert.equal(git(a.paths.clone, "log", "--format=%s"), "trabalho-local-importante");
  assert.deepEqual(await velhos(a.stateDir), []);
});

test("A1: repositório do usuário posto no lugar do nosso clone (marcador de fora ainda existe) também é recusado", async () => {
  const a = await ambiente();
  await a.exportar();
  await a.cmd(["publish", "--yes"], TTY());
  await rm(a.paths.clone, { recursive: true, force: true });
  repoAlheio(a.paths.clone, await bare("outro"));
  await assert.rejects(a.cmd(["publish", "--yes"], TTY()), /NÃO foi criada por esta ferramenta/);
  assert.equal(git(a.paths.clone, "log", "--format=%s"), "trabalho-local-importante");
});

test("A1: marcador copiado para outro state-dir não vale (amarrado ao caminho real)", async () => {
  const a = await ambiente();
  await a.exportar();
  await a.cmd(["publish", "--yes"], TTY());
  const marcador = await readFile(join(a.stateDir, "repo.owner.json"), "utf8");
  const b = await ambiente();
  await b.exportar();
  await writeFile(join(b.stateDir, "repo.owner.json"), marcador);
  repoAlheio(b.paths.clone, await bare("outro"));
  await assert.rejects(b.cmd(["publish", "--yes"], TTY()), /NÃO foi criada por esta ferramenta/);
  assert.equal(git(b.paths.clone, "log", "--format=%s"), "trabalho-local-importante");
});

test("A1: clone nosso divergente é RENOMEADO (não apagado), com aviso, e só os 3 repo.velho-* mais recentes ficam", async () => {
  const a = await ambiente();
  await a.exportar();
  await a.cmd(["publish", "--yes"], TTY());
  assert.ok(existsSync(join(a.stateDir, "repo.owner.json")), "marcador gravado na criação do clone");
  assert.ok(existsSync(join(a.paths.clone, ".git", "ai-usage-metrics-owner")));
  await writeFile(join(a.paths.clone, "marca-do-primeiro.txt"), "x");
  const alvos = [await bare("b1"), await bare("b2"), await bare("b3"), await bare("b4"), await bare("b5")];
  for (const [i, alvo] of alvos.entries()) {
    await a.config((c) => (c.remoteUrl = alvo));
    await a.cmd(["publish", "--yes"], TTY());
    assert.equal(commits(alvo).length, 1, `envio ${i + 1} chegou ao novo destino`);
    if (i === 0) {
      assert.match(a.texto(), /o clone local de dados foi recriado \(o clone apontava para outro repositório\)\. O antigo foi guardado em 'repo\.velho-\d{13}-[0-9a-f]{6}'/);
      const [v] = await velhos(a.stateDir);
      assert.ok(existsSync(join(a.stateDir, v, "marca-do-primeiro.txt")), "o conteúdo antigo foi preservado, não apagado");
    }
    await espera();
  }
  assert.equal((await velhos(a.stateDir)).length, 3);
  assert.equal((await readdir(a.stateDir)).filter((n) => n.endsWith(".owner.json") && n !== "repo.owner.json").length, 3, "marcadores dos velhos apagados junto");
});

test("A1: a poda nunca apaga repo.velho-* sem marcador nosso", async () => {
  const a = await ambiente();
  await a.exportar();
  await a.cmd(["publish", "--yes"], TTY());
  const meu = join(a.stateDir, "repo.velho-0000000000001-aaaaaa"); // sem .owner.json: não é nosso
  await mkdir(meu);
  await writeFile(join(meu, "dele.txt"), "x");
  for (const alvo of [await bare("c1"), await bare("c2"), await bare("c3"), await bare("c4")]) {
    await a.config((c) => (c.remoteUrl = alvo));
    await a.cmd(["publish", "--yes"], TTY());
    await espera();
  }
  assert.ok(existsSync(join(meu, "dele.txt")));
});

test("A1: 'repo' como ARQUIVO é recusado e o arquivo continua lá", async () => {
  const a = await ambiente();
  await a.exportar();
  await writeFile(a.paths.clone, "sou um arquivo\n");
  await assert.rejects(a.cmd(["publish", "--yes"], TTY()), /'repo' do estado: não é uma pasta/);
  assert.equal(await readFile(a.paths.clone, "utf8"), "sou um arquivo\n");
});

test("A1: 'repo' como link/junction é recusado (modo automático também) e o alvo não é tocado", async (t) => {
  const a = await ambiente();
  await a.exportar();
  await a.cmd(["publish", "--yes"], TTY());
  await a.config((c) => (c.autoPublish = true));
  const alvo = await tmp("ai-usage-a3link-");
  repoAlheio(alvo, await bare("outro"));
  await rm(a.paths.clone, { recursive: true, force: true });
  try {
    await symlink(alvo, a.paths.clone, "junction");
  } catch (e) {
    if (e.code === "EPERM" || e.code === "EACCES") return t.skip("PULADO: sem privilégio para criar link/junction");
    throw e;
  }
  await assert.rejects(a.cmd(["run", "--home", a.home]), /link simbólico\/junction/);
  assert.equal(git(alvo, "log", "--format=%s"), "trabalho-local-importante");
});

test("A1: pasta 'repo' vazia é aceita (o git clona dentro dela); pasta com conteúdo sem marcador não", async () => {
  const a = await ambiente();
  await a.exportar();
  await mkdir(a.paths.clone, { recursive: true });
  await a.cmd(["publish", "--yes"], TTY());
  assert.equal(commits(a.remoto).length, 1);
  const b = await ambiente();
  await b.exportar();
  await mkdir(b.paths.clone, { recursive: true });
  await writeFile(join(b.paths.clone, "qualquer.txt"), "x");
  await assert.rejects(b.cmd(["publish", "--yes"], TTY()), /NÃO foi criada por esta ferramenta/);
  assert.ok(existsSync(join(b.paths.clone, "qualquer.txt")));
});

test("A1: --state-dir inválido: raiz de unidade, pasta pessoal, --home e pasta que já é repositório git", async () => {
  const raiz = parse(tmpdir()).root;
  const casa = await tmp("ai-usage-a3casa-");
  for (const cmdo of ["export", "render", "publish", "run", "init"]) {
    await assert.rejects(main([cmdo, "--state-dir", raiz, "--user", "fulano"], () => {}, SEM_TTY()), /raiz de uma unidade/, cmdo);
    await assert.rejects(main([cmdo, "--state-dir", homedir(), "--user", "fulano"], () => {}, SEM_TTY()), /pasta pessoal inteira/, cmdo);
  }
  await assert.rejects(main(["export", "--state-dir", casa, "--home", casa], () => {}, SEM_TTY()), /pasta pessoal inteira/);
  const gitDir = await tmp("ai-usage-a3git-");
  execFileSync("git", ["init", "-q", gitDir], { env: process.env });
  await assert.rejects(main(["export", "--state-dir", gitDir, "--home", casa], () => {}, SEM_TTY()), /já é um repositório git/);
  assert.deepEqual((await readdir(gitDir)).sort(), [".git"], "nada foi criado dentro do repositório");
});

// ---------------- M1 ----------------
test("M1: SCP e ssh:// são destinos diferentes (caminho relativo ao HOME x absoluto)", () => {
  const scp = normalizarRemoto("git@github.com:u/r.git");
  const ssh = normalizarRemoto("ssh://git@github.com/u/r.git");
  assert.notEqual(scp, ssh);
  assert.equal(scp, "scp://git@github.com/u/r");
  assert.equal(ssh, "ssh://git@github.com/u/r");
  assert.doesNotThrow(() => validarRemoto("git@github.com:u/r.git"));
  assert.doesNotThrow(() => validarRemoto("ssh://git@github.com/u/r.git"));
});

// ---------------- M2 ----------------
test("M2: hosts internos, locais e IPs em qualquer notação são recusados; hosts públicos continuam aceitos", () => {
  const ruins = [
    "https://localhost/a/b", "https://127.0.0.1/a/b", "https://2130706433/a/b", "https://0x7f.0.0.1/a/b", "https://0x7f000001/a/b",
    "https://127.1/a/b", "https://017700000001/a/b", "https://intranet/a/b", "https://10.0.0.5/a/b", "https://192.168.1.1/a/b",
    "https://foo.localhost/a/b", "https://srv.internal/a/b", "https://impressora.local/a/b", "https://01.example.com/a/b", "https://example.123/a/b",
    "ssh://git@localhost/a/b", "ssh://git@10.1.2.3/a/b", "ssh://git@servidor/a/b",
    "git@localhost:a/b", "git@10.0.0.1:a/b", "git@2130706433:a/b", "git@servidor:a/b", "git@0x7f.1:a/b",
  ];
  for (const u of ruins) assert.throws(() => validarRemoto(u), /remoteUrl inválido/, u);
  for (const u of ["https://github.com/a/b.git", "git@github.com:a/b.git", "ssh://git@ghe.exemplo.com/a/b.git", "https://git.exemplo.com.br/a/b"]) assert.doesNotThrow(() => validarRemoto(u), u);
});

test("M2: o dry-run avisa quando o host não é github.com (sem bloquear) e não avisa para github.com", async () => {
  const json = await metricasSinteticas();
  const plano = (remoto) => ({ json, arquivos: [], publicos: [], anonimizados: 0, remoto, branch: "main", autor: { name: "f", email: "f@users.noreply.github.com", noreply: true }, cloneExiste: true, anterior: null });
  assert.match(descreverPlano(plano("https://ghe.exemplo.com/a/b.git")), /ATENÇÃO: o host é "ghe\.exemplo\.com", não github\.com/);
  assert.match(descreverPlano(plano("git@ghe.exemplo.com:a/b.git")), /o host é "ghe\.exemplo\.com"/);
  assert.doesNotMatch(descreverPlano(plano("https://github.com/a/b.git")), /não github\.com/);
  assert.equal(hostDoRemoto("git@GitHub.com:a/b"), "github.com");
});

// ---------------- M3 ----------------
const GIGANTE = "C:\\Users\\fulano\\" + "x".repeat(1_100_000);
const coletar = async (it) => {
  const l = [];
  for await (const e of it) l.push(e);
  return l;
};

test("M3: claude-code descarta cwd acima de 4 KiB, avisa uma vez e a atividade continua contada", async () => {
  const home = await homeFalsa();
  await claudeFalso(home, { cwd: GIGANTE });
  const avisos = new Set();
  const ev = await coletar(claudeCode.events({ home, avisar: (m) => avisos.add(m) }));
  assert.ok(ev.length > 0);
  assert.ok(ev.every((e) => e.project === null));
  assert.equal([...avisos].filter((m) => /4096/.test(m)).length, 1);
});

test("M3: cwd de exatamente 4096 caracteres ainda vale", async () => {
  const home = await homeFalsa();
  const cwd = "C:\\p\\" + "y".repeat(4096 - 5);
  assert.equal(cwd.length, 4096);
  await claudeFalso(home, { cwd });
  const ev = await coletar(claudeCode.events({ home }));
  assert.ok(ev.every((e) => e.project === cwd));
});

test("M3: cline e catálogo do ChatGPT/Codex também descartam cwd gigante (direto no SQL) e avisam", async () => {
  const home = await homeFalsa();
  await clineFalso(home);
  await codexFalso(home);
  const grande = "z".repeat(5000);
  const dbC = new DatabaseSync(join(home, ".cline", "data", "db", "sessions.db"));
  dbC.prepare("UPDATE sessions SET cwd = ?, workspace_root = ?").run(grande, grande);
  dbC.close();
  const dbX = new DatabaseSync(join(home, ".codex", "sqlite", "codex.db"));
  dbX.prepare("UPDATE local_thread_catalog SET cwd = ?").run(grande);
  dbX.close();
  const avisos = new Set();
  const a = await coletar(cline.events({ home, avisar: (m) => avisos.add(m) }));
  const b = await coletar(chatgptCodexApp.events({ home, avisar: (m) => avisos.add(m) }));
  assert.ok(a.length > 0 && a.every((e) => e.project === null));
  assert.ok(b.length > 0 && b.every((e) => e.project === null));
  assert.equal([...avisos].filter((m) => /4096/.test(m)).length, 2);
});

test("M3: aggregate (rede de segurança) agrupa evento com project gigante em '(sem projeto)' e avisa agregado", async () => {
  const avisos = [];
  const ev = [1, 2, 3].map((i) => ({ tool: "claude-code", project: GIGANTE + i, session: `s${i}`, ts: Date.parse("2026-03-01T10:00:00Z"), kind: "user" }));
  const agg = await aggregate(ev, { home: "/home/x", avisar: (m) => avisos.push(m) });
  assert.deepEqual([...agg.projetos.values()].map((p) => p.name), [SEM_PROJETO]);
  assert.equal(avisos.filter((m) => /^3 evento/.test(m)).length, 1);
});

// ---------------- B1 ----------------
test("B1: metrics.json, metrics.svg e avisos.json saem com modo 0600 (no Windows o modo quase não tem efeito)", async () => {
  const a = await ambiente();
  await a.exportar();
  await a.cmd(["render"]);
  for (const f of [a.paths.json, a.paths.svg, join(a.paths.saida, "avisos.json")]) {
    const st = await stat(f);
    assert.ok(st.isFile());
    if (process.platform !== "win32") assert.equal(st.mode & 0o777, 0o600, f);
  }
});
