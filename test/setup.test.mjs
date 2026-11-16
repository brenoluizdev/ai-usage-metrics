// Assistente `setup`: tudo com entrada SIMULADA e funções externas (gh, API, npm, schtasks, navegador) FALSAS. Sem rede, sem dados reais.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { main } from "../src/cli.mjs";
import { caminhos, lerConfig, lerEstado, normalizarConfig } from "../src/config.mjs";
import { SetupCancelado, emailNoreply, montarConfig, normalizarHorario, PALETAS, trechoMarkdown } from "../src/setup.mjs";
import { claudeFalso, homeFalsa } from "./fixtures.mjs";

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(tmpdir(), "ai-usage-metrics-sem-config-setup"),
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
const tmp = async (prefixo = "ai-usage-metrics-setup-") => {
  const d = await mkdtemp(join(tmpdir(), prefixo));
  pastas.push(d);
  return d;
};

/** Ambiente sintético: home com uma sessão do Claude Code (projeto "projeto-alfa") e pasta de estado vazia. */
async function ambiente() {
  const home = await homeFalsa();
  await claudeFalso(home);
  const estado = await tmp();
  return { home, estado, config: join(estado, "config.json"), paths: caminhos(estado) };
}

/** Externos falsos: registram as chamadas; o que não foi configurado FALHA (nenhuma ação externa inesperada). */
function externosFalsos(respostas = {}) {
  const chamadas = [];
  const base = ["ghUsuario", "ghRepo", "ghCriarRepo", "apiUsuario", "apiRepo", "npmInstalar", "tarefaExiste", "criarTarefa", "abrir"];
  const ext = {};
  for (const nome of base) {
    ext[nome] = async (...a) => {
      chamadas.push([nome, ...a]);
      if (!(nome in respostas)) assert.fail(`chamada externa inesperada: ${nome}`);
      const r = respostas[nome];
      return typeof r === "function" ? r(...a) : r;
    };
  }
  return { ext, chamadas };
}

/**
 * Roda `setup` com respostas por REGRA: [regex do prompt, resposta | lista de respostas usadas em ordem]. Sem regra: Enter.
 * `eof`: lança SetupCancelado ao chegar neste regex.
 */
async function rodar({ amb, argv = [], regras = [], ext = {}, ambiente: ambOpc = {}, tty = true, eof = null }) {
  const saidas = [];
  const prompts = [];
  const filas = regras.map(([re, r]) => [re, Array.isArray(r) ? [...r] : r]);
  const io = {
    isTTY: tty,
    externos: ext,
    ambiente: { plataforma: "win32", node: "C:\\node\\node.exe", bin: "C:\\pacote\\bin\\ai-usage-metrics.mjs", cores: false, versao: "0.2.0", temp: tmpdir(), limiteTr: 5000, ...ambOpc },
    async ask(p) {
      prompts.push(p);
      if (eof && eof.test(p)) throw new SetupCancelado("entrada encerrada");
      for (const f of filas) {
        if (!f[0].test(p)) continue;
        if (Array.isArray(f[1])) return f[1].length ? f[1].shift() : "";
        return f[1];
      }
      return "";
    },
  };
  await main(["setup", "--state-dir", amb.estado, "--home", amb.home, ...argv], (l) => saidas.push(String(l)), io);
  return { saidas, texto: saidas.join("\n"), prompts };
}

const GH_OK = { estado: "ok", login: "usuario-teste", id: 424242 };
const FELIZ = [
  [/gh api user/, "s"],
  [/gh repo view/, "s"],
  [/gh repo create/, "s"],
  [/Quais podem aparecer/, "1"],
  [/Escolha/, ["2", "2"]], // model-2, Dracula
  [/Idioma/, "pt-BR"],
  [/Título/, "Meu uso de IA"],
  [/Horário/, "09:30"],
  [/autoPublish\?/, "s"],
  [/Criar a tarefa diária/, "s"],
  [/Gravar a configuração/, "s"],
];
const extFeliz = () =>
  externosFalsos({
    ghUsuario: GH_OK,
    ghRepo: { estado: "inexistente" },
    ghCriarRepo: { ok: true },
    tarefaExiste: false,
    criarTarefa: { ok: true },
  });
const CHAMADAS_EXTERNAS = (c) => c.map((x) => x[0]);

