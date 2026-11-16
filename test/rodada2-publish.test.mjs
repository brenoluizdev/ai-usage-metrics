// Segunda rodada, parte de publicação: N4 (insteadOf global), N3 (clone em cache adulterado), N6 (autor na aprovação).
// Repositórios bare locais em pasta temporária, config global do git SIMULADA por arquivo temporário. Sem rede.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { main } from "../src/cli.mjs";
import { caminhos } from "../src/config.mjs";
import { exigirArquivoSeguro } from "../src/publish.mjs";
import { claudeFalso } from "./fixtures.mjs";

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(tmpdir(), "ai-usage-metrics-sem-config-r2"),
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
  const d = join(await tmp("ai-usage-metrics-r2pub-"), `${nome}.git`);
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", d], { env: process.env });
  return d;
};

async function ambiente({ remoteUrl, remoto } = {}) {
  const raiz = await tmp("ai-usage-metrics-r2-");
  remoto ??= await bare("remoto");
  const stateDir = join(raiz, "estado");
  const paths = caminhos(stateDir);
  const saidas = [];
  const out = (l) => saidas.push(l);
  const cmd = (args, io = SEM_TTY()) => main([...args, "--state-dir", stateDir], out, io);
  const home = await tmp("ai-usage-metrics-r2home-");
  await claudeFalso(home);
  await cmd(["init", "--user", "fulano", "--remote", remoteUrl ?? remoto, "--public", "projeto-alfa", "--title", "Painel um"]);
  const config = async (muda) => {
    const c = JSON.parse(await readFile(paths.config, "utf8"));
    muda(c);
    await writeFile(paths.config, JSON.stringify(c), "utf8");
  };
  const exportar = () => cmd(["export", "--home", home]);
  return { raiz, remoto, stateDir, paths, saidas, cmd, config, home, exportar, texto: () => saidas.join("\n") };
}

// ---------- N4 ----------
test("N4: com url.<x>.insteadOf global, o segundo envio funciona (URL crua do clone comparada, sem aviso de outro repositório)", async () => {
  const real = await bare("destino-real");
  const falsa = "https://example.invalid/fulano/ai-metrics.git";
  const cfgGlobal = join(await tmp("ai-usage-metrics-r2cfg-"), "gitconfig");
  await writeFile(cfgGlobal, `[url "${barra(real)}"]\n\tinsteadOf = ${falsa}\n`);
  const salvo = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = cfgGlobal;
  try {
    const a = await ambiente({ remoteUrl: falsa, remoto: real });
    await a.exportar();
    await a.cmd(["publish", "--yes"], TTY());
    assert.equal(commits(real).length, 1);
    await a.config((c) => (c.title = "Painel dois"));
    await a.cmd(["publish", "--yes"], TTY());
    assert.equal(commits(real).length, 2, "o segundo envio chegou ao destino");
    assert.doesNotMatch(a.texto(), /outro reposit|recriado/);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = salvo;
  }
});

// ---------- N3 ----------
const ADULTERACOES = {
  "remote.origin.pushurl": (clone, evil) => appendFile(join(clone, ".git", "config"), `[remote "origin"]\n\tpushurl = ${barra(evil)}\n`),
  "core.sshCommand": (clone) => appendFile(join(clone, ".git", "config"), `[core]\n\tsshCommand = echo adulterado\n`),
  "url.insteadOf local": (clone, evil, remoto) => appendFile(join(clone, ".git", "config"), `[url "${barra(evil)}"]\n\tinsteadOf = ${barra(remoto)}\n`),
  "url.pushInsteadOf local": (clone, evil, remoto) => appendFile(join(clone, ".git", "config"), `[url "${barra(evil)}"]\n\tpushInsteadOf = ${barra(remoto)}\n`),
  "credential.helper local": (clone) => appendFile(join(clone, ".git", "config"), `[credential]\n\thelper = !echo adulterado\n`),
  "include.path": (clone) => appendFile(join(clone, ".git", "config"), `[include]\n\tpath = /nao/existe\n`),
};

