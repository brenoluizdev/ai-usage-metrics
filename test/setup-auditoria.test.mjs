// Correções da auditoria do assistente: Ctrl+C durante ação externa, instalação instável (8.3/bunx/Node), apiGet (prazo total, caminho),
// ESC/C1 em commitEmail/commitName, cópias .bak numeradas, reconfirmação antes do lock, "tarefa atual", npm com --registry.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, symlinkSync, utimesSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { apiGet, caminhoApiValido, executar, externosPadrao, instalacaoInstavel, nodeInstavel } from "../src/ambiente.mjs";
import { main } from "../src/cli.mjs";
import { caminhos, normalizarConfig } from "../src/config.mjs";
import { descreverPlano } from "../src/publish.mjs";
import { SetupCancelado, copiaDeSeguranca } from "../src/setup.mjs";
import { limparTexto } from "../src/texto.mjs";
import { claudeFalso, homeFalsa } from "./fixtures.mjs";

const pastas = [];
after(async () => {
  for (const p of pastas) await rm(p, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "ai-usage-aud-"));
  pastas.push(d);
  return d;
};
async function amb() {
  const home = await homeFalsa();
  await claudeFalso(home);
  const estado = await tmp();
  return { home, estado, config: join(estado, "config.json"), paths: caminhos(estado) };
}
const NPX = "C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\abc123\\node_modules\\ai-usage-metrics\\bin\\a.mjs";

/** Mesmo esquema do setup.test: respostas por regra, externos falsos (o que não foi configurado falha). */
async function rodar({ a, ext, regras = [], ambiente = {}, durante, holder = {} }) {
  const saidas = [];
  const prompts = [];
  let cancelar = () => {};
  const io = {
    isTTY: true,
    externos: ext,
    registrarCancelamento: (fn) => (cancelar = fn),
    ambiente: { plataforma: "win32", node: "C:\\node\\node.exe", bin: "C:\\pacote\\bin\\ai-usage-metrics.mjs", cores: false, versao: "0.2.0", temp: tmpdir(), limiteTr: 5000, ...ambiente },
    async ask(p) {
      prompts.push(p);
      await durante?.(p);
      for (const [re, r] of regras) if (re.test(p)) return r;
      return "";
    },
  };
  io.cancelar = () => cancelar();
  holder.io = io;
  await main(["setup", "--state-dir", a.estado, "--home", a.home], (l) => saidas.push(String(l)), io);
  return { texto: saidas.join("\n"), prompts, io };
}
const falsos = (respostas) => {
  const chamadas = [];
  const ext = {};
  for (const n of ["ghUsuario", "ghRepo", "ghCriarRepo", "apiUsuario", "apiRepo", "npmInstalar", "tarefaExiste", "tarefaAtual", "criarTarefa", "abrir"]) {
    ext[n] = async (...x) => {
      chamadas.push([n, ...x]);
      if (!(n in respostas)) assert.fail(`chamada externa inesperada: ${n}`);
      return typeof respostas[n] === "function" ? respostas[n](...x) : respostas[n];
    };
  }
  return { ext, chamadas };
};
const REGRAS_NPX = [[/Seu usuário/, "usuario-teste"], [/cópia fixa/, "s"], [/Criar a tarefa diária/, "s"], [/Gravar a configuração/, "s"]];

