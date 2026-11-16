// Testes de publish/run/init contra um repositório git BARE LOCAL como "remote". Sem rede, sem GitHub.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { main } from "../src/cli.mjs";
import { caminhos } from "../src/config.mjs";
import { claudeFalso } from "./fixtures.mjs";
import { metricasSinteticas } from "./sintetico.mjs";

// Isola o git do computador de quem roda o teste (sem config global, sem hooks, identidade fixa e fictícia).
const ENV = {
  GIT_CONFIG_GLOBAL: join(tmpdir(), "ai-usage-metrics-sem-config"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Teste",
  GIT_AUTHOR_EMAIL: "teste@exemplo.invalid",
  GIT_COMMITTER_NAME: "Teste",
  GIT_COMMITTER_EMAIL: "teste@exemplo.invalid",
  GIT_TERMINAL_PROMPT: "0",
  AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE: "1", // somente testes: libera o remoto bare local
};
Object.assign(process.env, ENV);

const CINCO = ["metrics.json", "metrics.model-1.svg", "metrics.model-2.svg", "metrics.model-3.svg", "metrics.svg"]; // ordem alfabética
const pastas = [];
after(async () => {
  for (const p of pastas) await rm(p, { recursive: true, force: true });
});

const gitRemoto = (remoto, ...args) => execFileSync("git", [`--git-dir=${remoto}`, ...args], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "ignore"] }).trim();
const commitsNoRemoto = (remoto) => {
  try {
    return gitRemoto(remoto, "log", "--format=%s", "main").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

async function ambiente({ publicos = "meu-site" } = {}) {
  const raiz = await mkdtemp(join(tmpdir(), "ai-usage-metrics-teste-"));
  pastas.push(raiz);
  const remoto = join(raiz, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remoto], { env: process.env });
  const stateDir = join(raiz, "estado");
  const paths = caminhos(stateDir);
  const saidas = [];
  const out = (l) => saidas.push(l);
  const io = { isTTY: false, perguntas: [], resposta: "n", async ask(p) { this.perguntas.push(p); return this.resposta; } };
  const cmd = (args, ioLocal = io) => main([...args, "--state-dir", stateDir], out, ioLocal);
  await cmd(["init", "--user", "fulano", "--remote", remoto, "--public", publicos, "--title", "Meu painel"]);
  return { raiz, remoto, stateDir, paths, saidas, out, io, cmd, texto: () => saidas.join("\n") };
}

async function gravarJson(paths, json) {
  await mkdir(paths.saida, { recursive: true });
  await writeFile(paths.json, JSON.stringify(json, null, 2) + "\n", "utf8");
}

test("publish: dry-run (padrão sem terminal) mostra o plano e não altera nada", async () => {
  const a = await ambiente();
  await gravarJson(a.paths, await metricasSinteticas());
  await a.cmd(["publish"]);
  const t = a.texto();
  assert.match(t, /Dry-run: nada foi enviado/);
  assert.match(t, /metrics\.json/);
  assert.match(t, /metrics\.svg/);
  assert.match(t, /novo/);
  assert.match(t, /Nomes que ficariam PÚBLICOS: meu-site/);
  assert.match(t, /1 projeto\(s\) anonimizado\(s\)/);
  assert.equal(commitsNoRemoto(a.remoto).length, 0);
  assert.equal(gitRemoto(a.remoto, "for-each-ref"), "");
  assert.equal(existsSync(a.paths.clone), false, "dry-run não pode nem criar o clone");
  assert.equal(existsSync(a.paths.estado), false);
});

test("publish --dry-run nunca pergunta, mesmo com terminal", async () => {
  const a = await ambiente();
  await gravarJson(a.paths, await metricasSinteticas());
  await a.cmd(["publish", "--dry-run", "--yes"], { isTTY: true, ask: async () => assert.fail("não deveria perguntar") });
  assert.equal(commitsNoRemoto(a.remoto).length, 0);
});

test("publish: recusa sem confirmação (resposta 'n' no prompt e sem --yes fora do terminal)", async () => {
  const a = await ambiente();
  await gravarJson(a.paths, await metricasSinteticas());
  a.io.isTTY = true;
  a.io.resposta = "n";
  await a.cmd(["publish"]);
  assert.equal(a.io.perguntas.length, 1);
  assert.match(a.texto(), /Cancelado/);
  assert.equal(commitsNoRemoto(a.remoto).length, 0);
  assert.equal(existsSync(a.paths.clone), false);
});

const TTY_SEM_PERGUNTA = { isTTY: true, ask: async () => assert.fail("não deveria perguntar") };

test("publish --yes: envia só os 5 arquivos (metrics.json, metrics.svg e os 3 metrics.model-N.svg), com mensagem fixa, e registra o publish manual (só em terminal interativo)", async () => {
  const a = await ambiente();
  await gravarJson(a.paths, await metricasSinteticas());
  await a.cmd(["publish", "--yes"], TTY_SEM_PERGUNTA);
  assert.deepEqual(commitsNoRemoto(a.remoto), ["chore(metrics): update AI usage metrics"]);
  const arquivos = gitRemoto(a.remoto, "ls-tree", "-r", "--name-only", "main").split("\n").sort();
  assert.deepEqual(arquivos, CINCO);
  const svg = gitRemoto(a.remoto, "show", "main:metrics.svg");
  assert.match(svg, /<title id="ttl">Meu painel<\/title>/);
  assert.doesNotMatch(svg, /<script/);
  const json = JSON.parse(gitRemoto(a.remoto, "show", "main:metrics.json"));
  assert.equal(json.schemaVersion, 1);
  assert.ok(!JSON.stringify(json).includes("segredo-x"), "projeto fora da allowlist não pode vazar");
  const estado = JSON.parse(await readFile(a.paths.estado, "utf8"));
  assert.equal(estado.manualPublishConfirmed, true);
  assert.deepEqual(estado.approvedPublicNames, ["meu-site"]);
});

test("publish com prompt interativo respondendo 's' envia; segundo envio com dados novos vira novo commit (um JSON agregado, sem arquivo por projeto)", async () => {
  const a = await ambiente();
  await gravarJson(a.paths, await metricasSinteticas());
  a.io.isTTY = true;
  a.io.resposta = "s";
  await a.cmd(["publish"]);
  assert.equal(commitsNoRemoto(a.remoto).length, 1);

  await gravarJson(a.paths, await metricasSinteticas({ extra: true, agora: "2026-03-11T12:00:00Z" }));
  await a.cmd(["publish", "--dry-run"]);
  assert.match(a.texto(), /\[alterado: \+\d+ -\d+ linhas\]/);
  await a.cmd(["publish", "--yes"]);
  assert.equal(commitsNoRemoto(a.remoto).length, 2);
  assert.deepEqual(gitRemoto(a.remoto, "ls-tree", "-r", "--name-only", "main").split("\n").sort(), CINCO);

  // publicar de novo exatamente o mesmo conteúdo não cria commit vazio
  await a.cmd(["publish", "--yes"]);
  assert.equal(commitsNoRemoto(a.remoto).length, 2);
  assert.match(a.texto(), /Nada enviado: nada mudou/);
});

test("publish: recusa JSON inválido (campo extra, caminho, e-mail, texto livre, projeto público fora da allowlist) sem enviar nada", async () => {
  const a = await ambiente();
  const base = await metricasSinteticas();
  const casos = [
    [(j) => (j.dono = "fulano"), /campo não permitido/],
    [(j) => ((j.projects[0].name = "C:\\Users\\fulano\\proj"), (j.projects[0].public = true)), /nome inválido/],
    [(j) => ((j.projects[0].name = "fulano@mail.com"), (j.projects[0].public = true)), /nome inválido/],
    [(j) => (j.tools[0].name = "Refatorei o módulo de pagamentos do cliente"), /nome de ferramenta diferente/],
    [(j) => ((j.projects[0].name = "projeto-secreto"), (j.projects[0].public = true)), /fora da allowlist/],
  ];
  for (const [mut, padrao] of casos) {
    const j = JSON.parse(JSON.stringify(base));
    mut(j);
    await gravarJson(a.paths, j);
    await assert.rejects(a.cmd(["publish", "--yes"]), padrao);
  }
  await writeFile(a.paths.json, "{ não é json", "utf8");
  await assert.rejects(a.cmd(["publish", "--yes"]), /não é um JSON válido/);
  await rm(a.paths.json);
  await assert.rejects(a.cmd(["publish", "--yes"]), /não existe/);
  assert.equal(commitsNoRemoto(a.remoto).length, 0);
  assert.equal(existsSync(a.paths.clone), false);
});

test("publish: edição manual do JSON com e-mail ou caminho no meio de campo permitido é barrada", async () => {
  const a = await ambiente();
  const j = await metricasSinteticas();
  j.generatedAt = "2026-03-10T12:00:00Z fulano@mail.com";
  await gravarJson(a.paths, j);
  await assert.rejects(a.cmd(["publish", "--yes"]), /generatedAt/);
});

test("run sem terminal: só gera quando autoPublish está desligado ou falta um publish manual", async () => {
  const a = await ambiente({ publicos: "projeto-alfa" });
  const home = await mkdtemp(join(tmpdir(), "ai-usage-metrics-home-"));
  pastas.push(home);
  await claudeFalso(home);

  await a.cmd(["run", "--home", home]);
  assert.match(a.texto(), /autoPublish está desligado/);
  assert.ok(existsSync(a.paths.json) && existsSync(a.paths.svg));
  assert.equal(commitsNoRemoto(a.remoto).length, 0);

  const cfg = JSON.parse(await readFile(a.paths.config, "utf8"));
  cfg.autoPublish = true;
  await writeFile(a.paths.config, JSON.stringify(cfg), "utf8");
  await a.cmd(["run", "--home", home]);
  assert.match(a.texto(), /publish" manual confirmado/);
  assert.equal(commitsNoRemoto(a.remoto).length, 0);
});

test("run --non-interactive: nunca pergunta, mesmo quando o processo tem console (Agendador do Windows)", async () => {
  const a = await ambiente({ publicos: "projeto-alfa" });
  const home = await mkdtemp(join(tmpdir(), "ai-usage-metrics-home-"));
  pastas.push(home);
  await claudeFalso(home);

  // Sem a opção, um console faz o "run" seguir o fluxo manual e perguntar (era o que travava a tarefa agendada).
  const perguntas = [];
  const comConsole = { isTTY: true, ask: async (p) => { perguntas.push(p); return "n"; } };
  await a.cmd(["run", "--home", home], comConsole);
  assert.equal(perguntas.length, 1, "sem --non-interactive e com console, o run pergunta");

  // Com a opção, o mesmo console não pode receber nenhuma pergunta (TTY_SEM_PERGUNTA falha o teste se perguntar).
  await a.cmd(["run", "--non-interactive", "--home", home], TTY_SEM_PERGUNTA);
  assert.match(a.texto(), /autoPublish está desligado/);
  assert.equal(commitsNoRemoto(a.remoto).length, 0);

  // Com autoPublish ligado, mas sem publish manual confirmado: também não pergunta e não envia.
  const cfg = JSON.parse(await readFile(a.paths.config, "utf8"));
  cfg.autoPublish = true;
  await writeFile(a.paths.config, JSON.stringify(cfg), "utf8");
  await a.cmd(["run", "--non-interactive", "--home", home], TTY_SEM_PERGUNTA);
  assert.match(a.texto(), /publish" manual confirmado/);
  assert.equal(commitsNoRemoto(a.remoto).length, 0);
});

test("run sem terminal com autoPublish: envia só depois de um publish manual, e bloqueia nomes públicos novos", async () => {
  const a = await ambiente({ publicos: "projeto-alfa" });
  const home = await mkdtemp(join(tmpdir(), "ai-usage-metrics-home-"));
  pastas.push(home);
  await claudeFalso(home);

  // publish manual confirmado (aprova o nome público "projeto-alfa")
  await a.cmd(["export", "--home", home]);
  await a.cmd(["publish", "--yes"], TTY_SEM_PERGUNTA);
  assert.equal(commitsNoRemoto(a.remoto).length, 1);

  const cfg = JSON.parse(await readFile(a.paths.config, "utf8"));
  cfg.autoPublish = true;
  await writeFile(a.paths.config, JSON.stringify(cfg), "utf8");

  // dados novos (outra sessão) -> o agendador pode enviar
  await claudeFalso(home, { sessao: "sess-2", dia: "2026-03-05" });
  await a.cmd(["run", "--home", home]);
  assert.match(a.texto(), /Enviado para/);
  assert.equal(commitsNoRemoto(a.remoto).length, 2);

  // o usuário inclui um nome público novo na config, mas ainda não aprovou num publish manual -> bloqueado
  cfg.publicProjects = ["projeto-alfa", "proj-b"];
  await writeFile(a.paths.config, JSON.stringify(cfg), "utf8");
  await claudeFalso(home, { sessao: "sess-3", dia: "2026-03-06", cwd: "C:\\Users\\fulano\\Desktop\\proj-b" });
  await a.cmd(["run", "--home", home]);
  assert.match(a.texto(), /BLOQUEADO[\s\S]*proj-b/);
  assert.equal(commitsNoRemoto(a.remoto).length, 2);
});

test("init: grava config, imprime README e agendamento, não instala nada nem sobrescreve sem --overwrite", async () => {
  const raiz = await mkdtemp(join(tmpdir(), "ai-usage-metrics-init-"));
  pastas.push(raiz);
  const saidas = [];
  const args = ["init", "--user", "fulano", "--repo", "meus-dados", "--theme", "dark", "--lang", "pt-BR", "--state-dir", raiz];
  await main(args, (l) => saidas.push(l), { isTTY: false, ask: async () => "" });
  const t = saidas.join("\n");
  assert.match(t, /!\[AI usage\]\(https:\/\/raw\.githubusercontent\.com\/fulano\/meus-dados\/main\/metrics\.svg\)/);
  assert.match(t, /schtasks \/Create \/SC DAILY/);
  assert.match(t, /crontab -e/);
  assert.match(t, /só IMPRIME/);
  const cfg = JSON.parse(await readFile(join(raiz, "config.json"), "utf8"));
  assert.equal(cfg.autoPublish, false);
  assert.equal(cfg.theme, "dark");
  await assert.rejects(main(args, () => {}, { isTTY: false, ask: async () => "" }), /--overwrite/);
  await assert.rejects(main(["init", "--user", "x y", "--state-dir", join(raiz, "b")], () => {}, { isTTY: false, ask: async () => "" }), /githubUser/);
  await assert.rejects(main(["init", "--user", "fulano", "--remote", "https://usuario:token@github.com/a/b.git", "--state-dir", join(raiz, "c")], () => {}, { isTTY: false, ask: async () => "" }), /usuário\/senha\/token/);
});

test("config: chave desconhecida é recusada (um erro de digitação não liga nem desliga travas em silêncio)", async () => {
  const a = await ambiente();
  const cfg = JSON.parse(await readFile(a.paths.config, "utf8"));
  cfg.autopublish = true;
  await writeFile(a.paths.config, JSON.stringify(cfg), "utf8");
  await assert.rejects(a.cmd(["publish"]), /chave desconhecida/);
});

test("render: gera o SVG a partir do JSON validado e recusa JSON inválido", async () => {
  const a = await ambiente();
  await gravarJson(a.paths, await metricasSinteticas());
  await a.cmd(["render", "--theme", "light", "--title", "Painel <b>"]);
  const svg = await readFile(a.paths.svg, "utf8");
  assert.match(svg, /Painel &lt;b&gt;/);
  assert.doesNotMatch(svg, /prefers-color-scheme/);
  const ruim = await metricasSinteticas();
  ruim.extra = true;
  await gravarJson(a.paths, ruim);
  await assert.rejects(a.cmd(["render"]), /esquema v1/);
  await assert.rejects(a.cmd(["render", "--theme", "neon"]), /--theme/);
});

test("segurança do código: sem rede própria, sem --force, sem refspec forçado", async () => {
  const { readdir } = await import("node:fs/promises");
  const raiz = new URL("../src/", import.meta.url);
  const arquivos = [];
  const andar = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const u = new URL(e.name + (e.isDirectory() ? "/" : ""), dir);
      if (e.isDirectory()) await andar(u);
      else if (e.name.endsWith(".mjs")) arquivos.push(u);
    }
  };
  await andar(raiz);
  assert.ok(arquivos.length > 5);
  for (const u of arquivos) {
    const src = (await readFile(u, "utf8")).replace(/(?<!:)\/\/.*$/gm, ""); // sem comentários
    assert.doesNotMatch(src, /node:(http|https|http2|net|dns|tls|dgram)/, u.pathname);
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|WebSocket/, u.pathname);
    assert.doesNotMatch(src, /--force|--force-with-lease|"-f"|"\+refs/, u.pathname);
  }
});