test("sem terminal e com --non-interactive: não faz nada e orienta o init", async () => {
  const amb = await ambiente();
  const { ext, chamadas } = externosFalsos();
  for (const [tty, argv] of [[false, []], [true, ["--non-interactive"]]]) {
    const r = await rodar({ amb, ext, tty, argv });
    assert.match(r.texto, /só funciona num terminal interativo/);
    assert.match(r.texto, /init/);
    assert.equal(r.prompts.length, 0);
  }
  assert.equal(chamadas.length, 0);
  assert.equal(existsSync(amb.config), false);
});

test("fluxo feliz com gh simulado: grava a config válida, executa as ações marcadas e comanda a tarefa exata", async () => {
  const amb = await ambiente();
  const { ext, chamadas } = extFeliz();
  const r = await rodar({ amb, ext, regras: FELIZ, argv: [] });
  assert.deepEqual(CHAMADAS_EXTERNAS(chamadas), ["ghUsuario", "ghRepo", "tarefaExiste", "ghCriarRepo", "tarefaExiste", "criarTarefa"]);
  assert.deepEqual(chamadas.find((c) => c[0] === "ghCriarRepo").slice(1), ["usuario-teste", "ai-metrics"]);
  const cfg = await lerConfig(amb.config);
  assert.equal(cfg.githubUser, "usuario-teste");
  assert.equal(cfg.commitName, "usuario-teste");
  assert.equal(cfg.commitEmail, "424242+usuario-teste@users.noreply.github.com");
  assert.equal(cfg.model, "model-2");
  assert.equal(cfg.lang, "pt-BR");
  assert.equal(cfg.title, "Meu uso de IA");
  assert.equal(cfg.autoPublish, true);
  assert.deepEqual(cfg.publicProjects, { "projeto-alfa": "projeto-alfa" });
  assert.equal(cfg.colorsDark.background, "#282a36");
  assert.ok(normalizarConfig(JSON.parse(await readFile(amb.config, "utf8"))));
  // tarefa: comando exato, argumentos citados, horário validado
  const t = chamadas.find((c) => c[0] === "criarTarefa")[1];
  assert.equal(t.nome, "ai-usage-metrics");
  assert.equal(t.horario, "09:30");
  assert.equal(t.substituir, false);
  assert.equal(t.tr, `"C:\\node\\node.exe" "C:\\pacote\\bin\\ai-usage-metrics.mjs" "run" "--non-interactive" "--state-dir" "${amb.estado}" "--home" "${amb.home}"`);
  // prévias locais com os dados reais (sintéticos aqui) e dica de largura
  for (const m of ["model-1", "model-2", "model-3"]) assert.ok(existsSync(join(amb.paths.saida, "preview", `metrics.${m}.svg`)));
  assert.match(r.texto, /width="420"/);
  assert.match(r.texto, /Nada foi publicado/); // a pergunta de publicar ficou em "n" (padrão)
  assert.equal((await lerEstado(amb.paths.estado)).manualPublishConfirmed, false);
  // nenhuma saída contém token/segredo
  assert.doesNotMatch(r.texto, /ghp_|github_pat_|GH_TOKEN|GITHUB_TOKEN|Authorization/i);
});

test("a config do assistente equivale à do init com os mesmos valores", async () => {
  const d = { githubUser: "usuario-teste", dataRepo: "ai-metrics", publicProjects: {}, theme: "auto", lang: "en", autoPublish: false, model: "model-2" };
  const doSetup = montarConfig(d, null);
  const base = await tmp();
  await main(["init", "--user", "usuario-teste", "--model", "model-2", "--state-dir", base], () => {}, { isTTY: false, ask: async () => "" });
  const doInit = JSON.parse(await readFile(join(base, "config.json"), "utf8"));
  assert.deepEqual(doSetup, doInit);
});

test("cada confirmação respondida com N: nenhuma ação externa e nada gravado", async () => {
  const amb = await ambiente();
  const { ext, chamadas } = externosFalsos();
  const r = await rodar({ amb, ext, regras: [[/Seu usuário/, "usuario-teste"], [/Gravar a configuração/, "n"]], argv: [] });
  assert.equal(chamadas.length, 0, "recusar tudo não executa nada externo");
  assert.equal(existsSync(amb.config), false);
  assert.equal(existsSync(amb.paths.estado), false);
  assert.match(r.texto, /Nada foi gravado nem executado/);
  assert.ok(r.prompts.some((p) => /gh api user/.test(p) && /\[s\/N\]/.test(p)));
  assert.ok(r.prompts.some((p) => /api\.github\.com\/users\/usuario-teste/.test(p) && /\[s\/N\]/.test(p)));
});