test("M1: a confirmação do npm install explica execução diária, .npmrc, integridade e pasta alterável; mostra a versão e usa --registry", async () => {
  const a = await amb();
  const { ext } = falsos({ npmInstalar: { ok: false, motivo: "x" }, tarefaExiste: false });
  const r = await rodar({ a, ext, regras: REGRAS_NPX, ambiente: { bin: NPX } });
  assert.match(r.texto, /TODO DIA pelo Agendador/);
  assert.match(r.texto, /~\/\.npmrc/);
  assert.match(r.texto, /integridade fixada/);
  assert.match(r.texto, /alterável por qualquer processo do seu usuário/);
  assert.match(r.texto, /--registry https:\/\/registry\.npmjs\.org\//);
  assert.ok(r.prompts.some((p) => /cópia fixa \(ai-usage-metrics versão 0\.2\.0\)/.test(p) && /\[s\/N\]/.test(p)));
  // o argv real leva o registro explícito (e nada de NPM_TOKEN no ambiente do filho)
  const chamadas = [];
  const exec = (cmd, args, opts, cb) => (chamadas.push({ args, opts }), queueMicrotask(() => cb(null, "", "")), { stdin: { end() {} } });
  const antes = process.env.NPM_TOKEN;
  process.env.NPM_TOKEN = "segredo";
  try {
    await externosPadrao({ exec }).npmInstalar({ prefixo: join(a.home, "rt"), versao: "0.2.0" });
  } finally {
    if (antes === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = antes;
  }
  if (chamadas.length) {
    const i = chamadas[0].args.indexOf("--registry");
    assert.equal(chamadas[0].args[i + 1], "https://registry.npmjs.org/");
    assert.equal(chamadas[0].opts.env.NPM_TOKEN, undefined);
  }
});

test("M2: Ctrl+C durante o npm install aborta o filho, não cria a tarefa e diz o que foi e o que não foi feito", async () => {
  const a = await amb();
  let sinalVisto = null;
  const h = {};
  const { ext, chamadas } = falsos({
    tarefaExiste: false,
    npmInstalar: ({ signal }) => {
      sinalVisto = signal;
      return new Promise((res) => {
        signal.addEventListener("abort", () => res({ ok: false, cancelado: true, motivo: "cancelado" }), { once: true }); // "demora" até o cancelamento
        setTimeout(() => h.io.cancelar(), 20);
      });
    },
  });
  const r = await rodar({ a, ext, regras: REGRAS_NPX, ambiente: { bin: NPX }, holder: h }).catch((e) => ({ erro: e }));
  assert.equal(r.erro, undefined);
  assert.ok(sinalVisto?.aborted, "o AbortSignal chegou ao npm");
  assert.equal(chamadas.some((c) => c[0] === "criarTarefa"), false, "a ação seguinte NÃO executa");
  assert.match(r.texto, /Interrompido \(Ctrl\+C\)\. Já feito: gravar a configuração\./);
  assert.match(r.texto, /Interrompida durante: npm install da cópia fixa/);
  assert.match(r.texto, /NÃO executado: criar a tarefa agendada/);
  assert.match(r.texto, /JÁ tinha sido gravada/);
  assert.ok(existsSync(a.config), "a configuração foi gravada antes");
  assert.equal(existsSync(join(a.estado, ".lock")), false, "o lock foi liberado");
});

test("M2: Ctrl+C durante o gh repo create (demorado) aborta e não chega no restore nem na publicação", async () => {
  const a = await amb();
  let io0;
  const { ext, chamadas } = falsos({
    ghUsuario: { estado: "ok", login: "usuario-teste", id: 5 },
    ghRepo: { estado: "inexistente" },
    ghCriarRepo: (u, n, { signal }) => new Promise((res) => {
      signal.addEventListener("abort", () => res({ ok: false, cancelado: true, motivo: "cancelado" }), { once: true });
      setTimeout(() => io0.cancelar(), 20);
    }),
  });
  const saidas = [];
  const prompts = [];
  let cancelar = () => {};
  io0 = { cancelar: () => cancelar() };
  const io = {
    isTTY: true,
    externos: ext,
    registrarCancelamento: (fn) => (cancelar = fn),
    ambiente: { plataforma: "linux", cores: false, versao: "0.2.0" },
    async ask(p) {
      prompts.push(p);
      return /gh api user|gh repo view|gh repo create|Gravar a configuração/.test(p) ? "s" : "";
    },
  };
  await main(["setup", "--state-dir", a.estado, "--home", a.home], (l) => saidas.push(String(l)), io);
  const texto = saidas.join("\n");
  assert.match(texto, /Interrompido \(Ctrl\+C\)\. Já feito: gravar a configuração\./);
  assert.match(texto, /Interrompida durante: criar o repositório\. Ela pode ter sido parcialmente executada/);
  assert.equal(prompts.some((p) => /Enviar estes arquivos/.test(p)), false, "a publicação não começou");
  assert.deepEqual(chamadas.map((c) => c[0]), ["ghUsuario", "ghRepo", "ghCriarRepo"]);
});

test("M2: executar() repassa o signal ao filho e um filho real é encerrado ao cancelar", async () => {
  const visto = [];
  const exec = (cmd, args, opts, cb) => (visto.push(opts.signal), queueMicrotask(() => cb(null, "", "")), { stdin: { end() {} } });
  const c = new AbortController();
  await executar("x", [], { exec, signal: c.signal });
  assert.equal(visto[0], c.signal);
  const ctl = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ctl.abort(), 150);
  const r = await executar(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { signal: ctl.signal, timeout: 30_000 });
  assert.equal(r.ok, false);
  assert.equal(r.cancelado, true);
  assert.ok(Date.now() - t0 < 5000, "o filho foi encerrado logo");
});

test("M3: instalacaoInstavel compara realpath (8.3), cobre bunx e a pasta temporária; nodeInstavel avisa de gerenciadores", () => {
  const real = (p) => p.replace("RUNNER~1", "runneradmin").replace("PROGRA~1", "Program Files");
  // temp em grafia 8.3 e o binário na grafia longa (e o inverso)
  assert.equal(instalacaoInstavel("C:\\Users\\runneradmin\\AppData\\Local\\Temp\\x\\a.mjs", { temp: "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp", real }), true);
  assert.equal(instalacaoInstavel("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\x\\a.mjs", { temp: "C:\\Users\\runneradmin\\AppData\\Local\\Temp", real }), true);
  assert.equal(instalacaoInstavel("C:\\Users\\RUNNER~1\\AppData\\Roaming\\npm\\node_modules\\a\\a.mjs", { temp: "C:\\Users\\runneradmin\\AppData\\Local\\Temp", real }), false);
  assert.equal(instalacaoInstavel("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\bunx-123-ai-usage-metrics@latest\\node_modules\\a\\a.mjs", { temp: "D:\\outro", real }), true);
  assert.equal(instalacaoInstavel("/home/u/.bun/install/cache/x/a.mjs", { temp: "/tmp", real: (p) => p }), true);
  assert.equal(instalacaoInstavel("/usr/lib/node_modules/ai-usage-metrics/bin/a.mjs", { temp: "/tmp", real: (p) => p }), false);
  for (const n of [
    "C:\\Users\\x\\AppData\\Roaming\\nvm\\v22.1.0\\node.exe",
    "C:\\Users\\x\\AppData\\Local\\fnm_multishells\\1234_5\\node.exe",
    "C:\\Users\\x\\.volta\\tools\\image\\node\\22.1.0\\node.exe",
    "/home/u/.asdf/installs/nodejs/22.1.0/bin/node",
    "/opt/node-v22.1.0-linux-x64/bin/node",
  ]) assert.equal(nodeInstavel(n), true, n);
  for (const n of ["C:\\Program Files\\nodejs\\node.exe", "/usr/bin/node"]) assert.equal(nodeInstavel(n), false, n);
});

test("M3: o assistente avisa quando o Node em uso parece instável (e continua)", async () => {
  const a = await amb();
  const { ext } = falsos({ tarefaExiste: false, criarTarefa: { ok: true } });
  const r = await rodar({ a, ext, regras: [[/Seu usuário/, "usuario-teste"], [/Criar a tarefa diária/, "s"], [/Gravar a configuração/, "s"]], ambiente: { node: "C:\\Users\\x\\AppData\\Roaming\\nvm\\v22.1.0\\node.exe" } });
  assert.match(r.texto, /gerenciador de versões/);
  assert.match(r.texto, /Tarefa "ai-usage-metrics" criada/);
});

test("B1: apiGet tem prazo TOTAL (resposta que goteja é encerrada) e respeita o cancelamento", async () => {
  let destruida = 0;
  const gotejando = (opts, cb) => {
    const req = new EventEmitter();
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      cb(res);
      const t = setInterval(() => res.emit("data", Buffer.from("x")), 5); // nunca fica ocioso, nunca termina
      req.on("fim", () => clearInterval(t));
    };
    req.destroy = () => {
      destruida++;
      req.emit("fim");
    };
    return req;
  };
  const t0 = Date.now();
  const r = await apiGet("/users/usuario-teste", { request: gotejando, prazoTotal: 120, timeout: 10_000 });
  assert.deepEqual(r, { erro: "prazo total esgotado" });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(destruida, 1);
  const c = new AbortController();
  setTimeout(() => c.abort(), 30);
  assert.deepEqual(await apiGet("/users/usuario-teste", { request: gotejando, prazoTotal: 5000, signal: c.signal }), { erro: "cancelado" });
});

