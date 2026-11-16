// Testes das travas de segurança do publish: autor do commit, symlink, aprovação amarrada ao destino,
// validação do remoto, ambiente/hooks do git. 100% local: repositório bare temporário, nenhuma rede, dados sintéticos.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { main } from "../src/cli.mjs";
import { caminhos, normalizarConfig, normalizarRemoto, validarRemoto } from "../src/config.mjs";
import { ambienteGit, escreverAtomico, semCredenciais } from "../src/publish.mjs";
import { metricasSinteticas } from "./sintetico.mjs";

const ENV = {
  GIT_CONFIG_GLOBAL: join(tmpdir(), "ai-usage-metrics-sem-config"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Pessoa Real",
  GIT_AUTHOR_EMAIL: "pessoa.real@exemplo.invalid",
  GIT_COMMITTER_NAME: "Pessoa Real",
  GIT_COMMITTER_EMAIL: "pessoa.real@exemplo.invalid",
  GIT_TERMINAL_PROMPT: "0",
  AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE: "1", // somente testes
};
Object.assign(process.env, ENV);

const pastas = [];
after(async () => {
  for (const p of pastas) await rm(p, { recursive: true, force: true });
});
const tmp = async (prefixo) => {
  const d = await mkdtemp(join(tmpdir(), prefixo));
  pastas.push(d);
  return d;
};

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitRemoto = (remoto, ...args) => git(undefined, `--git-dir=${remoto}`, ...args);
const commits = (remoto, ref = "main") => {
  try {
    return gitRemoto(remoto, "log", "--format=%an <%ae> | %cn <%ce>", ref).split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const TTY = (respostas = []) => ({ isTTY: true, perguntas: [], async ask(p) { this.perguntas.push(p); return respostas.shift() ?? "s"; } });
const SEM_TTY = () => ({ isTTY: false, async ask() { assert.fail("não deveria perguntar"); } });

async function ambiente({ extraInit = [], publicos = "meu-site" } = {}) {
  const raiz = await tmp("ai-usage-metrics-seg-");
  const remoto = join(raiz, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remoto], { env: process.env });
  const stateDir = join(raiz, "estado");
  const paths = caminhos(stateDir);
  const saidas = [];
  const out = (l) => saidas.push(l);
  const cmd = (args, io = SEM_TTY()) => main([...args, "--state-dir", stateDir], out, io);
  await cmd(["init", "--user", "fulano", "--remote", remoto, "--public", publicos, ...extraInit]);
  await mkdir(paths.saida, { recursive: true });
  await writeFile(paths.json, JSON.stringify(await metricasSinteticas(), null, 2) + "\n");
  const config = async (muda) => {
    const c = JSON.parse(await readFile(paths.config, "utf8"));
    muda(c);
    await writeFile(paths.config, JSON.stringify(c), "utf8");
  };
  return { raiz, remoto, stateDir, paths, saidas, cmd, config, texto: () => saidas.join("\n") };
}

// ---------- 1. autor do commit ----------

test("commit usa o noreply do GitHub por padrão, ignorando a identidade global/ambiente do usuário", async () => {
  const a = await ambiente();
  await a.cmd(["publish", "--dry-run"]);
  assert.match(a.texto(), /autor do commit \(vai para o histórico público\): fulano <fulano@users\.noreply\.github\.com>/);
  assert.doesNotMatch(a.texto(), /ATENÇÃO: este e-mail NÃO é/);
  await a.cmd(["publish", "--yes"], TTY());
  assert.deepEqual(commits(a.remoto), ["fulano <fulano@users.noreply.github.com> | fulano <fulano@users.noreply.github.com>"]);
  assert.ok(!JSON.stringify(commits(a.remoto)).includes("exemplo.invalid"), "o e-mail do ambiente não pode vazar para o commit");
});

test("commitName/commitEmail: aceita o noreply com ID numérico e usa exatamente esse autor", async () => {
  const a = await ambiente({ extraInit: [] });
  await a.config((c) => {
    c.commitName = "Fulano de Tal";
    c.commitEmail = "12345+fulano@users.noreply.github.com";
  });
  await a.cmd(["publish", "--yes"], TTY());
  assert.deepEqual(commits(a.remoto), ["Fulano de Tal <12345+fulano@users.noreply.github.com> | Fulano de Tal <12345+fulano@users.noreply.github.com>"]);
});

test("e-mail que não é noreply: dry-run avisa; sem terminal bloqueia; terminal exige frase extra; flag explícita libera; modo automático bloqueia", async () => {
  const a = await ambiente();
  await a.config((c) => (c.commitEmail = "pessoa@exemplo.com"));
  await a.cmd(["publish"]);
  assert.match(a.texto(), /pessoa@exemplo\.com/);
  assert.match(a.texto(), /ATENÇÃO: este e-mail NÃO é um endereço noreply/);

  // sem terminal, --yes não basta
  await a.cmd(["publish", "--yes"]);
  assert.match(a.texto(), /Bloqueado: o e-mail do commit/);
  assert.equal(commits(a.remoto).length, 0);

  // terminal: frase errada cancela, mesmo com --yes
  const io = TTY(["nao"]);
  await a.cmd(["publish", "--yes"], io);
  assert.match(a.texto(), /e-mail do commit não confirmado/);
  assert.equal(commits(a.remoto).length, 0);

  // terminal: frase certa envia
  await a.cmd(["publish", "--yes"], TTY(["publicar meu e-mail"]));
  assert.equal(commits(a.remoto).length, 1);
  assert.match(commits(a.remoto)[0], /pessoa@exemplo\.com/);
});

test("e-mail não-noreply: --accept-public-email libera sem terminal; o agendador nunca publica esse e-mail", async () => {
  const a = await ambiente({ publicos: "projeto-alfa" });
  const { claudeFalso } = await import("./fixtures.mjs");
  const home = await tmp("ai-usage-metrics-home-");
  await claudeFalso(home);
  await a.config((c) => (c.commitEmail = "pessoa@exemplo.com"));
  await a.cmd(["export", "--home", home]);
  await a.cmd(["publish", "--yes", "--accept-public-email"]);
  assert.equal(commits(a.remoto).length, 1);

  // aprova manualmente (terminal, com a frase) e liga o automático: ainda assim o e-mail não-noreply bloqueia
  await a.cmd(["publish", "--yes"], TTY(["publicar meu e-mail"]));
  await a.config((c) => (c.autoPublish = true));
  await claudeFalso(home, { sessao: "sess-2", dia: "2026-03-05" });
  await a.cmd(["run", "--home", home]);
  assert.equal(commits(a.remoto).length, 1);
  assert.match(a.texto(), /BLOQUEADO: o e-mail do commit/);
});

test("config: commitEmail/commitName inválidos são recusados", () => {
  const base = { githubUser: "fulano" };
  for (const ruim of [{ commitEmail: "sem-arroba" }, { commitEmail: "a b@c.d" }, { commitEmail: "<x>@y.z" }, { commitName: "Nome\nQuebrado" }, { commitName: "<tag>" }, { commitName: "" }]) {
    assert.throws(() => normalizarConfig({ ...base, ...ruim }), /commit(Email|Name) inválido/);
  }
  assert.doesNotThrow(() => normalizarConfig({ ...base, commitName: "Fulano", commitEmail: "1+fulano@users.noreply.github.com" }));
});

// ---------- 2. symlink e escrita atômica ----------

test("remoto com metrics.json como link simbólico (modo 120000) é recusado e nada é enviado", async () => {
  const a = await ambiente();
  // monta um commit no remoto onde metrics.json é um symlink (sem precisar de privilégio de symlink no SO)
  const trab = await tmp("ai-usage-metrics-trab-");
  git(trab, "init", "-q", "-b", "main");
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: trab, input: "alvo-fora-do-clone", encoding: "utf8", env: process.env }).trim();
  git(trab, "update-index", "--add", "--cacheinfo", `120000,${blob},metrics.json`);
  git(trab, "commit", "-q", "-m", "x", "--no-verify");
  git(trab, "push", "-q", a.remoto, "main");
  const antes = commits(a.remoto).length;
  await assert.rejects(a.cmd(["publish", "--yes"], TTY()), /não são arquivos comuns|link simbólico/);
  assert.equal(commits(a.remoto).length, antes);
});

