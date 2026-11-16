// Ambiente externo do assistente: execFile sem shell, ambiente por allowlist, parse estrito, consulta HTTPS limitada. Tudo com fakes: sem rede.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { ambienteExterno, apiGet, externosPadrao, localizarNpmCli } from "../src/ambiente.mjs";
import { schtasksParaCmd, valorTR } from "../src/cli.mjs";
import { SetupCancelado, criarTarefaAgendada, ioInterativo } from "../src/setup.mjs";

/** exec falso: grava (comando, args, opções) e responde pelo roteiro. */
function execFalso(roteiro) {
  const chamadas = [];
  const exec = (cmd, args, opts, cb) => {
    chamadas.push({ cmd, args, opts });
    const r = roteiro(cmd, args) ?? { stdout: "" };
    queueMicrotask(() => (r.erro ? cb(Object.assign(new Error("falhou"), r.erro), r.stdout ?? "", r.stderr ?? "") : cb(null, r.stdout ?? "", r.stderr ?? "")));
    return { stdin: { end() {} } };
  };
  return { exec, chamadas };
}

test("ambienteExterno: allowlist, sem token e sem variáveis perigosas", () => {
  const env = ambienteExterno({ PATH: "/bin", GH_TOKEN: "segredo", GITHUB_TOKEN: "s2", NPM_TOKEN: "s3", GIT_SSH_COMMAND: "x", NODE_OPTIONS: "--require x", LC_ALL: "C", HTTPS_PROXY: "http://p:1", Path: "C:\\x" });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.GIT_SSH_COMMAND, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.Path, "C:\\x");
  assert.equal(env.GH_PROMPT_DISABLED, "1");
});

test("gh: argumentos fixos em array, sem shell, ambiente limpo; saída hostil vira erro", async () => {
  const { exec, chamadas } = execFalso((cmd, args) => {
    if (args[0] === "api") return { stdout: JSON.stringify({ login: "usuario-teste", id: 10, email: "x@y.z", token: "ghp_zzz" }) };
    if (args[0] === "repo" && args[1] === "view") return { erro: { code: 1 }, stderr: "GraphQL: Could not resolve to a Repository with the name 'x'." };
    return { stdout: "" };
  });
  const ext = externosPadrao({ exec, plataforma: "win32" });
  assert.deepEqual(await ext.ghUsuario(), { estado: "ok", login: "usuario-teste", id: 10 });
  assert.deepEqual(await ext.ghRepo("usuario-teste", "ai-metrics"), { estado: "inexistente" });
  assert.deepEqual(await ext.ghCriarRepo("usuario-teste", "ai-metrics"), { ok: true });
  assert.deepEqual(chamadas[0].args, ["api", "user"]);
  assert.deepEqual(chamadas[1].args, ["repo", "view", "usuario-teste/ai-metrics", "--json", "name,isPrivate"]);
  assert.deepEqual(chamadas[2].args, ["repo", "create", "usuario-teste/ai-metrics", "--public", "--description", "AI usage metrics (ai-usage-metrics)"]);
  for (const c of chamadas) {
    assert.equal(c.cmd, "gh");
    assert.equal(c.opts.shell, false);
    assert.equal(c.opts.windowsHide, true);
    assert.ok(c.opts.timeout > 0);
    assert.equal(c.opts.env.GH_TOKEN, undefined);
  }
  // entrada hostil nunca chega ao processo
  const antes = chamadas.length;
  assert.deepEqual(await ext.ghRepo("x; rm -rf /", "ai-metrics"), { estado: "erro" });
  assert.deepEqual(await ext.ghRepo("ok", "../x"), { estado: "erro" });
  assert.deepEqual(await ext.ghCriarRepo("ok", "a b"), { ok: false, motivo: "nome inválido" });
  assert.equal(chamadas.length, antes);
  // gh ausente / sem login / lixo
  const ausente = externosPadrao({ exec: execFalso(() => ({ erro: { code: "ENOENT" } })).exec });
  assert.deepEqual(await ausente.ghUsuario(), { estado: "ausente" });
  const semLogin = externosPadrao({ exec: execFalso(() => ({ erro: { code: 1 }, stderr: "not logged in" })).exec });
  assert.deepEqual(await semLogin.ghUsuario(), { estado: "sem-login" });
  const lixo = externosPadrao({ exec: execFalso(() => ({ stdout: "\u001b[31m{" })).exec });
  assert.deepEqual(await lixo.ghUsuario(), { estado: "erro" });
  const mente = externosPadrao({ exec: execFalso(() => ({ stdout: JSON.stringify({ name: "outro", isPrivate: false }) })).exec });
  assert.deepEqual(await mente.ghRepo("usuario-teste", "ai-metrics"), { estado: "erro" });
});

