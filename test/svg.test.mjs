import assert from "node:assert/strict";
import { test } from "node:test";
import { esc, gerarSvg } from "../src/svg.mjs";
import { metricasSinteticas } from "./sintetico.mjs";

test("svg: autocontido, sem script, fonte, imagem ou link externo", async () => {
  const svg = gerarSvg(await metricasSinteticas());
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  const proibidos = [/<script/i, /<image/i, /<foreignObject/i, /<a[\s>]/i, /href=/i, /url\(/i, /@import/i, /@font-face/i, /\son\w+=/i];
  for (const p of proibidos) assert.doesNotMatch(svg, p, String(p));
  const urls = svg.match(/https?:\/\/[^"'\s<)]*/g) ?? [];
  assert.deepEqual(urls, ["http://www.w3.org/2000/svg"]);
});

test("svg: escapa XML em título e em nomes vindos dos dados", async () => {
  const m = await metricasSinteticas();
  m.projects[0].name = `a<b>&"c'`; // mesmo que um JSON inválido chegasse aqui, o texto é escapado
  const svg = gerarSvg(m, { titulo: `<script>alert(1)</script> & "x"` });
  assert.ok(!svg.includes("<script"));
  assert.ok(svg.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;"));
  assert.ok(svg.includes("a&lt;b&gt;&amp;&quot;c&apos;"));
  assert.equal(esc("a\u0001b\u0000c"), "abc");
});

test("svg: temas auto, light e dark", async () => {
  const m = await metricasSinteticas();
  const auto = gerarSvg(m, { tema: "auto" });
  assert.ok(auto.includes("prefers-color-scheme: dark"));
  assert.ok(auto.includes("#ffffff") && auto.includes("#0d1117"));
  const claro = gerarSvg(m, { tema: "light" });
  assert.ok(!claro.includes("prefers-color-scheme") && !claro.includes("#0d1117"));
  const escuro = gerarSvg(m, { tema: "dark" });
  assert.ok(!escuro.includes("prefers-color-scheme") && escuro.includes("#0d1117") && !escuro.includes("#f6f8fa"));
  assert.equal(gerarSvg(m, { tema: "invalido" }), auto);
});

test("svg: título configurável, nada fixo de autor, idiomas e determinismo", async () => {
  const m = await metricasSinteticas();
  const a = gerarSvg(m, { titulo: "Minha IA" });
  assert.ok(a.includes('<title id="ttl">Minha IA</title>'));
  assert.ok(gerarSvg(m).includes("AI usage"));
  assert.ok(gerarSvg(m, { idioma: "pt-BR" }).includes("Uso de IA"));
  assert.equal(gerarSvg(m, { titulo: "X" }), gerarSvg(m, { titulo: "X" }));
  for (const fixo of [/github/i, /\w@\w/]) assert.doesNotMatch(a, fixo); // nada de usuário/URL embutido
});

test("svg: JSON sem atividade não quebra", async () => {
  const m = await metricasSinteticas();
  m.period = null;
  m.projects = [];
  m.timeline.points = [];
  m.tools = [];
  const svg = gerarSvg(m);
  assert.ok(svg.includes("no data") && svg.includes("No projects"));
});
