// Quarta rodada: --state-dir pelo realpath/grafias, cwd/teto do git, poda de repo.velho-*, marcador, mensagens e fluxos de remoto.
// 100% local (bare temporário, dados sintéticos, nenhuma rede). Tudo é apagado no final.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { after, test } from "node:test";
import { main } from "../src/cli.mjs";
import { aposentarClone, podarVelhos } from "../src/clone-owner.mjs";
import { caminhos, grafiaPerigosa } from "../src/config.mjs";
import { claudeFalso } from "./fixtures.mjs";

const pastas = [];
const configGlobal = join(tmpdir(), `ai-usage-metrics-cfg-r4-${process.pid}`);
after(async () => {
  for (const p of pastas) await rm(p, { recursive: true, force: true });
  await rm(configGlobal, { force: true });
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
  const d = join(await tmp("ai-usage-r4pub-"), `${nome}.git`);
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", d], { env: process.env });
  return d;
};

async function escreverConfigGlobal(linhas = "") {
  await writeFile(configGlobal, linhas, "utf8");
}
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: configGlobal,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Teste",
  GIT_AUTHOR_EMAIL: "teste@exemplo.invalid",
  GIT_COMMITTER_NAME: "Teste",
  GIT_COMMITTER_EMAIL: "teste@exemplo.invalid",
  GIT_TERMINAL_PROMPT: "0",
  AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE: "1", // somente testes
});
await escreverConfigGlobal();

async function ambiente({ remoto } = {}) {
  const raiz = await tmp("ai-usage-r4-");
  remoto ??= await bare("remoto");
  const stateDir = join(raiz, "estado");
  const paths = caminhos(stateDir);
  const saidas = [];
  const out = (l) => saidas.push(l);
  const cmd = (args, io = SEM_TTY()) => main([...args, "--state-dir", stateDir], out, io);
  const home = await tmp("ai-usage-r4home-");
  await claudeFalso(home);
  await cmd(["init", "--user", "fulano", "--remote", remoto, "--public", "projeto-alfa", "--title", "Painel um"]);
  const config = async (muda) => {
    const c = JSON.parse(await readFile(paths.config, "utf8"));
    muda(c);
    await writeFile(paths.config, JSON.stringify(c), "utf8");
  };
  return { raiz, remoto, stateDir, paths, saidas, cmd, config, home, exportar: () => cmd(["export", "--home", home]), texto: () => saidas.join("\n") };
}

function repoAlheio(pasta, origin) {
  execFileSync("git", ["init", "-q", "-b", "main", pasta], { env: process.env });
  git(pasta, "remote", "add", "origin", barra(origin));
  execFileSync("git", ["-C", pasta, "commit", "--allow-empty", "-q", "-m", "trabalho-local-importante"], { env: process.env });
}
const velhos = async (stateDir) => (await readdir(stateDir)).filter((n) => /^repo\.velho-\d{13}-[0-9a-f]{6}$/.test(n));
const espera = () => new Promise((r) => setTimeout(r, 5));
const recusa = (casa, stateDir, padrao) => assert.rejects(main(["export", "--state-dir", stateDir, "--home", casa], () => {}, SEM_TTY()), padrao, stateDir);

// ---------------- Item 1: --state-dir pelo realpath e grafias perigosas ----------------
test("R4-1: grafiaPerigosa reconhece \\\\?\\, //?/, \\\\.\\, UNC e ponto/espaço final (regra do Windows, testável em qualquer SO)", () => {
  const ruins = ["\\\\?\\C:\\Users\\fulano", "//?/C:/Users/fulano", "\\\\.\\C:\\Users\\fulano", "\\\\?\\UNC\\servidor\\c$\\x"];
  for (const p of ruins) assert.ok(grafiaPerigosa(p, "linux"), p);
  for (const p of ["\\\\localhost\\c$\\Users\\fulano", "//servidor/compartilhado/x", "C:\\Users\\fulano.", "C:\\Users\\fulano ", "C:\\Users\\fulano.\\estado", "C:\\Users\\fulano \\estado"]) {
    assert.ok(grafiaPerigosa(p, "win32"), p);
  }
  for (const p of ["C:\\Users\\fulano\\.ai-usage-metrics", "C:\\Users\\fulano\\estado", "C:\\Users\\.\\fulano\\..\\fulano\\x", "/home/fulano/.ai-usage-metrics"]) assert.equal(grafiaPerigosa(p, "win32"), null, p);
});