test("apiGet: host fixo, só GET, sem credenciais, limite de tamanho, timeout e caminho estrito", async () => {
  const pedidos = [];
  const falso = (corpo, status = 200, { atrasar = false } = {}) => (opts, cb) => {
    pedidos.push(opts);
    const req = new EventEmitter();
    req.end = () => {
      if (atrasar) return setImmediate(() => req.emit("timeout"));
      const res = new EventEmitter();
      res.statusCode = status;
      cb(res);
      for (const parte of corpo) res.emit("data", Buffer.from(parte));
      res.emit("end");
    };
    req.destroy = () => {};
    return req;
  };
  const ok = await apiGet("/users/usuario-teste", { request: falso(['{"login":"usuario-teste","id":1}']) });
  assert.equal(ok.status, 200);
  const o = pedidos[0];
  assert.equal(o.host, "api.github.com");
  assert.equal(o.method, "GET");
  assert.equal(o.path, "/users/usuario-teste");
  assert.ok(o.timeout > 0);
  assert.deepEqual(Object.keys(o.headers).sort(), ["Accept", "User-Agent"]); // nenhum Authorization
  assert.deepEqual(await apiGet("/users/x", { request: falso(["x".repeat(70_000)]) }), { erro: "resposta grande demais" });
  assert.deepEqual(await apiGet("/users/x", { request: falso([], 200, { atrasar: true }) }), { erro: "tempo esgotado" });
  for (const ruim of ["/users/a/b", "/users/../x", "/user", "https://evil.example/users/x", "/users/x?y=1", "/repos/a/b/c", "//evil/users/x", "/users/" + "a".repeat(40)]) {
    assert.deepEqual(await apiGet(ruim, { request: falso(["{}"]) }), { erro: "caminho recusado" }, ruim);
  }
  // via externosPadrao: resposta de outro usuário, id inválido e status inesperado são recusados
  const mk = (corpo, status) => externosPadrao({ request: falso([corpo], status) });
  assert.deepEqual(await mk('{"login":"outra","id":5}', 200).apiUsuario("usuario-teste"), { estado: "erro", motivo: "resposta inesperada" });
  assert.deepEqual(await mk('{"login":"usuario-teste","id":"5"}', 200).apiUsuario("usuario-teste"), { estado: "erro", motivo: "resposta inesperada" });
  assert.deepEqual(await mk("{}", 404).apiUsuario("usuario-teste"), { estado: "inexistente" });
  assert.deepEqual(await mk("{}", 403).apiRepo("usuario-teste", "ai-metrics"), { estado: "erro", motivo: "HTTP 403" });
  assert.deepEqual(await mk('{"name":"ai-metrics","private":false}', 200).apiRepo("usuario-teste", "ai-metrics"), { estado: "existe", privado: false });
});