test("recusar o resumo final depois de aceitar as ações: nada executado nem gravado", async () => {
  const amb = await ambiente();
  const { ext, chamadas } = externosFalsos({ ghUsuario: GH_OK, ghRepo: { estado: "inexistente" }, tarefaExiste: false });
  await rodar({ amb, ext, regras: FELIZ.map(([re, r]) => (/Gravar a configuração/.test(re.source) ? [re, "n"] : [re, r])) });
  assert.deepEqual(CHAMADAS_EXTERNAS(chamadas), ["ghUsuario", "ghRepo", "tarefaExiste"]); // só consultas consentidas; nada de criar repo/tarefa
  assert.equal(existsSync(amb.config), false);
});

test("sem gh: ID pela API simulada, repositório pela API, passo manual", async () => {
  const amb = await ambiente();
  const { ext, chamadas } = externosFalsos({ apiUsuario: { estado: "ok", login: "Fulana-Teste", id: 777 }, apiRepo: { estado: "inexistente" } });
  const r = await rodar({
    amb,
    ext,
    ambiente: { plataforma: "linux" },
    regras: [[/Seu usuário/, "fulana-teste"], [/api\.github\.com\/users/, "s"], [/api\.github\.com\/repos/, "s"], [/Você já criou/, "s"], [/Gravar a configuração/, "s"]],
  });
  assert.deepEqual(CHAMADAS_EXTERNAS(chamadas), ["apiUsuario", "apiRepo"]);
  const cfg = await lerConfig(amb.config);
  assert.equal(cfg.githubUser, "Fulana-Teste"); // login canônico devolvido pela API
  assert.equal(cfg.commitEmail, "777+Fulana-Teste@users.noreply.github.com");
  assert.match(r.texto, /github\.com\/new/);
  assert.match(r.texto, /NÃO cria o agendamento|cron/);
});

test("sem gh e consulta recusada: ID manual inteiro positivo; sem ID só com aviso e sem commitEmail", async () => {
  const amb = await ambiente();
  const a = await rodar({ amb, ext: externosFalsos().ext, regras: [[/Seu usuário/, "usuario-teste"], [/ID numérico/, ["abc", "-5", "0", "123"]], [/Gravar a configuração/, "s"]] });
  assert.match(a.texto, /O ID deve ser um número inteiro positivo/);
  assert.equal((await lerConfig(amb.config)).commitEmail, "123+usuario-teste@users.noreply.github.com");
  const amb2 = await ambiente();
  const b = await rodar({ amb: amb2, ext: externosFalsos().ext, regras: [[/Seu usuário/, "usuario-teste"], [/Gravar a configuração/, "s"]] });
  assert.match(b.texto, /sem o ID, em contas novas/);
  const cfg = await lerConfig(amb2.config);
  assert.equal(cfg.commitEmail, undefined);
  assert.equal(cfg.commitName, undefined);
});

test("entradas hostis são recusadas sem ecoar o texto e sem gravar nada", async () => {
  const amb = await ambiente();
  const { ext } = externosFalsos();
  const hostis = ["../../x", "a b", "-x", "x;rm -rf /", "x\u001b[31m", "a".repeat(80), "x$(whoami)", "x&y"];
  for (const h of hostis) {
    const r = await rodar({ amb, ext, regras: [[/Seu usuário/, h]], argv: [] }).catch((e) => ({ erro: e }));
    assert.match(r.texto ?? "", /Usuário inválido/);
    assert.doesNotMatch(r.texto ?? "", /rm -rf|whoami|\u001b/);
    assert.match(r.texto, /Assistente encerrado/); // 3 respostas inválidas: sai limpo
  }
  assert.equal(existsSync(amb.config), false);
  // resposta gigante
  const g = await rodar({ amb, ext, regras: [[/Seu usuário/, "x".repeat(100_000)]] });
  assert.match(g.texto, /Resposta longa demais/);
  assert.equal(existsSync(amb.config), false);
});