test("B2: apiGet valida usuário e repositório com as regras do assistente ('.', '..', .git, tamanhos)", async () => {
  for (const ok of ["/users/usuario-teste", "/repos/usuario-teste/ai-metrics", "/repos/u/a.b_c-d"]) assert.equal(caminhoApiValido(ok), true, ok);
  for (const ruim of ["/repos/u/..", "/repos/u/.", "/repos/../x", "/users/..", "/users/-x-", "/repos/u/x.git", "/repos/u/" + "a".repeat(101), "/users/" + "a".repeat(40), "/users/a/b", "users/a", "/repos/u", "/orgs/u"]) {
    assert.equal(caminhoApiValido(ruim), false, ruim);
    assert.deepEqual(await apiGet(ruim, { request: () => assert.fail("não deve chamar a rede") }), { erro: "caminho recusado" });
  }
});

test("B3: commitEmail com ESC e commitName com U+009B são recusados; a impressão do autor é sanitizada", () => {
  for (const email of ["a\u001b[31m@x.com", "a\u009b@x.com", "a\u0000@x.com", "a\n@x.com"]) assert.throws(() => normalizarConfig({ githubUser: "ab", commitEmail: email }), /commitEmail inválido/);
  for (const nome of ["x\u009by", "x\u001b[0m", "x\ny", "x\u007fy"]) assert.throws(() => normalizarConfig({ githubUser: "ab", commitName: nome }), /commitName inválido/);
  assert.ok(normalizarConfig({ githubUser: "ab", commitName: "Fulana de Tal", commitEmail: "1+ab@users.noreply.github.com" }));
  const plano = { remoto: "https://github.com/a/b.git", branch: "main", arquivos: [], cloneExiste: true, autor: { name: "x\u009b[31mNome\u001b]0;t\u0007", email: "a\u001b[2J@x.com", noreply: false }, json: { totals: { sessions: 1, userMessages: 1, activeDays: 1, projects: 1 } }, anterior: null, anonimizados: 0, publicos: [] };
  const txt = descreverPlano(plano);
  assert.doesNotMatch(txt, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  assert.match(txt, /autor do commit/);
  assert.equal(limparTexto("a\u009bb\u001b[31mc"), "a bc");
});

test("B4: config.json.bak nunca é sobrescrito: numera (.bak, .bak.1...), mantém só as 5 mais recentes e recusa symlink", async () => {
  const dir = await tmp();
  const cfg = join(dir, "config.json");
  const feitos = [];
  for (let i = 0; i < 8; i++) {
    await writeFile(cfg, JSON.stringify({ versao: i }));
    feitos.push(await copiaDeSeguranca(cfg));
    const t = new Date(Date.now() + i * 10_000); // mtime crescente e distinto
    utimesSync(feitos[i], t, t);
  }
  const nomes = (await readdir(dir)).filter((n) => n.startsWith("config.json.bak")).sort();
  assert.equal(nomes.length, 5);
  assert.deepEqual(feitos.map((p) => p.split(/[\\/]/).pop()).slice(0, 3), ["config.json.bak", "config.json.bak.1", "config.json.bak.2"]);
  const ultimos = await Promise.all(feitos.slice(3).map((p) => readFile(p, "utf8")));
  assert.deepEqual(ultimos.map((t) => JSON.parse(t).versao), [3, 4, 5, 6, 7]);
  assert.equal(existsSync(feitos[0]), false, "as mais antigas foram podadas");
  // symlink no destino da cópia: recusado (se o SO deixar criar o link)
  const dir2 = await tmp();
  await writeFile(join(dir2, "config.json"), "{}");
  await writeFile(join(dir2, "alvo.txt"), "importante");
  let linkou = true;
  try {
    symlinkSync(join(dir2, "alvo.txt"), join(dir2, "config.json.bak"));
  } catch {
    linkou = false;
  }
  if (linkou) {
    // um .bak que é link nunca é seguido nem sobrescrito: a cópia nova vai para outro nome e o alvo do link fica intacto
    const nova = await copiaDeSeguranca(join(dir2, "config.json"));
    assert.match(nova, /config\.json\.bak\.1$/);
    assert.equal(await readFile(join(dir2, "alvo.txt"), "utf8"), "importante");
    // a própria configuração sendo um link é recusada
    await rm(join(dir2, "config.json"));
    symlinkSync(join(dir2, "alvo.txt"), join(dir2, "config.json"));
    await assert.rejects(copiaDeSeguranca(join(dir2, "config.json")), /link simbólico/);
    assert.equal(await readFile(join(dir2, "alvo.txt"), "utf8"), "importante");
  }
});

test("B4: a reexecução do assistente guarda cópias numeradas (não sobrescreve a anterior)", async () => {
  const a = await amb();
  await writeFile(a.config, JSON.stringify({ githubUser: "usuario-teste", title: "primeiro" }));
  const regras = [[/Seu usuário/, ""], [/Gravar a configuração/, "s"]];
  for (let i = 0; i < 2; i++) await rodar({ a, ext: falsos({}).ext, regras, ambiente: { plataforma: "linux" } });
  assert.equal(JSON.parse(await readFile(`${a.config}.bak`, "utf8")).title, "primeiro");
  assert.ok(existsSync(`${a.config}.bak.1`));
});

test("B5 + B6: a reconfirmação de SUBSTITUIR acontece SEM o lock e mostra a tarefa atual sanitizada", async () => {
  const a = await amb();
  const lockNaPergunta = [];
  const { ext, chamadas } = falsos({
    tarefaExiste: true,
    tarefaAtual: "\u001b[31m\"C:\\velho\\node.exe\" \"C:\\velho\\a.mjs\" run\u001b[0m",
    criarTarefa: { ok: true },
  });
  const r = await rodar({
    a,
    ext,
    regras: [[/Seu usuário/, "usuario-teste"], [/Criar a tarefa diária/, "s"], [/Substituir a tarefa/, "s"], [/Reconfirmando/, "s"], [/Gravar a configuração/, "s"]],
    durante: (p) => {
      if (/Reconfirmando|Substituir a tarefa/.test(p)) lockNaPergunta.push(existsSync(join(a.estado, ".lock")));
    },
  });
  assert.deepEqual(lockNaPergunta, [false, false], "nenhuma pergunta com a pasta de estado travada");
  assert.match(r.texto, /Ela executa hoje: "C:\\velho\\node\.exe" "C:\\velho\\a\.mjs" run/);
  assert.match(r.texto, /Tarefa atual "ai-usage-metrics" executa: "C:\\velho/);
  assert.doesNotMatch(r.texto, /\u001b/);
  assert.equal(chamadas.find((c) => c[0] === "criarTarefa")[1].substituir, true);
  // recusar a reconfirmação: nada é criado e nada fica travado
  const b = await amb();
  const f = falsos({ tarefaExiste: true, tarefaAtual: "x", criarTarefa: { ok: true } });
  await rodar({ a: b, ext: f.ext, regras: [[/Seu usuário/, "usuario-teste"], [/Criar a tarefa diária/, "s"], [/Substituir a tarefa/, "s"], [/Gravar a configuração/, "s"]] });
  assert.equal(f.chamadas.some((c) => c[0] === "criarTarefa"), false);
});

test("B7: o consentimento da API avisa que o GitHub vê o IP do usuário", async () => {
  const a = await amb();
  const r = await rodar({ a, ext: falsos({}).ext, ambiente: { plataforma: "linux" }, regras: [[/Seu usuário/, "usuario-teste"], [/Gravar a configuração/, "n"]] });
  assert.ok(r.prompts.some((p) => /api\.github\.com\/users\/usuario-teste/.test(p) && /o GitHub verá o seu IP/.test(p) && /NODE_USE_ENV_PROXY/.test(p)));
});

void SetupCancelado;

// ---------- 0.3.1 ----------

const XML_PTBR = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Actions Context="Author">
    <Exec>
      <Command>"C:\\Program Files\\nodejs\\node.exe"</Command>
      <Arguments>"C:\\pacote\\bin\\a.mjs" "run" "--non-interactive" "--state-dir" "C:\\Dados &amp; Co\\e"</Arguments>
    </Exec>
  </Actions>
</Task>`;
const LISTA_PTBR = "Nome do host:                                           PC\r\nNome da tarefa:                                          \\ai-usage-metrics\r\nTarefa a ser executada:                                  \"C:\\Program Files\\nodejs\\node.exe\" \"C:\\pacote\\bin\\a.mjs\" \"run\"\r\nExecutar como Usuário:                                   x\r\n";
const LISTA_EN = "HostName:                             PC\r\nTask To Run:                          \"C:\\node.exe\" \"C:\\a.mjs\" run\r\nRun As User:                          x\r\n";
const execSaidas = (porArg) => (cmd, args, o, cb) => {
  const r = porArg(args) ?? { erro: true };
  queueMicrotask(() => (r.erro ? cb(Object.assign(new Error("x"), { code: 1 }), "", "") : cb(null, r.stdout, "")));
  return { stdin: { end() {} } };
};

test("0.3.1 #1: tarefaAtual lê o XML (independe do idioma) e cai para as chaves em texto; saída hostil é sanitizada e limitada", async () => {
  const chamadas = [];
  const via = (mapa) => externosPadrao({ plataforma: "win32", exec: execSaidas((args) => (chamadas.push(args.slice(2).join(" ")), mapa(args))) });
  // XML real (pt-BR e en têm o mesmo formato): Command + Arguments, entidades desescapadas
  const xml = via((a) => (a.includes("/XML") ? { stdout: XML_PTBR } : null));
  assert.equal(await xml.tarefaAtual("ai-usage-metrics"), '"C:\\Program Files\\nodejs\\node.exe" "C:\\pacote\\bin\\a.mjs" "run" "--non-interactive" "--state-dir" "C:\\Dados & Co\\e"');
  assert.equal(chamadas[0], "ai-usage-metrics /XML", "o XML é a primeira tentativa");
  // XML falhou: LIST /V com as chaves reais do Windows pt-BR ("Tarefa a ser executada") e en ("Task To Run")
  assert.equal(await via((a) => (a.includes("LIST") ? { stdout: LISTA_PTBR } : null)).tarefaAtual("x"), '"C:\\Program Files\\nodejs\\node.exe" "C:\\pacote\\bin\\a.mjs" "run"');
  assert.equal(await via((a) => (a.includes("LIST") ? { stdout: LISTA_EN } : null)).tarefaAtual("x"), '"C:\\node.exe" "C:\\a.mjs" run');
  assert.equal(await via(() => null).tarefaAtual("x"), null);
  // hostil: ESC/CSI, bidi, zero-width, entidade numérica de ESC, texto enorme
  const hostil = `<Exec><Command>C:\\a.exe</Command><Arguments>\u001b[31mx\u202e\u200b&#27;[2J${"y".repeat(1000)}</Arguments></Exec>`;
  const r = await via((a) => (a.includes("/XML") ? { stdout: hostil } : null)).tarefaAtual("x");
  assert.ok(r.length <= 300);
  assert.doesNotMatch(r, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u200b-\u200f\u2066-\u2069\ufeff]/);
  assert.match(r, /\\u\{202e\}/);
  // XML sem <Exec>, enorme ou lixo: sem resultado (cai para a lista, que também não tem a chave)
  assert.equal(await via((a) => (a.includes("/XML") ? { stdout: "<Task></Task>" } : { stdout: "nada" })).tarefaAtual("x"), null);
});