test("R4-1: --state-dir como a casa em todas as grafias é recusado (\\\\?\\, //?/, ponto/espaço final, UNC localhost\\c$)", async (t) => {
  const casa = await tmp("ai-usage-r4casa-");
  await recusa(casa, `\\\\?\\${casa}`, /prefixo de caminho estendido/);
  await recusa(casa, `//?/${barra(casa)}`, /prefixo de caminho estendido/);
  await recusa(casa, `\\\\?\\${casa}\\estado`, /prefixo de caminho estendido/);
  await recusa(casa, casa, /pasta pessoal inteira/);
  if (process.platform !== "win32") return t.skip("PULADO: ponto/espaço final e UNC são regras do Windows (cobertas por grafiaPerigosa acima)");
  await recusa(casa, `${casa}.`, /ponto ou espaço/);
  await recusa(casa, `${casa} `, /ponto ou espaço/);
  await recusa(casa, `${casa}.\\estado`, /ponto ou espaço/);
  const unc = `\\\\localhost\\${parse(casa).root[0]}$\\${casa.slice(3)}`;
  await recusa(casa, unc, /UNC/);
  await recusa(casa, `\\\\servidor\\compartilhado\\x`, /UNC/);
});

test("R4-1: nome 8.3 da casa falsa resolve para a mesma pasta e é recusado", async (t) => {
  if (process.platform !== "win32") return t.skip("PULADO: nomes 8.3 só existem no Windows");
  const casa = await tmp("ai-usage-r4-casa-com-nome-bem-longo-");
  let curto = "";
  try {
    curto = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${casa.replace(/'/g, "''")}').ShortPath`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return t.skip("PULADO: não consegui obter o nome 8.3");
  }
  if (!curto || curto.toLowerCase() === casa.toLowerCase()) return t.skip("PULADO: nomes 8.3 desligados neste volume");
  await recusa(casa, curto, /pasta pessoal inteira/);
  await recusa(casa, `${curto}\\`, /pasta pessoal inteira/);
});

test("R4-1: junction/link que resolve para a casa ou para a raiz da unidade é recusado; pasta própria nova continua aceita", async (t) => {
  const casa = await tmp("ai-usage-r4casa-");
  const lugar = await tmp("ai-usage-r4links-");
  const paraCasa = join(lugar, "atalho-casa");
  const paraRaiz = join(lugar, "atalho-raiz");
  try {
    await symlink(casa, paraCasa, "junction");
    await symlink(parse(casa).root, paraRaiz, "junction");
  } catch (e) {
    if (e.code === "EPERM" || e.code === "EACCES") return t.skip("PULADO: sem privilégio para criar link/junction neste SO");
    throw e;
  }
  await recusa(casa, paraCasa, /pasta pessoal inteira/);
  await recusa(casa, join(paraCasa, "."), /pasta pessoal inteira/);
  await recusa(casa, paraRaiz, /raiz de uma unidade/);
  // pasta ainda inexistente dentro de uma pasta pessoal alcançada por link não é a casa: aceita (o realpath do ancestral + resto)
  const ok = join(lugar, "estado-novo");
  await assert.doesNotReject(main(["export", "--state-dir", ok, "--home", casa], () => {}, SEM_TTY()).catch((e) => (/--state-dir inválido/.test(e.message) ? Promise.reject(e) : undefined)));
});

// ---------------- Item 2: git com cwd explícito e teto de descoberta ----------------
test("R4-2: state-dir dentro de um repositório do usuário: o repo pai (config, insteadOf, hooks, refs) não é herdado nem tocado", async () => {
  const a = await ambiente();
  const outro = await bare("desvio");
  const pai = a.raiz; // o state-dir é <raiz>/estado: a raiz vira um repositório "do usuário" envenenado
  execFileSync("git", ["init", "-q", "-b", "main", pai], { env: process.env });
  const hooks = join(pai, "hooks-do-usuario");
  await mkdir(hooks);
  const disparou = join(pai, "hook-disparou.txt");
  for (const h of ["post-checkout", "pre-push", "post-commit", "reference-transaction"]) await writeFile(join(hooks, h), `#!/bin/sh\necho ${h} >> "${barra(disparou)}"\n`, { mode: 0o755 });
  git(pai, "config", "core.hooksPath", barra(hooks));
  git(pai, "config", `url.${barra(outro)}.insteadOf`, barra(a.remoto));
  git(pai, "config", "--add", `url.${barra(outro)}.insteadOf`, a.remoto);
  const antes = git(pai, "for-each-ref");
  const configAntes = await readFile(join(pai, ".git", "config"), "utf8");
  await a.exportar();
  const cwdOriginal = process.cwd();
  process.chdir(pai); // o processo "herda" o repo do usuário: nenhum comando git pode usar esse diretório
  try {
    await a.cmd(["publish", "--yes"], TTY());
    await a.cmd(["publish", "--yes"], TTY()); // segundo envio (fetch/status/checkout no clone existente)
  } finally {
    process.chdir(cwdOriginal);
  }
  assert.equal(commits(a.remoto).length, 1, "o envio foi para o destino aprovado");
  assert.deepEqual(commits(outro), [], "o insteadOf do repo pai não desviou o envio");
  assert.equal(existsSync(disparou), false, "hooks do repo pai não rodaram");
  assert.equal(git(pai, "for-each-ref"), antes, "refs do repo pai intactas");
  assert.equal(await readFile(join(pai, ".git", "config"), "utf8"), configAntes, "config do repo pai intacta");
  assert.throws(() => git(pai, "rev-parse", "--verify", "-q", "HEAD"), "o repo pai continua sem commits");
});

test("R4-2: o helper de git recusa rodar sem cwd explícito", async () => {
  const { enviar } = await import("../src/publish.mjs");
  assert.equal(typeof enviar, "function");
  const fonte = await readFile(new URL("../src/publish.mjs", import.meta.url), "utf8");
  assert.match(fonte, /todo comando git precisa de cwd explícito/);
  assert.doesNotMatch(fonte, /\{ env \}\)/, "nenhuma chamada git sem cwd");
});

// ---------------- Itens 3 e 4: poda e marcador ----------------
async function plantarVelho(stateDir, nome, { marcador, interno }) {
  const pasta = join(stateDir, nome);
  await mkdir(join(pasta, ".git"), { recursive: true });
  await writeFile(join(pasta, "dele.txt"), "x");
  if (interno !== undefined) await writeFile(join(pasta, ".git", "ai-usage-metrics-owner"), interno);
  if (marcador) await writeFile(join(stateDir, `${nome}.owner.json`), JSON.stringify(marcador));
  return pasta;
}

test("R4-3: repo.velho-* com marcador forjado (sem cópia interna, com id diferente, ou caminho fora do state-dir) NÃO é apagado", async () => {
  const a = await ambiente();
  await a.exportar();
  await a.cmd(["publish", "--yes"], TTY());
  const real = await realpath(a.stateDir);
  const id = "a".repeat(32);
  const ok = { tool: "ai-usage-metrics", id, path: join(real, "repo"), createdAt: "x" };
  const forjados = [
    await plantarVelho(a.stateDir, "repo.velho-0000000000001-aaaaaa", { marcador: ok }), // sem a cópia interna
    await plantarVelho(a.stateDir, "repo.velho-0000000000002-bbbbbb", { marcador: ok, interno: "b".repeat(32) + "\n" }), // id diferente
    await plantarVelho(a.stateDir, "repo.velho-0000000000003-cccccc", { marcador: { ...ok, path: join(tmpdir(), "outro", "repo") }, interno: id + "\n" }), // caminho de outro lugar
    await plantarVelho(a.stateDir, "repo.velho-0000000000004-dddddd", { marcador: { ...ok, path: join(real, "qualquer") }, interno: id + "\n" }), // não é 'repo'
  ];
  const legitimo = await plantarVelho(a.stateDir, "repo.velho-0000000000005-eeeeee", { marcador: ok, interno: id + "\n" });
  await podarVelhos(a.stateDir, 0);
  for (const p of forjados) assert.ok(existsSync(join(p, "dele.txt")), `não apagou ${p}`);
  assert.equal(existsSync(legitimo), false, "o velho com marcador de fora e de dentro coerentes é podado");
  assert.equal(existsSync(`${legitimo}.owner.json`), false);
});

test("R4-3: o fluxo normal continua podando só os nossos (marcador de fora + cópia de dentro)", async () => {
  const a = await ambiente();
  await a.exportar();
  await a.cmd(["publish", "--yes"], TTY());
  for (const alvo of [await bare("p1"), await bare("p2"), await bare("p3"), await bare("p4"), await bare("p5")]) {
    await a.config((c) => (c.remoteUrl = alvo));
    await a.cmd(["publish", "--yes"], TTY());
    await espera();
  }
  assert.equal((await velhos(a.stateDir)).length, 3);
});

test("R4-4: falha ao mover o marcador de posse gera aviso claro (não é engolida) e a pasta velha é preservada", async () => {
  const stateDir = await tmp("ai-usage-r4velho-");
  const clone = join(stateDir, "repo");
  await mkdir(clone);
  await writeFile(join(clone, "dele.txt"), "x");
  // sem repo.owner.json: o rename do marcador falha (ENOENT) e isso tem de ser avisado
  const avisos = [];
  const nome = await aposentarClone(stateDir, clone, { avisar: (m) => avisos.push(m) });
  assert.match(nome, /^repo\.velho-\d{13}-[0-9a-f]{6}$/);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /não consegui mover o marcador de posse/);
  assert.match(avisos[0], /ficará sem marcador[\s\S]*só vai acumular|só vai acumular/);
  assert.ok(existsSync(join(stateDir, nome, "dele.txt")));
  // e sem marcador a poda nunca o apaga
  await podarVelhos(stateDir, 0);
  assert.ok(existsSync(join(stateDir, nome, "dele.txt")));
});