for (const nome of ["metrics.svg", "metrics.model-1.svg", "metrics.model-2.svg", "metrics.model-3.svg"]) {
  test(`remoto com ${nome} como link simbólico (modo 120000) é recusado e nada é enviado`, async () => {
    const a = await ambiente();
    const trab = await tmp("ai-usage-metrics-trab-");
    git(trab, "init", "-q", "-b", "main");
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: trab, input: "alvo-fora-do-clone", encoding: "utf8", env: process.env }).trim();
    git(trab, "update-index", "--add", "--cacheinfo", `120000,${blob},${nome}`);
    git(trab, "commit", "-q", "-m", "x", "--no-verify");
    git(trab, "push", "-q", a.remoto, "main");
    const antes = commits(a.remoto).length;
    await assert.rejects(a.cmd(["publish", "--yes"], TTY()), /não são arquivos comuns|link simbólico/);
    assert.equal(commits(a.remoto).length, antes);
  });
}

test("escreverAtomico: os 5 arquivos publicados são gravados por inteiro, sem temporários", async () => {
  const dir = await tmp("ai-usage-metrics-atomico5-");
  const nomes = ["metrics.json", "metrics.svg", "metrics.model-1.svg", "metrics.model-2.svg", "metrics.model-3.svg"];
  for (const n of nomes) {
    await escreverAtomico(dir, n, "um");
    await escreverAtomico(dir, n, "dois");
    assert.equal(await readFile(join(dir, n), "utf8"), "dois", n);
  }
  assert.deepEqual((await readdir(dir)).sort(), [...nomes].sort());
});