test("0.3.1 #2: bidi, zero-width e separadores são recusados em commitEmail/commitName/title/pasta; limparTexto os escapa", async () => {
  const bidi = "x\u202emoc.buhtig.yreplon.sresu@evil";
  assert.throws(() => normalizarConfig({ githubUser: "ab", commitEmail: bidi }), /commitEmail inválido/);
  for (const e of ["a\u200bb@x.com", "a\ufeff@x.com", "a@x\u200d.com", "a\u2028b@x.com", "a\u2066b@x.com"]) assert.throws(() => normalizarConfig({ githubUser: "ab", commitEmail: e }), /commitEmail inválido/, JSON.stringify(e));
  for (const n of ["Fulano\u202e", "Ful\u200bano", "Ful\u2028ano", "Ful\u2029ano", "Ful\u2069ano"]) assert.throws(() => normalizarConfig({ githubUser: "ab", commitName: n }), /commitName inválido/, JSON.stringify(n));
  assert.ok(normalizarConfig({ githubUser: "ab", commitName: "José Çñ 日本", commitEmail: "1+ab@users.noreply.github.com" }));
  for (const tt of ["Meu\u202e painel", "a\u200bb", "x\u2028y"]) assert.throws(() => normalizarConfig({ githubUser: "ab", title: tt }), /title/, JSON.stringify(tt));
  assert.throws(() => normalizarConfig({ githubUser: "ab", publicProjects: { "pasta\u202e": "ok" } }), /controle/);
  const l = limparTexto("a\u202eb\u200bc\ufeffd\u2066e");
  assert.doesNotMatch(l, /[\u202a-\u202e\u200b-\u200f\u2066-\u2069\ufeff]/);
  assert.equal(l, "a\\u{202e}b\\u{200b}c\\u{feff}d\\u{2066}e");
  // o título hostil também é barrado antes de chegar ao SVG (comando render) e ao resumo do setup
  const estado = await tmp();
  await assert.rejects(main(["render", "--title", "x\u202eevil", "--state-dir", estado], () => {}, { isTTY: false, ask: async () => "" }), /title/);
  const a = await amb();
  await writeFile(a.config, JSON.stringify({ githubUser: "usuario-teste", title: "Painel" }));
  const r = await rodar({ a, ext: falsos({}).ext, ambiente: { plataforma: "linux" }, regras: [[/Seu usuário/, ""], [/Gravar a configuração/, "n"]] });
  assert.match(r.texto, /título "Painel"/);
  assert.doesNotMatch(r.texto, /[\u202a-\u202e\u200b-\u200f]/);
});