for (const [nome, adultera] of Object.entries(ADULTERACOES)) {
  test(`N3: clone em cache com ${nome} adulterado é recriado (com aviso) e o envio vai só ao destino aprovado`, async () => {
    const a = await ambiente();
    await a.exportar();
    await a.cmd(["publish", "--yes"], TTY());
    const evil = await bare("evil");
    await adultera(a.paths.clone, evil, a.remoto);
    await a.config((c) => (c.title = "Painel dois"));
    await a.cmd(["publish", "--yes"], TTY());
    assert.match(a.texto(), /Aviso: o clone local de dados foi recriado \(a configuração do clone tinha chaves inesperadas\)/);
    assert.equal(commits(a.remoto).length, 2, "o destino aprovado recebeu o envio");
    assert.equal(commits(evil).length, 0, "o destino do atacante não recebeu nada");
    const cfg = await readFile(join(a.paths.clone, ".git", "config"), "utf8");
    assert.doesNotMatch(cfg, /pushurl|sshCommand|insteadOf|credential|include|adulterado/i);
  });
}

test("N3: core.fsmonitor adulterado no clone nunca chega a executar (a config é conferida antes de qualquer git no clone)", async () => {
  const a = await ambiente();
  await a.exportar();
  await a.cmd(["publish", "--yes"], TTY());
  const marcador = join(await tmp("ai-usage-metrics-r2marca-"), "executou.txt");
  const script = join(await tmp("ai-usage-metrics-r2script-"), "fsm.sh");
  await writeFile(script, `#!/bin/sh\necho x >> "${barra(marcador)}"\n`, { mode: 0o755 });
  await appendFile(join(a.paths.clone, ".git", "config"), `[core]\n\tfsmonitor = ${barra(script)}\n\teditor = ${barra(script)}\n\tpager = ${barra(script)}\n`);
  await a.config((c) => (c.title = "Painel dois"));
  await a.cmd(["publish", "--yes"], TTY());
  assert.equal(existsSync(marcador), false, "nenhum comando do clone adulterado rodou");
  assert.equal(commits(a.remoto).length, 2);
  assert.match(a.texto(), /foi recriado/);
});

test("N3: .git virando ARQUIVO (gitdir: apontando para outro clone) é recusado antes de qualquer fetch; o clone é recriado", async () => {
  const a = await ambiente();
  await a.exportar();
  await a.cmd(["publish", "--yes"], TTY());
  const evil = await bare("evil");
  const outro = join(await tmp("ai-usage-metrics-r2outro-"), "clone");
  git(undefined, "clone", "--quiet", a.remoto, outro);
  git(outro, "config", "remote.origin.pushurl", barra(evil));
  await rm(join(a.paths.clone, ".git"), { recursive: true, force: true });
  await writeFile(join(a.paths.clone, ".git"), `gitdir: ${barra(join(outro, ".git"))}\n`);
  await a.config((c) => (c.title = "Painel dois"));
  await a.cmd(["publish", "--yes"], TTY());
  assert.match(a.texto(), /Aviso: o clone local de dados foi recriado \(\.git era um arquivo ou link simbólico\)/);
  assert.equal((await lstat(join(a.paths.clone, ".git"))).isDirectory(), true);
  assert.equal(commits(a.remoto).length, 2);
  assert.equal(commits(evil).length, 0);
});

test("N3: remoto configurado mudou -> o clone antigo é recriado com aviso (e o antigo destino não recebe nada)", async () => {
  const a = await ambiente();
  await a.exportar();
  await a.cmd(["publish", "--yes"], TTY());
  const novo = await bare("novo");
  await a.config((c) => (c.remoteUrl = novo));
  await a.cmd(["publish", "--yes"], TTY());
  assert.match(a.texto(), /recriado \(o clone apontava para outro repositório\)/);
  assert.equal(commits(novo).length, 1);
  assert.equal(commits(a.remoto).length, 1);
});