// ---------------- Item 5 e 6: mensagem de recusa; run agendado com 'repo' alheio ----------------
async function listagem(dir, base = dir, acc = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory() && e.name !== "node_modules") await listagem(p, base, acc);
    else acc.push(`${p.slice(base.length)}:${e.isFile() ? (await readFile(p)).length : "d"}`);
  }
  return acc.sort();
}

test("R4-5/6: o run agendado que encontra 'repo' alheio falha com mensagem clara (incluindo versão anterior) e não altera nada", async () => {
  const a = await ambiente();
  await a.exportar();
  await a.cmd(["publish", "--yes"], TTY());
  await a.config((c) => (c.autoPublish = true));
  await rm(a.paths.clone, { recursive: true, force: true });
  await rm(join(a.stateDir, "repo.owner.json"), { force: true }); // como um clone de versão anterior: sem marcador
  repoAlheio(a.paths.clone, await bare("outro"));
  await writeFile(join(a.paths.clone, "anotacao.txt"), "não perca\n");
  const antes = await listagem(a.raiz);
  const commitsAntes = commits(a.remoto).length;
  await assert.rejects(a.cmd(["run", "--home", a.home]), (e) => {
    assert.match(e.message, /NÃO foi criada por esta ferramenta/);
    assert.match(e.message, /versão anterior desta ferramenta/);
    assert.match(e.message, /renomear a pasta 'repo'/);
    assert.match(e.message, /Nada foi apagado\./);
    return true;
  });
  assert.equal(commits(a.remoto).length, commitsAntes);
  const depois = await listagem(a.raiz);
  assert.deepEqual(depois.filter((l) => !/[\\/]out[\\/]|state\.json|\.lock|avisos|sem-hooks|metrics/.test(l)), antes.filter((l) => !/[\\/]out[\\/]|state\.json|\.lock|avisos|sem-hooks|metrics/.test(l)));
  assert.equal(git(a.paths.clone, "log", "--format=%s"), "trabalho-local-importante");
  assert.equal(await readFile(join(a.paths.clone, "anotacao.txt"), "utf8"), "não perca\n");
  assert.deepEqual(await velhos(a.stateDir), []);
});