test("0.3.1 #3: o signal chega a ghUsuario/ghRepo/apiUsuario/apiRepo; signal já abortado nem abre a conexão", async () => {
  const sinais = [];
  const exec = (cmd, args, opts, cb) => (sinais.push(opts.signal), queueMicrotask(() => cb(null, "{}", "")), { stdin: { end() {} } });
  const ctl = new AbortController();
  const ext = externosPadrao({ exec });
  await ext.ghUsuario({ signal: ctl.signal });
  await ext.ghRepo("usuario-teste", "ai-metrics", { signal: ctl.signal });
  assert.deepEqual(sinais, [ctl.signal, ctl.signal]);
  // abortado na entrada: nenhuma conexão é aberta
  ctl.abort();
  const pedidos = [];
  const request = () => (pedidos.push(1), assert.fail("não deve abrir conexão"));
  assert.deepEqual(await apiGet("/users/usuario-teste", { request, signal: ctl.signal }), { erro: "cancelado" });
  const api = externosPadrao({ request });
  assert.deepEqual(await api.apiUsuario("usuario-teste", { signal: ctl.signal }), { estado: "erro", motivo: "cancelado" });
  assert.deepEqual(await api.apiRepo("usuario-teste", "ai-metrics", { signal: ctl.signal }), { estado: "erro", motivo: "cancelado" });
  assert.equal(pedidos.length, 0);
  // gh abortado devolve "cancelado" (o assistente encerra), não "sem login"
  const abortado = externosPadrao({ exec: (c, a, o, cb) => (queueMicrotask(() => cb(Object.assign(new Error("a"), { name: "AbortError", code: "ABORT_ERR" }), "", "")), { stdin: { end() {} } }) });
  assert.deepEqual(await abortado.ghUsuario(), { estado: "cancelado" });
});

