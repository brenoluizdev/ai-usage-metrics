// Assistente + histórico: a guarda de regressão do publish não é contornada e o restore do assistente nunca encolhe o history.json.
// Remoto = repositório bare local; externos falsos; sem rede.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { main } from "../src/cli.mjs";
import { caminhos } from "../src/config.mjs";
import { claudeFalso, homeFalsa } from "./fixtures.mjs";

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(tmpdir(), "ai-usage-metrics-sem-config-sethist"),
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
const git = (remoto, ...a) => execFileSync("git", [`--git-dir=${remoto}`, ...a], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "ignore"] }).trim();
const diasRemoto = (r) => JSON.parse(git(r, "show", "main:metrics.json")).timeline.points.length;

/** 3 dias publicados num terminal; depois o Claude "apagou" os 2 mais antigos. */
async function cenario() {
  const raiz = await mkdtemp(join(tmpdir(), "ai-usage-metrics-sethist-"));
  pastas.push(raiz);
  const remoto = join(raiz, "r.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remoto], { env: process.env });
  const estado = join(raiz, "estado");
  const paths = caminhos(estado);
  const home = await homeFalsa();
  for (let i = 0; i < 3; i++) await claudeFalso(home, { dia: `2026-03-0${i + 1}`, sessao: `s${i}`, pasta: `p${i}` });
  const base = ["--state-dir", estado, "--home", home];
  const tty = { isTTY: true, async ask() { return "s"; } };
  await main(["init", "--user", "usuario-teste", "--remote", remoto, ...base], () => {}, tty);
  await main(["export", ...base], () => {}, tty);
  await main(["publish", ...base], () => {}, tty);
  assert.equal(diasRemoto(remoto), 3);
  for (let i = 0; i < 2; i++) await rm(join(home, ".claude", "projects", `p${i}`), { recursive: true, force: true });
  return { remoto, estado, paths, home, base };
}

async function assistente(c, regras) {
  const saidas = [];
  const prompts = [];
  const io = {
    isTTY: true,
    externos: {},
    ambiente: { plataforma: "linux", cores: false, versao: "0.2.0" },
    async ask(p) {
      prompts.push(p);
      for (const [re, r] of regras) if (re.test(p)) return r;
      return "";
    },
  };
  await main(["setup", ...c.base], (l) => saidas.push(String(l)), io);
  return { texto: saidas.join("\n"), prompts };
}

test("assistente + guarda: reexecução com history:false e remoto maior é barrada; sem a frase exata nada é enviado nem aprovado", async () => {
  const c = await cenario();
  const cfg = JSON.parse(await readFile(c.paths.config, "utf8"));
  cfg.history = false;
  await writeFile(c.paths.config, JSON.stringify(cfg));
  const r = await assistente(c, [[/Gravar a configuração/, "s"], [/Enviar estes arquivos/, "s"], [/digite exatamente/, "sim, publique"]]);
  assert.match(r.texto, /ATENÇÃO: PERDA DE HISTÓRICO/);
  assert.match(r.texto, /Cancelado: a perda de histórico não foi confirmada/);
  assert.ok(r.prompts.some((p) => p.includes(FRASE)), "o próprio publish pede a frase exata");
  const src = await readFile(new URL("../src/setup.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /aceitaPerda|accept-history-loss/, "o assistente nunca passa a opção que contorna a guarda");
  assert.equal(diasRemoto(c.remoto), 3, "nada foi enviado");
  assert.equal(JSON.parse(await readFile(c.paths.config, "utf8")).history, false, "a chave history foi preservada");
  assert.match(r.texto, /DESLIGADO/);
});

test("assistente + guarda: com a frase exata o fluxo NORMAL do publish envia, e o history.json não encolhe", async () => {
  const c = await cenario();
  const cfg = JSON.parse(await readFile(c.paths.config, "utf8"));
  cfg.history = false;
  await writeFile(c.paths.config, JSON.stringify(cfg));
  const r = await assistente(c, [[/Gravar a configuração/, "s"], [/Enviar estes arquivos/, "s"], [/digite exatamente/, FRASE]]);
  assert.match(r.texto, /Enviado para/);
  assert.equal(diasRemoto(c.remoto), 1);
  assert.equal(JSON.parse(await readFile(c.paths.historico, "utf8")).timeline.points.length, 3);
});

test("assistente com histórico ligado: o histórico é preservado, a frase sobre history reset aparece e nada é barrado", async () => {
  const c = await cenario();
  const r = await assistente(c, [[/Gravar a configuração/, "s"], [/Enviar estes arquivos/, "s"]]);
  assert.match(r.texto, /histórico é preservado/);
  assert.match(r.texto, /history reset/);
  assert.doesNotMatch(r.texto, /PERDA DE HISTÓRICO/);
  assert.equal(diasRemoto(c.remoto), 3, "a mescla manteve os 3 dias");
});

test("restore do assistente com history.json existente não encolhe (mescla pelo máximo e mostra a comparação)", async () => {
  const c = await cenario();
  // o remoto fica MENOR que o histórico local: publica 1 dia com perda aceita (history.json local continua com 3)
  const tty = { isTTY: true, async ask() { return "s"; } };
  await main(["export", "--no-history", ...c.base], () => {}, tty);
  await main(["publish", "--yes", "--accept-history-loss", ...c.base], () => {}, tty);
  assert.equal(diasRemoto(c.remoto), 1);
  const antes = JSON.parse(await readFile(c.paths.historico, "utf8")).timeline.points.length;
  assert.equal(antes, 3);
  const r = await assistente(c, [[/computador novo/, "s"], [/restore depois do resumo/, "s"], [/Gravar a configuração/, "s"], [/Enviar estes arquivos/, "n"]]);
  assert.match(r.texto, /Já existe um histórico local: o restore nunca o reduz/);
  assert.match(r.texto, /Comparação \(o restaurado nunca reduz o local/);
  assert.equal(JSON.parse(await readFile(c.paths.historico, "utf8")).timeline.points.length, 3);
});
