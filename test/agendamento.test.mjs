// N3b/N9: comandos de agendamento impressos para cmd.exe e PowerShell, validados pelo parsing REAL do Windows.
// Nenhuma tarefa é criada: o "schtasks" é trocado por um programa de teste (node) que apenas grava os argumentos recebidos.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { aspasPosix, instrucoesDeAgendamento, schtasksParaCmd, schtasksParaPowerShell } from "../src/cli.mjs";

const windows = process.platform === "win32";
const pulaSeNaoWindows = windows ? false : "PULADO: precisa de cmd.exe/PowerShell reais (só roda no Windows)";
let dir;
let eco;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-usage-agenda-"));
  eco = join(dir, "eco.mjs");
  await writeFile(eco, 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.ECO, JSON.stringify(process.argv.slice(2)));\n');
});
after(() => rm(dir, { recursive: true, force: true }));

const NOS = ["C:\\Program Files\\nodejs\\node.exe", "C:\\bin\\x.mjs", "run", "--state-dir"];
const comCaractere = (c) => [...NOS, `C:\\Dir A${c}B\\estado`];

/** Executa a linha como a shell real faria, trocando "schtasks" pelo eco. Devolve os argumentos recebidos. */
function rodar(shell, comando) {
  const saida = join(dir, `saida-${Math.random().toString(36).slice(2)}.json`);
  const env = { ...process.env, ECO: saida };
  if (shell === "cmd") {
    const linha = comando.replace(/^schtasks /, `"${process.execPath}" "${eco}" `);
    spawnSync("cmd.exe", ["/d", "/s", "/c", `"${linha}"`], { windowsVerbatimArguments: true, env });
  } else {
    const ps = comando.replace(/^Start-Process -FilePath schtasks -ArgumentList '/, () => `Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' -ArgumentList '"${eco}" `);
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { env });
  }
  return readFile(saida, "utf8").then((t) => JSON.parse(t), () => null);
}

/** O valor de /TR, relido como o Agendador leria (linha de comando do Windows), tem de devolver os argumentos originais. */
function relerTR(tr) {
  const saida = join(dir, `tr-${Math.random().toString(36).slice(2)}.json`);
  // cmd /c só repassa a linha como está (não há como dar linha crua a um programa sem shell).
  spawnSync("cmd.exe", ["/d", "/s", "/c", `"\"${process.execPath}\" \"${eco}\" ${tr}"`], { windowsVerbatimArguments: true, env: { ...process.env, ECO: saida } });
  return readFile(saida, "utf8").then((t) => JSON.parse(t), () => null);
}

const esperadoTR = (args) => args.map((a) => `"${a.replace(/\\+$/, (m) => m + m)}"`).join(" ");
const SEGUROS = [" ", ";", ",", "=", "$", "`", "'", "(", ")", "$(whoami)", "{", "}", "[", "]", "#", "@", "~", "é", "\u2019", "\u2018", "''"];
const SO_CMD_RECUSA = ["&", "|", "<", ">", "^", "%", "!"];

test("N3b: cmd.exe real recebe o /TR íntegro (espaço, ; $() crase ' , = parênteses, não-ASCII, barra final)", { skip: pulaSeNaoWindows }, async () => {
  for (const c of SEGUROS) {
    const args = comCaractere(c);
    const r = await rodar("cmd", schtasksParaCmd(args));
    assert.ok(r, `cmd sem resposta para ${JSON.stringify(c)}`);
    assert.deepEqual(r.slice(0, 6), ["/Create", "/SC", "DAILY", "/ST", "12:00", "/TN"]);
    assert.equal(r[r.indexOf("/TR") + 1], esperadoTR(args), `cmd: ${JSON.stringify(c)}`);
  }
  const barra = [...NOS, "C:\\Dados\\estado\\"];
  const r = await rodar("cmd", schtasksParaCmd(barra));
  assert.equal(r[r.indexOf("/TR") + 1], esperadoTR(barra));
});

test("N3b: PowerShell real recebe o /TR íntegro (inclusive aspas simples, tipográficas, $(), crase, & | ^)", { skip: pulaSeNaoWindows }, async () => {
  for (const c of [" ;,=", "'", "''", "’‘", "$(whoami)`x`", "&|^!<>", "(){}[]#@~é", "&& ; calc $env:USERNAME", "x\\"]) {
    const args = comCaractere(c);
    const r = await rodar("ps", schtasksParaPowerShell(args));
    assert.ok(r, `PowerShell sem resposta para ${JSON.stringify(c)}`);
    assert.equal(r[r.indexOf("/TR") + 1], esperadoTR(args), `PowerShell: ${JSON.stringify(c)}`);
  }
});

test("N3b: o /TR relido como o Agendador leria devolve os caminhos originais", { skip: pulaSeNaoWindows }, async () => {
  for (const c of [" ", ";", "'", "$(x)", "`", "é"]) {
    const args = [...NOS, `C:\\Dir A${c}B\\estado\\`];
    const r = await relerTR(esperadoTR(args));
    assert.deepEqual(r, args, `releitura: ${JSON.stringify(c)}`);
  }
});

test("N3b: cmd recusa & | < > ^ % ! e aspas/controle; PowerShell recusa só aspas duplas e controle; mensagem sem comando", () => {
  for (const c of SO_CMD_RECUSA) {
    assert.throws(() => schtasksParaCmd(comCaractere(c)), /cmd\.exe interpreta/, c);
    if (c.includes("%")) assert.throws(() => schtasksParaPowerShell(comCaractere(c)), /'%'/, c); // B2: % também é recusado no PowerShell
    else assert.doesNotThrow(() => schtasksParaPowerShell(comCaractere(c)), c);
  }
  for (const c of ['"', "\r", "\n", "\0", "\u001b"]) {
    assert.throws(() => schtasksParaCmd(comCaractere(c)), undefined, JSON.stringify(c));
    assert.throws(() => schtasksParaPowerShell(comCaractere(c)), undefined, JSON.stringify(c));
  }
  const t = instrucoesDeAgendamento({ stateDir: "C:\\a&b\\100%", node: "C:\\n\\node.exe", bin: "C:\\b.mjs" });
  assert.match(t, /cmd\.exe:\n {4}\(comando não gerado para este shell\)/);
  assert.match(t, /PowerShell[^\n]*\n {4}\(comando não gerado para este shell\)[^\n]*'%'/); // B2: % também recusado no PowerShell
  const semPercent = instrucoesDeAgendamento({ stateDir: "C:\\a b\\estado", node: "C:\\n\\node.exe", bin: "C:\\b.mjs" });
  assert.match(semPercent, /PowerShell[^\n]*\n {4}Start-Process -FilePath schtasks -ArgumentList '/);
  assert.doesNotMatch(t, /no PowerShell ou cmd/);
  const quebra = instrucoesDeAgendamento({ stateDir: "/x/a\nb", node: "/n", bin: "/b" });
  assert.equal((quebra.match(/não gerado/g) ?? []).length, 3, "cmd, PowerShell e cron recusados");
  assert.doesNotMatch(quebra, /Start-Process -FilePath schtasks -ArgumentList '/);
});

test("N9: aspasPosix recusa \\r, \\n e \\0 e continua citando aspas simples", () => {
  for (const c of ["\r", "\n", "a\nb", "\0"]) assert.throws(() => aspasPosix(c), /quebra de linha/);
  assert.equal(aspasPosix("o'neil"), "'o'\\''neil'");
  assert.equal(aspasPosix("a b;$(x)`y`"), "'a b;$(x)`y`'");
});