test("0.3.1 #3: Ctrl+C numa consulta inicial (gh api user) encerra o assistente sem gravar nada", async () => {
  const a = await amb();
  const h = {};
  const { ext, chamadas } = falsos({
    ghUsuario: ({ signal }) => new Promise((res) => {
      signal.addEventListener("abort", () => res({ estado: "cancelado" }), { once: true });
      setTimeout(() => h.io.cancelar(), 20);
    }),
  });
  const r = await rodar({ a, ext, regras: [[/gh api user/, "s"]], ambiente: { plataforma: "linux" }, holder: h });
  assert.match(r.texto, /Assistente encerrado \(cancelado durante uma consulta externa\)/);
  assert.match(r.texto, /Nada foi gravado/);
  assert.deepEqual(chamadas.map((c) => c[0]), ["ghUsuario"]);
  assert.equal(existsSync(a.config), false);
});

test("0.3.1 #4: a ação em curso é dita 'interrompida; pode ter sido parcialmente executada', e só as não iniciadas são 'NÃO executado'", async () => {
  const a = await amb();
  const h = {};
  const { ext } = falsos({
    tarefaExiste: false,
    npmInstalar: ({ signal }) => new Promise((res) => {
      signal.addEventListener("abort", () => res({ ok: false, cancelado: true, motivo: "cancelado" }), { once: true });
      setTimeout(() => h.io.cancelar(), 20);
    }),
  });
  const r = await rodar({ a, ext, regras: REGRAS_NPX, ambiente: { bin: NPX }, holder: h });
  assert.match(r.texto, /Já feito: gravar a configuração\./);
  assert.match(r.texto, /Interrompida durante: npm install da cópia fixa\. Ela pode ter sido parcialmente executada: confira o GitHub, o Agendador de Tarefas/);
  assert.match(r.texto, /NÃO executado: criar a tarefa agendada\./);
  assert.doesNotMatch(r.texto, /NÃO executado:[^\n]*npm install/, "a ação em curso não é chamada de 'não executada'");
});

