import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { exigirMetricasValidas, validarMetricas } from "../src/schema.mjs";
import { metricasSinteticas } from "./sintetico.mjs";

const clone = (o) => JSON.parse(JSON.stringify(o));
const recusa = (json, trecho) => {
  const r = validarMetricas(json);
  assert.equal(r.ok, false, "deveria recusar");
  assert.ok(r.errors.some((e) => e.includes(trecho)), `esperava "${trecho}" em: ${r.errors.join(" | ")}`);
};

test("schema: aceita a saída real do código e o exemplo sintético", async () => {
  const m = await metricasSinteticas();
  assert.deepEqual(validarMetricas(m), { ok: true, errors: [] });
  const ex = JSON.parse(await readFile(new URL("../examples/metrics.example.json", import.meta.url), "utf8"));
  assert.equal(validarMetricas(ex).ok, true);
});

test("schema: rejeita campo extra em qualquer nível", async () => {
  const m = await metricasSinteticas();
  const alvos = [
    (x) => x,
    (x) => x.totals,
    (x) => x.tools[0],
    (x) => x.projects[0],
    (x) => x.projects[0].tools[0],
    (x) => x.timeline,
    (x) => x.timeline.points[0],
    (x) => x.timeline.points[0].byTool["claude-code"],
    (x) => x.totals.tokens,
  ];
  for (const alvo of alvos) {
    const c = clone(m);
    alvo(c).owner = "fulano";
    recusa(c, "campo não permitido");
  }
});

test("schema: rejeita campo obrigatório ausente e versão errada", async () => {
  const m = await metricasSinteticas();
  const a = clone(m);
  delete a.totals;
  recusa(a, "totals");
  const b = clone(m);
  b.schemaVersion = 2;
  recusa(b, "esquema 1");
  recusa([], "deve ser um objeto");
  recusa(null, "deve ser um objeto");
});

test("schema: rejeita caminho, e-mail e texto livre em nomes", async () => {
  const m = await metricasSinteticas();
  const ruins = ["C:\\Users\\fulano\\proj", "/home/fulano/proj", "fulano@mail.com", "Texto livre: refatorei o login do cliente X", "a".repeat(61), "<script>", "nome\nquebra"];
  for (const nome of ruins) {
    const c = clone(m);
    c.projects[0].name = nome;
    c.projects[0].public = true;
    recusa(c, "nome inválido");
    const d = clone(m);
    d.tools[0].name = nome;
    recusa(d, "tools[0].name");
  }
  const c = clone(m);
  c.projects.find((p) => !p.public).name = "segredo-x";
  recusa(c, "projeto-privado-N");
});

test("schema: rejeita id de ferramenta, data, número e total inconsistentes", async () => {
  const m = await metricasSinteticas();
  const casos = [
    [(x) => (x.tools[0].id = "../etc/passwd"), "id inválido"],
    [(x) => (x.timeline.points[0].byTool["C:\\x"] = { sessions: 1, userMessages: 1, tokens: 1 }), "id inválido"],
    [(x) => (x.period.from = "ontem"), "data"],
    [(x) => (x.timeline.points[0].date = "2026-02-31"), "data"],
    [(x) => (x.totals.sessions = -1), "inteiro"],
    [(x) => (x.totals.sessions = "10"), "inteiro"],
    [(x) => (x.totals.tokens.total += 1), "soma"],
    [(x) => (x.generatedAt = "hoje às 10h"), "generatedAt"],
  ];
  for (const [mut, trecho] of casos) {
    const c = clone(m);
    mut(c);
    recusa(c, trecho);
  }
});

test("schema: exigirMetricasValidas lança com a lista de problemas", async () => {
  const m = await metricasSinteticas();
  m.extra = 1;
  assert.throws(() => exigirMetricasValidas(m), /allowlist estrita[\s\S]*\$\.extra/);
});