// ---------------- Item 6: SCP -> ssh:// ----------------
test("R4-6: trocar o remoto de SCP para ssh://: o automático bloqueia, o clone é aposentado por renomeação e o próximo manual reaprova (sem rm)", async () => {
  const bareReal = await bare("scp-ssh");
  const scp = "git@exemplo.invalid:fulano/ai-metrics.git";
  const ssh = "ssh://git@exemplo.invalid/fulano/ai-metrics.git";
  // as duas formas "resolvem" (insteadOf do usuário) para o mesmo bare local: nenhuma rede
  await escreverConfigGlobal(`[url "${barra(bareReal)}"]\n\tinsteadOf = ${scp}\n\tinsteadOf = ${ssh}\n`);
  try {
    const a = await ambiente({ remoto: scp });
    await a.exportar();
    await a.cmd(["publish", "--yes"], TTY());
    assert.equal(commits(bareReal).length, 1);
    await a.config((c) => (c.autoPublish = true));
    await a.config((c) => (c.remoteUrl = ssh));
    // 1) automático: bloqueado, nada é enviado nem aposentado
    await a.cmd(["run", "--home", a.home]);
    assert.match(a.texto(), /Envio automático BLOQUEADO/);
    assert.deepEqual(await velhos(a.stateDir), []);
    assert.equal(commits(bareReal).length, 1);
    // 2) manual: reaprova; o clone (aponta para scp://) é RENOMEADO, não apagado
    await a.cmd(["publish", "--yes"], TTY());
    assert.match(a.texto(), /o clone local de dados foi recriado \(o clone apontava para outro repositório\)/);
    const v = await velhos(a.stateDir);
    assert.equal(v.length, 1);
    assert.ok(existsSync(join(a.stateDir, v[0], ".git")), "o clone antigo continua inteiro, só com outro nome");
    assert.ok(existsSync(join(a.stateDir, `${v[0]}.owner.json`)));
    const estado = JSON.parse(await readFile(a.paths.estado, "utf8"));
    assert.match(JSON.stringify(estado.approvedTarget), /ssh:\/\/git@exemplo\.invalid/);
    // 3) agora o automático volta a valer com a forma ssh://
    const antes = a.saidas.length;
    await a.cmd(["run", "--home", a.home]);
    assert.doesNotMatch(a.saidas.slice(antes).join("\n"), /BLOQUEADO/);
  } finally {
    await escreverConfigGlobal();
  }
});