test("0.3.1 #5: Ctrl+C no prompt do publish encerra o assistente, não grava aprovação, não envia e não mostra 'Pronto'", async () => {
  const a = await amb();
  const { ext } = falsos({});
  const r = await rodar({
    a,
    ext,
    ambiente: { plataforma: "linux" },
    regras: [[/Seu usuário/, "usuario-teste"], [/Gravar a configuração/, "s"]],
    durante: (p) => {
      if (/Enviar estes arquivos/.test(p)) throw new SetupCancelado("entrada encerrada");
    },
  });
  assert.match(r.texto, /Assistente encerrado \(entrada encerrada\)/);
  assert.match(r.texto, /JÁ tinha sido gravada/);
  assert.doesNotMatch(r.texto, /Pronto|raw\.githubusercontent\.com/);
  assert.equal(existsSync(a.paths.estado), false, "nenhuma aprovação (state.json) foi gravada");
  assert.equal(existsSync(join(a.estado, ".lock")), false);
});

test("0.3.1 #6: npmInstalar confere nome e versão instalados (package.json); outro pacote ou versão é falha", async () => {
  const prefixo = await tmp();
  const raiz = join(prefixo, "node_modules", "ai-usage-metrics");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(raiz, "bin"), { recursive: true });
  await writeFile(join(raiz, "bin", "ai-usage-metrics.mjs"), "// x\n");
  const exec = (cmd, args, opts, cb) => (queueMicrotask(() => cb(null, "", "")), { stdin: { end() {} } });
  const ext = externosPadrao({ exec, npmCli: "C:\\npm-falso\\npm-cli.js" });
  const grava = (o) => writeFile(join(raiz, "package.json"), JSON.stringify(o));
  await grava({ name: "outro-pacote", version: "0.2.0" });
  const a = await ext.npmInstalar({ prefixo, versao: "0.2.0" });
  assert.equal(a.ok, false);
  assert.match(a.motivo, /instalou outra coisa \(outro-pacote@0\.2\.0\) em vez de ai-usage-metrics@0\.2\.0/);
  await grava({ name: "ai-usage-metrics", version: "9.9.9" });
  assert.equal((await ext.npmInstalar({ prefixo, versao: "0.2.0" })).ok, false);
  await writeFile(join(raiz, "package.json"), "não é json");
  assert.equal((await ext.npmInstalar({ prefixo, versao: "0.2.0" })).ok, false);
  await grava({ name: "ai-usage-metrics", version: "0.2.0" });
  assert.deepEqual(await ext.npmInstalar({ prefixo, versao: "0.2.0" }), { ok: true, bin: join(raiz, "bin", "ai-usage-metrics.mjs") });
  // no assistente: instalação trocada => a tarefa NÃO é criada
  const w = await amb();
  const { ext: falso, chamadas } = falsos({ tarefaExiste: false, npmInstalar: { ok: false, motivo: "o npm instalou outra coisa (x@1.0.0) em vez de ai-usage-metrics@0.2.0; a tarefa não será criada" } });
  const r = await rodar({ a: w, ext: falso, regras: REGRAS_NPX, ambiente: { bin: NPX } });
  assert.equal(chamadas.some((c) => c[0] === "criarTarefa"), false);
  assert.match(r.texto, /instalou outra coisa/);
});

test("0.3.1 #9: a poda das cópias .bak é numérica (.bak.2 < .bak.10), não depende do mtime, e mantém as 5 mais novas", async () => {
  const dir = await tmp();
  const cfg = join(dir, "config.json");
  const quando = new Date("2030-01-01T00:00:00Z");
  for (let i = 0; i < 13; i++) {
    await writeFile(cfg, JSON.stringify({ n: i }));
    const dest = await copiaDeSeguranca(cfg);
    utimesSync(dest, quando, quando); // todas com o MESMO mtime: só o número decide
  }
  const nomes = (await readdir(dir)).filter((n) => n.startsWith("config.json.bak")).sort((x, y) => x.length - y.length || (x < y ? -1 : 1));
  assert.deepEqual(nomes, ["config.json.bak.8", "config.json.bak.9", "config.json.bak.10", "config.json.bak.11", "config.json.bak.12"].sort((x, y) => x.length - y.length || (x < y ? -1 : 1)));
  assert.equal(JSON.parse(await readFile(join(dir, "config.json.bak.12"), "utf8")).n, 12);
});
