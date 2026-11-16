import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { aggregate } from "../src/aggregate.mjs";
import { main } from "../src/cli.mjs";
import { garantirSemVazamento, lerAllowlist, nomeDoProjeto } from "../src/privacy.mjs";
import { toPublic } from "../src/public.mjs";
import { claudeFalso, clineFalso, codexFalso, homeFalsa } from "./fixtures.mjs";

const HOME = "C:\\Users\\fulano";
const tk = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0 });

const eventos = [
  { tool: "a", project: `${HOME}\\Desktop\\Publico`, session: "s1", ts: Date.parse("2026-01-01T10:00:00Z"), kind: "user" },
  { tool: "a", project: `${HOME}\\Desktop\\Publico`, session: "s1", ts: Date.parse("2026-01-01T10:01:00Z"), kind: "assistant", tokens: tk(10, 5) },
  { tool: "a", project: `${HOME}\\Desktop\\Publico`, session: "s2", ts: Date.parse("2026-01-02T10:00:00Z"), kind: "user" },
  { tool: "b", project: `${HOME}\\Desktop\\Segredo`, session: "s9", ts: Date.parse("2026-02-01T10:00:00Z"), kind: "user" },
  { tool: "b", project: `${HOME}\\Desktop\\Segredo`, session: "s9", ts: Date.parse("2026-02-01T10:00:30Z"), kind: "user" },
  { tool: "b", project: `${HOME}\\Desktop\\Segredo`, session: "s9", ts: Date.parse("2026-02-01T10:01:00Z"), kind: "assistant", tokens: tk(1, 1) },
  { tool: "c", project: null, session: "t1", ts: Date.parse("2026-02-03T10:00:00Z"), kind: "session" },
];

test("nomeDoProjeto: só o último nome da pasta", () => {
  assert.equal(nomeDoProjeto("C:\\Users\\fulano\\Desktop\\meu-app", HOME), "meu-app");
  assert.equal(nomeDoProjeto("/home/fulano/dev/app/", "/home/fulano"), "app");
  assert.equal(nomeDoProjeto("C:\\Users\\fulano\\Desktop\\repo\\.claude\\worktrees\\x", HOME), "repo");
  assert.equal(nomeDoProjeto(HOME, HOME), "(pasta pessoal)");
  assert.equal(nomeDoProjeto("C:\\", HOME), null);
  assert.equal(nomeDoProjeto(null, HOME), null);
});

test("aggregate: sessões, mensagens, tokens, período e série diária", async () => {
  const agg = await aggregate(eventos, { home: HOME });
  const pub = toPublic(agg, { allowlist: new Map([["publico", "Meu Projeto"]]), home: HOME, now: new Date("2026-03-01T00:00:00Z") });
  assert.deepEqual(pub.period, { from: "2026-01-01", to: "2026-02-03" });
  assert.equal(pub.totals.sessions, 4);
  assert.equal(pub.totals.userMessages, 4);
  assert.equal(pub.totals.tokens.total, 17);
  const meu = pub.projects.find((p) => p.name === "Meu Projeto");
  assert.equal(meu.sessions, 2);
  assert.equal(meu.userMessages, 2);
  assert.equal(meu.tokens.input, 10);
  assert.deepEqual(pub.timeline.points.map((p) => p.date), ["2026-01-01", "2026-01-02", "2026-02-01", "2026-02-03"]);
  assert.equal(pub.timeline.points[0].byTool.a.userMessages, 1);
  assert.equal(pub.tools.length, 3);
});

test("ranking: mais mensagens primeiro; anonimiza o que não está na allowlist", async () => {
  const agg = await aggregate(eventos, { home: HOME });
  const pub = toPublic(agg, { allowlist: new Map([["publico", "Meu Projeto"]]), home: HOME });
  assert.deepEqual(pub.projects.map((p) => [p.name, p.public]), [
    ["Meu Projeto", true],
    ["projeto-privado-1", false],
    ["sem-projeto", true],
  ]);
  const json = JSON.stringify(pub);
  for (const proibido of ["Segredo", "fulano", "Desktop", "C:"]) assert.ok(!json.includes(proibido), proibido);
});

test("por padrão (sem allowlist) tudo é anonimizado", async () => {
  const agg = await aggregate(eventos, { home: HOME });
  const pub = toPublic(agg, { allowlist: new Map(), home: HOME });
  assert.ok(!JSON.stringify(pub).includes("Publico"));
  assert.deepEqual(pub.projects.map((p) => p.name), ["projeto-privado-1", "projeto-privado-2", "sem-projeto"]);
});

test("allowlist: aceita lista e mapa; rejeita alias perigoso ou repetido", () => {
  assert.deepEqual([...lerAllowlist({ publicProjects: ["Meu-App"] })], [["meu-app", "Meu-App"]]);
  assert.equal(lerAllowlist({ publicProjects: { pasta: "Nome Bonito" } }).get("pasta"), "Nome Bonito");
  assert.throws(() => lerAllowlist({ publicProjects: { x: "C:\\Users\\a" } }), /inválido/);
  assert.throws(() => lerAllowlist({ publicProjects: { x: "a@b.com" } }), /inválido/);
  assert.throws(() => lerAllowlist({ publicProjects: { x: "Igual", y: "igual" } }), /repetido/);
  assert.equal(lerAllowlist({}).size, 0);
});

test("barreira de vazamento bloqueia caminho, e-mail e pasta pessoal", () => {
  assert.throws(() => garantirSemVazamento('{"a":"C:\\\\Users\\\\x"}', HOME), /bloqueada/);
  assert.throws(() => garantirSemVazamento('{"a":"fulano@mail.com"}', HOME), /bloqueada/);
  assert.throws(() => garantirSemVazamento('{"a":"/home/fulano/x"}', "/home/fulano"), /bloqueada/);
  assert.doesNotThrow(() => garantirSemVazamento('{"a":"projeto-privado-1","n":3}', HOME));
});

test("CLI export de ponta a ponta com dados falsos: sem texto, caminho nem nome real", async () => {
  const home = await homeFalsa();
  try {
    await claudeFalso(home);
    await clineFalso(home);
    await codexFalso(home);
    const saida = join(home, "metrics.json");
    const linhas = [];
    await main(["export", "--home", home, "--out", saida, "--config", join(home, "nao-existe.json")], (l) => linhas.push(l));
    const txt = await readFile(saida, "utf8");
    const j = JSON.parse(txt);
    assert.equal(j.schemaVersion, 1);
    assert.deepEqual(j.tools.map((t) => t.id).sort(), ["chatgpt", "claude-code", "cline"]);
    assert.ok(j.projects.every((p) => p.name.startsWith("projeto-privado-") || p.name === "sem-projeto"));
    for (const proibido of ["SECRETO", "SAIDA", "RESPOSTA", "fulano", "projeto-alfa", "projeto-beta", "Desktop", home.replace(/\\/g, "\\\\")]) {
      assert.ok(!txt.includes(proibido), proibido);
    }
    assert.ok(linhas.some((l) => l.includes("anonimizados")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("CLI: ferramenta desconhecida e comando desconhecido dão erro claro", async () => {
  await assert.rejects(main(["report", "--tool", "nada"], () => {}), /desconhecida/);
  await assert.rejects(main(["voar"], () => {}), /desconhecido/);
});