// ---------- N6 ----------
test("N6: nome/e-mail do commit entram na aprovação; mudar qualquer um bloqueia o automático até reaprovar; estado antigo também", async () => {
  const a = await ambiente();
  await a.exportar();
  await a.cmd(["publish", "--yes"], TTY());
  const estado = JSON.parse(await readFile(a.paths.estado, "utf8"));
  assert.equal(estado.approvedTarget.commitName, "fulano");
  assert.equal(estado.approvedTarget.commitEmail, "fulano@users.noreply.github.com");
  await a.config((c) => (c.autoPublish = true));
  const nova = async (i) => claudeFalso(a.home, { sessao: `sess-r${i}`, dia: `2026-03-${10 + i}` });
  const n = () => commits(a.remoto).length;

  await nova(1);
  await a.cmd(["run", "--home", a.home]);
  assert.equal(n(), 2, "controle: nada mudou, o automático envia");

  await a.config((c) => (c.commitName = "Outra Pessoa"));
  await nova(2);
  await a.cmd(["run", "--home", a.home]);
  assert.match(a.texto(), /BLOQUEADO: o nome do autor do commit mudou/);
  assert.match(a.texto(), /Para reaprovar/);
  assert.equal(n(), 2);

  await a.config((c) => {
    c.commitName = "fulano";
    c.commitEmail = "outro@users.noreply.github.com";
  });
  await a.cmd(["run", "--home", a.home]);
  assert.match(a.texto(), /BLOQUEADO: o e-mail do autor do commit mudou/);
  assert.equal(n(), 2);

  await a.cmd(["publish", "--yes"], TTY()); // reaprovação manual com o novo autor
  assert.equal(n(), 3);
  await nova(3);
  await a.cmd(["run", "--home", a.home]);
  assert.equal(n(), 4, "depois de reaprovar o automático volta a enviar");

  // estado antigo: aprovação sem nome/e-mail do autor
  const e2 = JSON.parse(await readFile(a.paths.estado, "utf8"));
  delete e2.approvedTarget.commitName;
  delete e2.approvedTarget.commitEmail;
  await writeFile(a.paths.estado, JSON.stringify(e2));
  await nova(4);
  await a.cmd(["run", "--home", a.home]);
  assert.match(a.texto(), /BLOQUEADO: a aprovação anterior não cobre o autor do commit/);
  assert.equal(n(), 4);
});

// ---------- lacuna de teste de symlink: cobertura que não depende de privilégio ----------
test("exigirArquivoSeguro recusa symlink e não-arquivo mesmo sem privilégio de symlink (lstat simulado)", async () => {
  const falso = (o) => async () => ({ isSymbolicLink: () => false, isFile: () => false, ...o });
  await assert.rejects(exigirArquivoSeguro("/x/metrics.json", falso({ isSymbolicLink: () => true })), /link simbólico/);
  await assert.rejects(exigirArquivoSeguro("/x/metrics.json", falso({})), /não é um arquivo comum/);
  await assert.doesNotReject(exigirArquivoSeguro("/x/metrics.json", falso({ isFile: () => true })));
  await assert.doesNotReject(exigirArquivoSeguro("/x/metrics.json", async () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); }));
});

test("clone como junction/link é recusado (A1); .git como junction/link é recusado antes de qualquer git e o clone nosso é recriado", async (t) => {
  for (const alvo of ["clone", "dotgit"]) {
    const a = await ambiente();
    await a.exportar();
    await a.cmd(["publish", "--yes"], TTY());
    const outro = join(await tmp("ai-usage-metrics-r2junc-"), "clone");
    git(undefined, "clone", "--quiet", a.remoto, outro);
    const evil = await bare("evil");
    git(outro, "config", "remote.origin.pushurl", barra(evil));
    const caminho = alvo === "clone" ? a.paths.clone : join(a.paths.clone, ".git");
    const destino = alvo === "clone" ? outro : join(outro, ".git");
    await rm(caminho, { recursive: true, force: true });
    try {
      await symlink(destino, caminho, "junction");
    } catch (e) {
      if (e.code === "EPERM" || e.code === "EACCES") return t.skip("PULADO: não foi possível criar junction/link de pasta neste SO");
      throw e;
    }
    await a.config((c) => (c.title = `Painel ${alvo}`));
    if (alvo === "clone") {
      // A1: a pasta 'repo' virou link/junction: recusa (sem seguir, sem apagar nada do alvo do link)
      await assert.rejects(a.cmd(["publish", "--yes"], TTY()), /link simbólico\/junction/);
      assert.equal(commits(a.remoto).length, 1);
      assert.equal(commits(evil).length, 0);
      assert.equal(git(outro, "config", "remote.origin.pushurl"), barra(evil), "o repositório apontado pelo link continua intacto");
      continue;
    }
    await a.cmd(["publish", "--yes"], TTY());
    assert.match(a.texto(), /foi recriado \(\.git era um arquivo ou link simbólico/, alvo);
    assert.equal(commits(a.remoto).length, 2, alvo);
    assert.equal(commits(evil).length, 0, alvo);
    assert.equal((await lstat(join(a.paths.clone, ".git"))).isDirectory(), true, alvo);
    assert.equal(git(outro, "config", "remote.origin.pushurl"), barra(evil), "a pasta apontada pelo link não foi apagada nem alterada");
  }
});