test("repositório, alias, cores, horário, título e números hostis são recusados sem ecoar e sem gravar", async () => {
  const caso = async (prompt, hostis, esperado, antes = []) => {
    for (const h of hostis) {
      const amb = await ambiente();
      const { ext } = externosFalsos({ ghUsuario: GH_OK, ghRepo: { estado: "existe", privado: false }, tarefaExiste: false, criarTarefa: { ok: true } });
      const r = await rodar({ amb, ext, regras: [[/gh api user/, "s"], [/gh repo view/, "s"], ...antes, [prompt, h]] });
      assert.match(r.texto, esperado, `prompt ${prompt} com ${JSON.stringify(h).slice(0, 30)}`);
      assert.match(r.texto, /Assistente encerrado/);
      assert.doesNotMatch(r.texto, /\u001b|\.\.\/x|C:\\Users\\fulano/);
      assert.equal(existsSync(amb.config), false);
    }
  };
  await caso(/Nome do repositório/, ["../x", "a/b", "x;y", ".", "x.git", "a".repeat(101), "a b", "x\u001b[31m"], /Nome inválido/);
  await caso(/Quais podem aparecer/, ["99", "0", "abc", "1,,2", "1;2", "-1"], /Os números vão de 1 a|Use números/);
  await caso(/Nome público para/, ["C:\\Users\\fulano", "a@b.com", "dados.json", "\u001b[31mx", "x".repeat(61), "a/b"], /inválido|igual/i, [[/Quais podem aparecer/, "1"]]);
  await caso(/Horário/, ["25:00", "12:60", "9h", "12", "12:5", "-1:00"], /Horário inválido/);
  await caso(/Título/, ["a".repeat(61), "C:\\Users\\x", "dev@mail.com", "dados.json"], /title|texto|recusado|caracteres/i, [[/Escolha/, ["1", "1"]], [/Idioma/, "en"]]);
  await caso(/Escolha/, ["0", "9", "x", "1;2", "-1"], /Digite um número de 1 a/);
  await caso(/destaque/, ["red", "url(x)", "#abc;", "#12345", "rgb(1,2,3)", "#ggg"], /inválida/i, [[/Escolha/, ["1", "5"]]]);
  await caso(/Idioma/, ["fr", "pt", "EN"], /Use en ou pt-BR/, [[/Escolha/, ["1", "1"]]]);
});

test("saída do gh e da API malformada ou hostil nunca é aceita nem exibida", async () => {
  const { parsearUsuario, parsearRepo, limparTexto } = await import("../src/ambiente.mjs");
  assert.equal(parsearUsuario("não é json"), null);
  assert.equal(parsearUsuario(JSON.stringify({ login: "ok", id: "12" })), null);
  assert.equal(parsearUsuario(JSON.stringify({ login: "ok", id: -1 })), null);
  assert.equal(parsearUsuario(JSON.stringify({ login: "ok", id: 1.5 })), null);
  assert.equal(parsearUsuario(JSON.stringify({ login: "ok\u001b[31m", id: 1 })), null);
  assert.equal(parsearUsuario(JSON.stringify({ login: "../x", id: 1 })), null);
  assert.equal(parsearUsuario(JSON.stringify({ login: "outro", id: 1 }), "esperado"), null);
  assert.deepEqual(parsearUsuario(JSON.stringify({ login: "Ok-1", id: 5, extra: 1 }), "ok-1"), { login: "Ok-1", id: 5 });
  assert.equal(parsearUsuario("x".repeat(300_000)), null);
  assert.equal(parsearUsuario("[]"), null);
  assert.equal(parsearRepo(JSON.stringify({ name: "ai-metrics", isPrivate: "sim" }), "ai-metrics"), null);
  assert.equal(parsearRepo(JSON.stringify({ name: "outro", private: false }), "ai-metrics"), null);
  assert.deepEqual(parsearRepo(JSON.stringify({ name: "AI-Metrics", private: true }), "ai-metrics"), { nome: "AI-Metrics", privado: true });
  assert.equal(limparTexto("a\u001b]0;título\u0007b\u001b[31mc\u0000d\n\te"), "abc d e");
  // fluxo: gh devolvendo lixo
  const amb = await ambiente();
  const { ext } = externosFalsos({ ghUsuario: { estado: "erro" } });
  const r = await rodar({ amb, ext, regras: [[/gh api user/, "s"], [/Seu usuário/, "usuario-teste"], [/Gravar a configuração/, "n"]] });
  assert.match(r.texto, /não pôde ser usada/);
});