test("escreverAtomico: recusa symlink no destino, não deixa temporários e troca o conteúdo por inteiro", async (t) => {
  const dir = await tmp("ai-usage-metrics-atomico-");
  await escreverAtomico(dir, "metrics.json", "um");
  await escreverAtomico(dir, "metrics.json", "dois");
  assert.equal(await readFile(join(dir, "metrics.json"), "utf8"), "dois");
  assert.deepEqual(await readdir(dir), ["metrics.json"]);

  const fora = join(await tmp("ai-usage-metrics-fora-"), "alvo.txt");
  await writeFile(fora, "INTACTO");
  try {
    await symlink(fora, join(dir, "metrics.svg"));
  } catch (e) {
    if (e.code === "EPERM" || e.code === "EACCES") return t.skip("PULADO (parcial): sem privilégio para criar symlink real neste SO; a recusa é coberta sem privilégio pelos testes com lstat simulado (rodada2) e pelo de modo 120000");
    throw e;
  }
  await assert.rejects(escreverAtomico(dir, "metrics.svg", "x"), /link simbólico/);
  assert.equal(await readFile(fora, "utf8"), "INTACTO", "o arquivo fora do clone não pode ser tocado");
});

test("clone em cache com symlink no lugar de metrics.*: recusa (se o SO permite criar o link)", async (t) => {
  const a = await ambiente();
  await a.cmd(["publish", "--yes"], TTY());
  const fora = join(await tmp("ai-usage-metrics-fora-"), "alvo.txt");
  await writeFile(fora, "INTACTO");
  await rm(join(a.paths.clone, "metrics.json"));
  try {
    await symlink(fora, join(a.paths.clone, "metrics.json"));
  } catch (e) {
    if (e.code === "EPERM" || e.code === "EACCES") return t.skip("PULADO: sem privilégio para criar symlink real neste SO; coberto sem privilégio pelos testes com lstat simulado (rodada2)");
    throw e;
  }
  await assert.rejects(a.cmd(["publish", "--dry-run"]), /link simbólico/);
  assert.equal(await readFile(fora, "utf8"), "INTACTO");
});

// ---------- 3. aprovação amarrada ao destino ----------

test("publish --yes sem terminal envia mas NÃO marca aprovação para o envio automático", async () => {
  const a = await ambiente();
  await a.cmd(["publish", "--yes"]);
  assert.equal(commits(a.remoto).length, 1);
  const estado = JSON.parse(await readFile(a.paths.estado, "utf8"));
  assert.equal(estado.manualPublishConfirmed, false);
  assert.match(a.texto(), /NÃO conta como aprovação/);
});