test("npm: node + npm-cli.js (sem shell), versão fixa, --ignore-scripts; versão hostil recusada", async () => {
  const { exec, chamadas } = execFalso(() => ({ stdout: "" }));
  const ext = externosPadrao({ exec });
  assert.deepEqual(await ext.npmInstalar({ prefixo: "C:\\x", versao: "0.2.0; calc" }), { ok: false, motivo: "versão inválida" });
  assert.equal(chamadas.length, 0);
  const cli = localizarNpmCli();
  if (cli) {
    const r = await ext.npmInstalar({ prefixo: "C:\\x\\runtime", versao: "0.2.0" });
    assert.equal(chamadas[0].cmd, process.execPath);
    assert.deepEqual(chamadas[0].args.slice(1), ["install", "--prefix", "C:\\x\\runtime", "ai-usage-metrics@0.2.0", "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error"]);
    assert.equal(chamadas[0].opts.shell, false);
    assert.equal(r.ok, false); // o fake não instalou nada: o executável esperado não existe
  }
  assert.equal(localizarNpmCli("C:\\nada\\node.exe", () => false), null);
});

test("schtasks: /Create via execFile com o /TR já validado; /F só ao substituir; caminho hostil não gera comando", async () => {
  const { exec, chamadas } = execFalso(() => ({ stdout: "" }));
  const ext = externosPadrao({ exec, plataforma: "win32" });
  const etapas = { schtasksParaCmd, valorTR };
  const r = await criarTarefaAgendada({ etapas, ext, nome: "ai-usage-metrics-teste", horario: "07:05", node: "C:\\Program Files\\nodejs\\node.exe", bin: "C:\\pacote\\bin\\a.mjs", argsExtras: ["--state-dir", "C:\\Dados\\estado\\"], substituir: true });
  assert.equal(r.ok, true);
  assert.equal(chamadas[0].cmd, "schtasks");
  assert.deepEqual(chamadas[0].args, ["/Create", "/SC", "DAILY", "/ST", "07:05", "/TN", "ai-usage-metrics-teste", "/TR", `"C:\\Program Files\\nodejs\\node.exe" "C:\\pacote\\bin\\a.mjs" "run" "--non-interactive" "--state-dir" "C:\\Dados\\estado\\\\"`, "/F"]);
  for (const ruim of ['C:\\a"b', "C:\\a&b", "C:\\a%b", "C:\\a|b", "C:\\a\nb"]) {
    const x = await criarTarefaAgendada({ etapas, ext, horario: "12:00", node: "C:\\n.exe", bin: ruim });
    assert.equal(x.ok, false, ruim);
  }
  assert.equal((await criarTarefaAgendada({ etapas, ext, horario: "12:00;calc", node: "C:\\n.exe", bin: "C:\\b.mjs" }).catch((e) => ({ ok: false, erro: e.message }))).ok, false);
  assert.equal(chamadas.length, 1, "nenhuma chamada extra com entrada hostil");
  // não-Windows: nunca cria
  const linux = externosPadrao({ exec, plataforma: "linux" });
  assert.equal((await linux.criarTarefa({ nome: "x", horario: "12:00", tr: "x" })).ok, false);
  assert.equal(chamadas.length, 1);
});

test("ioInterativo: Ctrl+D/fim da entrada rejeita com SetupCancelado (sem pendurar) e as respostas chegam em ordem", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const io = ioInterativo(input, output);
  const p1 = io.ask("a? ");
  input.write("um\n");
  assert.equal(await p1, "um");
  const p2 = io.ask("b? ");
  input.end();
  await assert.rejects(p2, SetupCancelado);
  await assert.rejects(io.ask("c? "), SetupCancelado);
  io.fechar();
});

test("schtasks: /TR acima de 261 caracteres (limite real do Agendador) é recusado com orientação, sem executar", async () => {
  const { exec, chamadas } = execFalso(() => ({ stdout: "" }));
  const ext = externosPadrao({ exec, plataforma: "win32" });
  const r = await criarTarefaAgendada({ etapas: { schtasksParaCmd, valorTR }, ext, horario: "12:00", node: "C:\\Program Files\\nodejs\\node.exe", bin: "C:\\pacote\\bin\\a.mjs", argsExtras: ["--state-dir", `C:\\${"d".repeat(250)}`] });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /261/);
  assert.equal(chamadas.length, 0);
});