test("repositório privado avisa que a imagem não aparece no README", async () => {
  const amb = await ambiente();
  const { ext } = externosFalsos({ ghUsuario: GH_OK, ghRepo: { estado: "existe", privado: true } });
  const r = await rodar({ amb, ext, ambiente: { plataforma: "linux" }, regras: [[/gh api user/, "s"], [/gh repo view/, "s"], [/Gravar a configuração/, "n"]] });
  assert.match(r.texto, /PRIVADO: a imagem não aparecerá no README/);
});

test("restore simulado só depois do resumo e com a sua própria confirmação", async () => {
  const amb = await ambiente();
  const { ext, chamadas } = externosFalsos({ ghUsuario: GH_OK, ghRepo: { estado: "existe", privado: false } });
  const regras = [[/gh api user/, "s"], [/gh repo view/, "s"], [/computador novo/, "s"], [/restore depois do resumo/, "s"], [/Gravar a configuração/, "s"]];
  // sem rede real: a restauração falha (remoto inexistente) e o assistente segue com aviso; o importante é que ela foi tentada só após gravar
  const r = await rodar({ amb, ext, ambiente: { plataforma: "linux" }, regras });
  assert.match(r.texto, /restore|Nada para restaurar|Histórico restaurado/);
  assert.ok(existsSync(amb.config));
  assert.equal(CHAMADAS_EXTERNAS(chamadas).includes("npmInstalar"), false);
});

test("caminho do npx: oferece a cópia fixa, instala (simulado) e agenda a partir dela; recusar não cria a tarefa", async () => {
  const { instalacaoInstavel, binDoRuntime } = await import("../src/ambiente.mjs");
  assert.equal(instalacaoInstavel("C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\abc123\\node_modules\\ai-usage-metrics\\bin\\a.mjs"), true);
  assert.equal(instalacaoInstavel("/home/x/.npm/_npx/9f/node_modules/ai-usage-metrics/bin/a.mjs"), true);
  assert.equal(instalacaoInstavel("C:\\Users\\x\\AppData\\Local\\pnpm\\dlx\\abc\\a.mjs"), true);
  assert.equal(instalacaoInstavel(join(tmpdir(), "qualquer", "a.mjs")), true);
  assert.equal(instalacaoInstavel("C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\ai-usage-metrics\\bin\\a.mjs"), false);
  const bin_npx = "C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\abc123\\node_modules\\ai-usage-metrics\\bin\\a.mjs";
  const amb = await ambiente();
  const fixo = binDoRuntime(amb.home);
  const { ext, chamadas } = externosFalsos({ npmInstalar: { ok: true, bin: fixo }, tarefaExiste: false, criarTarefa: { ok: true } });
  const regras = [[/Seu usuário/, "usuario-teste"], [/cópia fixa/, "s"], [/Criar a tarefa diária/, "s"], [/Gravar a configuração/, "s"]];
  await rodar({ amb, ext, regras, ambiente: { bin: bin_npx, limiteTr: 5000 } });
  const inst = chamadas.find((c) => c[0] === "npmInstalar")[1];
  assert.equal(inst.versao, "0.2.0");
  assert.equal(inst.prefixo, join(amb.home, ".ai-usage-metrics-runtime"));
  assert.ok(chamadas.find((c) => c[0] === "criarTarefa")[1].tr.includes(`"${fixo}"`));
  assert.ok(!chamadas.find((c) => c[0] === "criarTarefa")[1].tr.includes("_npx"));
  // recusa a cópia fixa: nenhuma tarefa, nenhum npm
  const amb2 = await ambiente();
  const f = externosFalsos();
  const r = await rodar({ amb: amb2, ext: f.ext, regras: [[/Seu usuário/, "usuario-teste"], [/Gravar a configuração/, "s"]], ambiente: { bin: bin_npx, limiteTr: 5000 } });
  assert.equal(f.chamadas.length, 0);
  assert.match(r.texto, /a tarefa não será criada/);
  // instalação que falha: a tarefa NÃO é criada
  const amb3 = await ambiente();
  const g = externosFalsos({ npmInstalar: { ok: false, motivo: "falhou" }, tarefaExiste: false });
  const r3 = await rodar({ amb: amb3, ext: g.ext, regras, ambiente: { bin: bin_npx, limiteTr: 5000 } });
  assert.equal(CHAMADAS_EXTERNAS(g.chamadas).includes("criarTarefa"), false);
  assert.match(r3.texto, /NÃO foi criada/);
});