test("envio automático bloqueia se remoto, branch ou pasta->nome público mudarem desde a aprovação manual", async () => {
  const a = await ambiente({ publicos: "projeto-alfa" });
  const home = await tmp("ai-usage-metrics-home-");
  const { claudeFalso } = await import("./fixtures.mjs");
  await claudeFalso(home);
  await a.cmd(["export", "--home", home]);
  await a.cmd(["publish", "--yes"], TTY());
  const estado = JSON.parse(await readFile(a.paths.estado, "utf8"));
  assert.equal(estado.manualPublishConfirmed, true);
  assert.deepEqual(estado.approvedTarget, { remote: normalizarRemoto(JSON.parse(await readFile(a.paths.config, "utf8")).remoteUrl), branch: "main", commitName: "fulano", commitEmail: "fulano@users.noreply.github.com" });
  assert.deepEqual({ ...estado.approvedFolders }, { "projeto-alfa": "projeto-alfa" });
  await a.config((c) => (c.autoPublish = true));
  const n = () => commits(a.remoto).length;

  // controle: nada mudou -> o agendador envia
  await claudeFalso(home, { sessao: "sess-2", dia: "2026-03-05" });
  await a.cmd(["run", "--home", home]);
  assert.equal(n(), 2);

  // 1) outro remoto (um segundo bare local)
  const remoto2 = join(await tmp("ai-usage-metrics-r2-"), "outro.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remoto2], { env: process.env });
  const original = JSON.parse(await readFile(a.paths.config, "utf8")).remoteUrl;
  await a.config((c) => (c.remoteUrl = remoto2));
  await claudeFalso(home, { sessao: "sess-3", dia: "2026-03-06" });
  await a.cmd(["run", "--home", home]);
  assert.match(a.texto(), /BLOQUEADO: o repositório de destino mudou/);
  assert.match(a.texto(), /Para reaprovar/);
  assert.equal(commits(remoto2).length, 0);
  await a.config((c) => (c.remoteUrl = original));

  // 2) outra branch
  await a.config((c) => (c.branch = "outra"));
  await a.cmd(["run", "--home", home]);
  assert.match(a.texto(), /BLOQUEADO: a branch de destino mudou/);
  await a.config((c) => (c.branch = "main"));

  // 3) mesmo nome público, outra pasta (mapa pasta -> alias muda): a pasta "proj-b" passa a aparecer como "projeto-alfa"
  await a.config((c) => (c.publicProjects = { "proj-b": "projeto-alfa" }));
  await claudeFalso(home, { sessao: "sess-4", dia: "2026-03-07", cwd: "C:\\Users\\fulano\\Desktop\\proj-b" });
  await a.cmd(["run", "--home", home]);
  assert.match(a.texto(), /BLOQUEADO[^\n]*pasta\/nome "proj-b" -> nome público "projeto-alfa" não foi aprovada/);
  assert.equal(n(), 2);
});

test("estado antigo (sem destino aprovado) bloqueia o automático e explica como reaprovar", async () => {
  const a = await ambiente({ publicos: "projeto-alfa" });
  const home = await tmp("ai-usage-metrics-home-");
  const { claudeFalso } = await import("./fixtures.mjs");
  await claudeFalso(home);
  await a.config((c) => (c.autoPublish = true));
  await writeFile(a.paths.estado, JSON.stringify({ manualPublishConfirmed: true, approvedPublicNames: ["projeto-alfa"] }));
  await a.cmd(["run", "--home", home]);
  assert.match(a.texto(), /BLOQUEADO: não há destino aprovado registrado/);
  assert.equal(commits(a.remoto).length, 0);
});

// ---------- 4. validação do remoto ----------

test("validarRemoto: aceita https, git@host:caminho e ssh://git@; recusa o resto sem repetir a URL", () => {
  const flag = process.env.AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE;
  delete process.env.AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE; // sem o modo de testes
  try {
    validacaoDoRemoto();
  } finally {
    process.env.AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE = flag;
  }
});

function validacaoDoRemoto() {
  for (const ok of ["https://github.com/fulano/ai-metrics.git", "https://github.com:443/a/b", "git@github.com:fulano/ai-metrics.git", "ssh://git@github.com/fulano/ai-metrics.git", "ssh://git@host.example:2222/a/b.git"]) {
    assert.equal(validarRemoto(ok), ok);
  }
  const ruins = [
    "http://github.com/a/b.git",
    "git://github.com/a/b.git",
    "file:///tmp/x",
    "/tmp/repo",
    "C:\\repos\\x",
    "\\\\servidor\\compartilhado\\x",
    "ext::sh -c 'touch /tmp/pwn'",
    "xyz::qualquer",
    "-oProxyCommand=x",
    "--upload-pack=x",
    "https://usuario:token@github.com/a/b.git",
    "https://token@github.com/a/b.git",
    "https://github.com/a/b c.git",
    "https://github.com/a/b\n.git",
    "https://github.com/../b",
    "https://github.com/a/b?x=1",
    "git@github.com:a/b c",
    "git@github.com:-a/b",
    "ssh://usuario:senha@github.com/a/b.git",
    "ssh://outro@github.com/a/b.git",
    "ssh://git:senha@github.com/a/b.git",
    "ssh://git@-host/a/b",
    "",
  ];
  for (const url of ruins) {
    assert.throws(() => validarRemoto(url), (e) => {
      assert.match(e.message, /remoteUrl inválido/);
      for (const segredo of ["token", "senha", "usuario:"]) if (url.includes(segredo)) assert.ok(!e.message.includes(segredo + "@") && !e.message.includes(url), "a mensagem não pode repetir a credencial");
      return true;
    }, url);
  }
}

test("remoto local/file só é aceito no modo de testes (variável interna), nunca por configuração", () => {
  const antes = process.env.AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE;
  try {
    delete process.env.AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE;
    assert.throws(() => validarRemoto(join(tmpdir(), "x.git")), /remoteUrl inválido/);
    assert.throws(() => normalizarConfig({ githubUser: "fulano", remoteUrl: join(tmpdir(), "x.git") }), /remoteUrl inválido/);
    process.env.AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE = "1";
    assert.doesNotThrow(() => validarRemoto(join(tmpdir(), "x.git")));
    assert.throws(() => validarRemoto("-" + join(tmpdir(), "x.git")), /remoteUrl inválido/);
    assert.throws(() => validarRemoto("ext::sh -c x"), /remoteUrl inválido/);
  } finally {
    process.env.AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE = antes;
  }
});

test("normalizarRemoto: mesma coisa escrita de formas diferentes dá o mesmo destino", () => {
  assert.equal(normalizarRemoto("https://GitHub.com/Fulano/Repo.git"), "https://github.com/Fulano/Repo");
  assert.equal(normalizarRemoto("https://github.com/Fulano/Repo/"), "https://github.com/Fulano/Repo");
  assert.equal(normalizarRemoto("git@github.com:Fulano/Repo.git"), "scp://git@github.com/Fulano/Repo");
  assert.equal(normalizarRemoto("git@GitHub.com:Fulano/Repo"), normalizarRemoto("git@github.com:Fulano/Repo.git/"));
  // M1: SCP (caminho relativo ao HOME do servidor) e ssh:// (caminho absoluto) NÃO são o mesmo destino
  assert.notEqual(normalizarRemoto("git@github.com:Fulano/Repo.git"), normalizarRemoto("ssh://git@github.com/Fulano/Repo.git"));
  assert.notEqual(normalizarRemoto("https://github.com/a/b"), normalizarRemoto("https://github.com/a/c"));
});

test("semCredenciais: tira usuário/senha de qualquer URL em texto de erro", () => {
  assert.equal(semCredenciais("fatal: unable to access 'https://user:segredo@github.com/a/b.git/'"), "fatal: unable to access 'https://***@github.com/a/b.git/'");
  assert.doesNotMatch(semCredenciais("ssh://git:senha@host/x e https://tok@h/y"), /senha|tok@/);
});

test("init e config recusam remoto malicioso sem repetir o segredo na mensagem", async () => {
  const raiz = await tmp("ai-usage-metrics-init-");
  await assert.rejects(
    main(["init", "--user", "fulano", "--remote", "https://fulano:ghp_SEGREDO@github.com/a/b.git", "--state-dir", raiz], () => {}, SEM_TTY()),
    (e) => /remoteUrl inválido/.test(e.message) && !e.message.includes("ghp_SEGREDO"),
  );
  await assert.rejects(main(["init", "--user", "fulano", "--remote", "ext::sh -c x", "--state-dir", join(raiz, "b")], () => {}, SEM_TTY()), /remoteUrl inválido/);
});

// ---------- 5. ambiente do git e hooks ----------

test("ambienteGit: só repassa o que está na allowlist (sem GIT_DIR, GIT_SSH_COMMAND, GIT_CONFIG_COUNT, ...)", () => {
  const base = {
    PATH: "/bin",
    HOME: "/h",
    LC_ALL: "C",
    GIT_DIR: "/x",
    GIT_WORK_TREE: "/y",
    GIT_INDEX_FILE: "/z",
    GIT_OBJECT_DIRECTORY: "/o",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.sshCommand",
    GIT_CONFIG_VALUE_0: "calc",
    GIT_SSH_COMMAND: "calc",
    GIT_SSH: "calc",
    GIT_ASKPASS: "calc",
    GIT_EXEC_PATH: "/e",
    GIT_PROXY_COMMAND: "calc",
    GIT_EXTERNAL_DIFF: "calc",
    GIT_AUTHOR_EMAIL: "pessoa@exemplo.com",
    SEGREDO_QUALQUER: "x",
  };
  const env = ambienteGit({ interativo: false, autor: { name: "N", email: "n@users.noreply.github.com" }, base });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.LC_ALL, "C");
  for (const k of Object.keys(base)) if (!["PATH", "HOME", "LC_ALL"].includes(k) && !k.startsWith("GIT_AUTHOR")) assert.equal(env[k], undefined, k);
  assert.equal(env.GIT_AUTHOR_EMAIL, "n@users.noreply.github.com");
  assert.equal(env.GIT_COMMITTER_EMAIL, "n@users.noreply.github.com");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});