test("tarefa já existente: pergunta, reconfirma e usa /F; recusar mantém a existente", async () => {
  const amb = await ambiente();
  const { ext, chamadas } = externosFalsos({ tarefaExiste: true, criarTarefa: { ok: true } });
  const regras = [[/Seu usuário/, "usuario-teste"], [/Criar a tarefa diária/, "s"], [/Substituir a tarefa/, "s"], [/Reconfirmando/, "s"], [/Gravar a configuração/, "s"]];
  const r = await rodar({ amb, ext, regras });
  assert.match(r.texto, /SUBSTITUIR a tarefa/);
  assert.equal(chamadas.find((c) => c[0] === "criarTarefa")[1].substituir, true);
  const amb2 = await ambiente();
  const f = externosFalsos({ tarefaExiste: true });
  await rodar({ amb: amb2, ext: f.ext, regras: [[/Seu usuário/, "usuario-teste"], [/Criar a tarefa diária/, "s"], [/Gravar a configuração/, "s"]] }); // substituir = N
  assert.equal(CHAMADAS_EXTERNAS(f.chamadas).includes("criarTarefa"), false);
  const amb3 = await ambiente();
  const h = externosFalsos({ tarefaExiste: true });
  await rodar({ amb: amb3, ext: h.ext, regras: [[/Seu usuário/, "usuario-teste"], [/Criar a tarefa diária/, "s"], [/Substituir a tarefa/, "s"], [/Gravar a configuração/, "s"]] }); // reconfirmação = N
  assert.equal(CHAMADAS_EXTERNAS(h.chamadas).includes("criarTarefa"), false);
});

test("reexecução: padrões vêm do config atual, backup .bak e opção 'só modelo/cores' preserva o resto", async () => {
  const amb = await ambiente();
  await writeFile(amb.config, JSON.stringify({ githubUser: "usuario-teste", dataRepo: "meus-dados", publicProjects: { "projeto-alfa": "Alfa" }, model: "model-3", lang: "pt-BR", theme: "dark", title: "Painel", commitEmail: "99+usuario-teste@users.noreply.github.com", history: false, autoPublish: false }, null, 2));
  const { ext } = externosFalsos({ tarefaExiste: false });
  // opção 2: só modelo e cores (Enter mantém o modelo atual; "Manter as cores atuais" não existe sem cores)
  await rodar({ amb, ext, ambiente: { plataforma: "linux" }, regras: [[/Escolha/, ["2", "", "3"]], [/Gravar a configuração/, "s"]] });
  const cfg = JSON.parse(await readFile(amb.config, "utf8"));
  assert.equal(cfg.model, "model-3");
  assert.equal(cfg.dataRepo, "meus-dados");
  assert.equal(cfg.history, false);
  assert.deepEqual(cfg.publicProjects, { "projeto-alfa": "Alfa" });
  assert.equal(cfg.commitEmail, "99+usuario-teste@users.noreply.github.com");
  assert.equal(cfg.colorsDark.background, "#2e3440"); // Nord
  const bak = JSON.parse(await readFile(`${amb.config}.bak`, "utf8"));
  assert.equal(bak.colorsDark, undefined);
  // reexecução completa: Enter em tudo mantém os valores; o nome do repositório vem como padrão
  const amb2 = await ambiente();
  await writeFile(amb2.config, JSON.stringify({ githubUser: "usuario-teste", dataRepo: "meus-dados", publicProjects: { "projeto-alfa": "Alfa" }, model: "model-3", lang: "pt-BR", title: "Painel" }, null, 2));
  const f = externosFalsos();
  const r = await rodar({ amb: amb2, ext: f.ext, ambiente: { plataforma: "linux" }, regras: [[/Seu usuário/, ""], [/Gravar a configuração/, "s"]] });
  assert.ok(r.prompts.some((p) => /Seu usuário do GitHub \[usuario-teste\]/.test(p)));
  assert.ok(r.prompts.some((p) => /Nome do repositório de dados \[meus-dados\]/.test(p)));
  const c2 = await lerConfig(amb2.config);
  assert.equal(c2.dataRepo, "meus-dados");
  assert.equal(c2.title, "Painel");
  assert.equal(c2.model, "model-3");
  assert.deepEqual(c2.publicProjects, { "projeto-alfa": "Alfa" });
});