test("publish ignora GIT_DIR/GIT_WORK_TREE/GIT_SSH_COMMAND herdados e não roda hooks do usuário (pre-commit, pre-push, post-*)", async () => {
  const a = await ambiente();
  const hooks = await tmp("ai-usage-metrics-hooks-");
  const marcador = join(hooks, "executou.txt").replace(/\\/g, "/");
  for (const h of ["pre-commit", "commit-msg", "post-commit", "pre-push", "post-checkout", "reference-transaction"]) {
    await writeFile(join(hooks, h), `#!/bin/sh\necho ${h} >> "${marcador}"\nexit 1\n`, { mode: 0o755 });
  }
  const cfgGlobal = join(hooks, "gitconfig");
  await writeFile(cfgGlobal, `[core]\n\thooksPath = ${hooks.replace(/\\/g, "/")}\n`);
  const semHooksRemoto = await tmp("ai-usage-metrics-sem-hooks-");
  gitRemoto(a.remoto, "config", "core.hooksPath", semHooksRemoto.split("\\").join("/")); // o "servidor" local não herda a config global do teste
  const lixo = await tmp("ai-usage-metrics-lixo-");
  const salvo = { ...process.env };
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: cfgGlobal,
    GIT_DIR: join(lixo, "nao-existe"),
    GIT_WORK_TREE: lixo,
    GIT_INDEX_FILE: join(lixo, "indice"),
    GIT_SSH_COMMAND: "comando-que-nao-existe",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hooks,
  });
  try {
    await a.cmd(["publish", "--yes"], TTY());
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in salvo)) delete process.env[k];
    Object.assign(process.env, salvo);
  }
  assert.equal(commits(a.remoto).length, 1, "o envio funciona mesmo com ambiente hostil");
  assert.equal(existsSync(join(hooks, "executou.txt")), false, "nenhum hook do usuário pode ter rodado");
  assert.equal(existsSync(join(lixo, "indice")), false);
});