test("commitEmail personalizado do config atual nunca é substituído pelo assistente", async () => {
  const amb = await ambiente();
  await writeFile(amb.config, JSON.stringify({ githubUser: "usuario-teste", commitName: "Fulano", commitEmail: "fulano@exemplo.invalid" }, null, 2));
  const r = await rodar({ amb, ext: externosFalsos().ext, ambiente: { plataforma: "linux" }, regras: [[/Seu usuário/, ""], [/Gravar a configuração/, "s"]] });
  assert.match(r.texto, /Mantido o commitEmail personalizado/);
  assert.equal((await lerConfig(amb.config)).commitEmail, "fulano@exemplo.invalid");
});

test("Ctrl+C / fim da entrada no meio: sai limpo e nada é gravado", async () => {
  const amb = await ambiente();
  for (const re of [/Usar esta conta/, /Nome do repositório/, /Quais podem aparecer/, /Escolha/, /Gravar a configuração/]) {
    const { ext } = externosFalsos({ ghUsuario: GH_OK, ghRepo: { estado: "existe", privado: false } });
    const r = await rodar({ amb, ext, eof: re, regras: [[/gh api user/, "s"], [/gh repo view/, "s"], [/Quais podem aparecer/, "1"]] });
    assert.match(r.texto, /Assistente encerrado/);
    assert.equal(existsSync(amb.config), false, `config não pode existir após EOF em ${re}`);
    assert.equal(existsSync(amb.paths.estado), false);
    assert.equal(existsSync(join(amb.estado, ".lock")), false);
  }
});

test("o publish final é o manual: pergunta, publica num remoto bare local e registra a aprovação do envio automático", async () => {
  const amb = await ambiente();
  const raiz = await tmp("ai-usage-metrics-setup-bare-");
  const bare = join(raiz, "dados.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare], { env: process.env });
  await writeFile(amb.config, JSON.stringify({ githubUser: "usuario-teste", remoteUrl: bare, publicProjects: { "projeto-alfa": "Alfa" } }, null, 2));
  const { ext, chamadas } = externosFalsos();
  const r = await rodar({ amb, ext, ambiente: { plataforma: "linux" }, regras: [[/Seu usuário/, ""], [/Gravar a configuração/, "s"], [/Enviar estes arquivos/, "s"]] });
  assert.match(r.texto, /Enviado para/);
  assert.equal(chamadas.length, 0);
  const estado = await lerEstado(amb.paths.estado);
  assert.equal(estado.manualPublishConfirmed, true);
  assert.deepEqual(estado.approvedPublicNames, ["Alfa"]);
  const log = execFileSync("git", [`--git-dir=${bare}`, "log", "--format=%s", "main"], { encoding: "utf8", env: process.env }).trim();
  assert.match(log, /update AI usage metrics/);
  // sem lixo temporário do assistente
  assert.deepEqual((await readdir(dirname(amb.config))).filter((n) => n.includes(".tmp-")), []);
});

test("recusar o publish final explica como aprovar depois e não envia", async () => {
  const amb = await ambiente();
  const bare = join(await tmp("ai-usage-metrics-setup-bare-"), "d.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare], { env: process.env });
  await writeFile(amb.config, JSON.stringify({ githubUser: "usuario-teste", remoteUrl: bare }, null, 2));
  const r = await rodar({ amb, ext: externosFalsos().ext, ambiente: { plataforma: "linux" }, regras: [[/Seu usuário/, ""], [/Gravar a configuração/, "s"], [/Enviar estes arquivos/, "n"]] });
  assert.match(r.texto, /Cancelado: nada foi enviado/);
  assert.match(r.texto, /publish` neste terminal/);
  assert.equal((await lerEstado(amb.paths.estado)).manualPublishConfirmed, false);
});

test("validação do módulo: horário, paletas, e-mail noreply e Markdown", () => {
  assert.equal(normalizarHorario("9:05"), "09:05");
  assert.equal(normalizarHorario("23:59"), "23:59");
  for (const h of ["24:00", "12:60", "1200", "12:0", "-1:00", "12:00:00", "12:00\n", ""]) assert.equal(normalizarHorario(h), null, h);
  assert.equal(emailNoreply("fulano", 5), "5+fulano@users.noreply.github.com");
  assert.equal(emailNoreply("fulano", null), "fulano@users.noreply.github.com");
  assert.equal(PALETAS.length, 4);
  assert.match(trechoMarkdown("https://x/y.svg", "model-2"), /width="420"/);
  assert.equal(trechoMarkdown("https://x/y.svg", "model-1"), "![AI usage](https://x/y.svg)");
});
