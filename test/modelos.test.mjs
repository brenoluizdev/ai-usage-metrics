// Testes dos 3 modelos de SVG, das cores personalizadas e da publicação dos 5 arquivos. Dados 100% sintéticos, sem rede.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { main } from "../src/cli.mjs";
import { caminhos, normalizarConfig } from "../src/config.mjs";
import { escalaCalor, misturar, normalizarHex, validarCores } from "../src/cores.mjs";
import { MODELOS, gerarSvg, niveisPorQuantil } from "../src/svg.mjs";
import { metricasSinteticas } from "./sintetico.mjs";

// Isola o git do computador de quem roda o teste (mesmo esquema de publish.test.mjs).
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(tmpdir(), "ai-usage-metrics-sem-config"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Teste",
  GIT_AUTHOR_EMAIL: "teste@exemplo.invalid",
  GIT_COMMITTER_NAME: "Teste",
  GIT_COMMITTER_EMAIL: "teste@exemplo.invalid",
  GIT_TERMINAL_PROMPT: "0",
  AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE: "1",
});

const pastas = [];
after(async () => {
  for (const p of pastas) await rm(p, { recursive: true, force: true });
});

const PROIBIDOS = [/<script/i, /<image/i, /<foreignObject/i, /<a[\s>]/i, /href=/i, /url\(/i, /@import/i, /@font-face/i, /\son\w+=/i, /javascript:/i];
const semRecursoExterno = (svg) => {
  for (const p of PROIBIDOS) assert.doesNotMatch(svg, p, String(p));
  assert.deepEqual(svg.match(/https?:\/\/[^"'\s<)]*/g) ?? [], ["http://www.w3.org/2000/svg"]);
};
const dimensoes = (svg) => {
  const m = /^<svg [^>]*width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  assert.ok(m, "width/height/viewBox declarados");
  assert.deepEqual([m[1], m[2]], [m[3], m[4]]);
  return { w: Number(m[1]), h: Number(m[2]) };
};
const celulas = (svg) => [...svg.matchAll(/<title>(\d{4}-\d{2}-\d{2}): (\d+) sessions?<\/title>/g)].map((x) => ({ data: x[1], n: Number(x[2]) }));
const hex = /^#[0-9a-f]{6}$/;

/** Metricas sintéticas com a série diária (e o instante de geração) trocados. */
async function comPontos(pontos, generatedAt = "2026-03-10T12:00:00Z") {
  const m = await metricasSinteticas();
  m.timeline.points = pontos.map(([date, sessions]) => ({ date, sessions, userMessages: sessions, assistantMessages: sessions, tokens: 0, byTool: { "claude-code": { sessions, userMessages: sessions, tokens: 0 } } }));
  m.generatedAt = generatedAt;
  return m;
}

// ---------- modelos: estrutura, tamanho, autocontido, escape ----------

for (const modelo of MODELOS) {
  for (const tema of ["auto", "light", "dark"]) {
    test(`${modelo}/${tema}: autocontido, tamanho fixo declarado, textos presentes`, async () => {
      const m = await metricasSinteticas();
      const svg = gerarSvg(m, { modelo, tema });
      assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      semRecursoExterno(svg);
      const { w, h } = dimensoes(svg);
      assert.ok(svg.includes('<title id="ttl">'));
      assert.ok(svg.includes("<desc id="));
      if (modelo === "model-1") assert.deepEqual([w, h], [840, 440]);
      if (modelo === "model-2") assert.equal(w, 420);
      if (modelo === "model-3") assert.equal(h, 262);
      assert.equal(svg.includes("prefers-color-scheme: dark"), tema === "auto");
      assert.equal(gerarSvg(m, { modelo, tema }), svg, "determinístico");
      assert.ok(gerarSvg(m, { modelo, idioma: "pt-BR" }).includes("Uso de IA"));
    });
  }

  test(`${modelo}: nomes hostis (título, ferramenta, projeto) saem escapados`, async () => {
    const m = await metricasSinteticas();
    const hostil = `a<b>&"c'</text><script>alert(1)</script>`;
    m.projects[0].name = hostil;
    m.tools[0].name = hostil;
    const svg = gerarSvg(m, { modelo, titulo: hostil });
    assert.doesNotMatch(svg, /<script/i);
    assert.doesNotMatch(svg, /<\/text><script/);
    semRecursoExterno(svg);
    assert.ok(svg.includes("&lt;script&gt;") || modelo === "model-3" || modelo === "model-2");
    // o único "<script" possível seria cru; o texto hostil só aparece com < e > escapados
    assert.equal((svg.match(/<(?!\/?(?:svg|title|desc|style|rect|text|line|path)\b)[^>]*>/g) ?? []).length, 0);
  });
}

test("model-2: cabe em ~420 px e mostra os 4 números, a barra por ferramenta e a legenda com porcentagem", async () => {
  const m = await metricasSinteticas();
  const svg = gerarSvg(m, { modelo: "model-2" });
  assert.equal(dimensoes(svg).w, 420);
  assert.ok(svg.includes("Sessions by tool"));
  for (const t of m.tools) assert.ok(svg.includes(t.name.split(" (")[0]));
  assert.match(svg, /\d+% *<\/text>|· \d+%/);
  const total = m.tools.reduce((s, t) => s + t.sessions, 0);
  assert.ok(total > 0);
  // sem dados
  m.tools = [];
  m.period = null;
  const vazio = gerarSvg(m, { modelo: "model-2" });
  assert.ok(vazio.includes("no data"));
  semRecursoExterno(vazio);
});

test("model-1 sem cores personalizadas é idêntico ao painel de sempre (impressão digital do SVG da fixture)", async () => {
  const m = await metricasSinteticas();
  const svg = gerarSvg(m);
  assert.equal(svg, gerarSvg(m, { modelo: "model-1" }));
  assert.doesNotMatch(svg, /--accent|--h0|var\(--t\d/);
  assert.ok(svg.includes("fill=\"#d97757\""));
  // Valor calculado com a versão anterior ao recurso de modelos (ff7c8b1): a saída do model-1 não pode mudar.
  assert.equal(createHash("sha256").update(svg).digest("hex"), HASH_MODEL1_PADRAO);
});
const HASH_MODEL1_PADRAO = "496c419b21cd627c6eff9568d52d60bd79290fa6e119c812355d6766f87f8e46";

// ---------- model-3: calendário ----------

test("model-3: 53 colunas, domingo primeiro, <title> com data e contagem em cada célula, rótulos e legenda", async () => {
  const m = await metricasSinteticas();
  const svg = gerarSvg(m, { modelo: "model-3" });
  const cs = celulas(svg);
  assert.ok(cs.length > 52 * 7 && cs.length <= 53 * 7);
  assert.equal(cs[0].data.length, 10);
  assert.equal(new Date(`${cs[0].data}T00:00:00Z`).getUTCDay(), 0, "a primeira célula é um domingo");
  assert.equal(cs.at(-1).data, "2026-03-10", "a última célula é o fim do período (data de geração)");
  for (let i = 1; i < cs.length; i++) assert.ok(cs[i].data > cs[i - 1].data, "datas crescentes, sem repetição");
  const soma = cs.reduce((s, c) => s + c.n, 0);
  assert.ok(svg.includes(`${soma} sessions · `));
  assert.ok(svg.includes(`${cs.filter((c) => c.n > 0).length} active days`));
  for (const rotulo of ["Mon", "Wed", "Fri", "Less", "More", "Mar"]) assert.ok(svg.includes(`>${rotulo}</text>`), rotulo);
  assert.equal((svg.match(/fill="var\(--h[0-4]\)"/g) ?? []).length, cs.length + 5, "células + 5 quadrados da legenda");
  for (let i = 0; i < 5; i++) assert.match(svg, new RegExp(`--h${i}:#[0-9a-f]{6};`));
  assert.ok(gerarSvg(m, { modelo: "model-3", idioma: "pt-BR" }).includes("sessões"));
  assert.ok(gerarSvg(m, { modelo: "model-3", idioma: "pt-BR" }).includes(">seg</text>"));
});

test("model-3: série vazia, 1 dia, valores iguais, menos de uma semana e mais de 53 semanas", async () => {
  // vazia
  const vazio = gerarSvg(await comPontos([]), { modelo: "model-3" });
  assert.ok(celulas(vazio).every((c) => c.n === 0));
  assert.ok(vazio.includes("0 sessions · 0 active days"));
  semRecursoExterno(vazio);

  // 1 dia só
  const um = gerarSvg(await comPontos([["2026-03-09", 4]]), { modelo: "model-3" });
  assert.deepEqual(celulas(um).filter((c) => c.n > 0), [{ data: "2026-03-09", n: 4 }]);
  assert.ok(um.includes("4 sessions · 1 active day ·"));
  assert.equal((um.match(/fill="var\(--h4\)"/g) ?? []).length, 1 + 1, "o único dia ativo vira nível 4 (mais a legenda)");

  // todos os dias com o mesmo valor: tudo nível 4, nada de nível 1 a 3 nas células
  const iguais = gerarSvg(await comPontos([["2026-03-05", 3], ["2026-03-06", 3], ["2026-03-09", 3]]), { modelo: "model-3" });
  assert.equal((iguais.match(/fill="var\(--h4\)"/g) ?? []).length, 3 + 1);
  assert.equal((iguais.match(/fill="var\(--h1\)"/g) ?? []).length, 1, "só o quadrado da legenda");

  // período menor que uma semana: 3 dias seguidos, ainda 53 colunas (as células antes dos dados são nível 0)
  const curto = gerarSvg(await comPontos([["2026-03-08", 1], ["2026-03-09", 2], ["2026-03-10", 9]]), { modelo: "model-3" });
  const cc = celulas(curto);
  assert.equal(cc.at(-1).data, "2026-03-10");
  assert.deepEqual(cc.filter((c) => c.n > 0).map((c) => c.n), [1, 2, 9]);

  // mais de 53 semanas: o que é mais antigo que a janela fica de fora, inclusive dos totais
  const longo = gerarSvg(await comPontos([["2024-01-01", 50], ["2025-01-01", 7], ["2026-03-09", 2]]), { modelo: "model-3" });
  const cl = celulas(longo);
  assert.ok(!cl.some((c) => c.data === "2024-01-01"));
  assert.ok(!cl.some((c) => c.data === "2025-01-01"), "2025-01-01 já caiu fora das 53 semanas que terminam em 2026-03-10");
  assert.ok(longo.includes("2 sessions · 1 active day"));
  assert.ok(cl.length <= 53 * 7);

  // dia dentro da janela, perto do começo, aparece
  const noLimite = gerarSvg(await comPontos([["2025-03-30", 5], ["2026-03-09", 2]]), { modelo: "model-3" });
  assert.ok(celulas(noLimite).some((c) => c.data === "2025-03-30" && c.n === 5));
});

test("model-3: níveis por quantis dos dias ativos (0 = sem atividade, 1-4 pelos quartis)", () => {
  const n = niveisPorQuantil([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(n), [0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.deepEqual([0, 1, 5].map(niveisPorQuantil([5])), [0, 4, 4]);
  assert.deepEqual([0, 3].map(niveisPorQuantil([3, 3, 3])), [0, 4]);
  assert.equal(niveisPorQuantil([])(0), 0);
  const empatado = niveisPorQuantil([1, 1, 1, 1, 2, 3, 8]);
  assert.deepEqual([1, 2, 3, 8].map(empatado), [1, 3, 3, 4]);
  for (let v = 1; v < 20; v++) assert.ok([1, 2, 3, 4].includes(niveisPorQuantil([1, 5, 9, 14])(v)));
});

// ---------- cores: validação estrita ----------

const IDS = ["claude-code", "cline", "chatgpt"];
const INVALIDAS = [
  "red", "blue", "transparent", "currentColor", "rgb(1,2,3)", "rgba(0,0,0,.5)", "hsl(0,0%,0%)", "var(--x)", "url(#a)", "url(javascript:alert(1))",
  "#fff;", "#fff}", "#fff;}</style><script>alert(1)</script>", "red;}</style><script>", '#fff"/><script', "#fff'/><script", "#fff/*", "/*#fff*/", "#fff */",
  "#ffff", "#ff", "#fffff", "#fffffff", "#ffffffff", "#ggg", "#12345g", "fff", "ffffff", "# fff", " #fff", "#fff ", "#fff\n", "\n#fff", "#fff\u0000", "#fff !important",
  "#fff<", "<#fff>", "#fff&amp;", "", " ", "#", "0xfff", "#FFF\\", "#ﬀf", "＃fff", null, undefined, 0, 1, 16777215, true, false, [], ["#fff"], {}, { a: 1 },
];

test("cores: aceita #rgb e #rrggbb (maiúsculas e minúsculas) e normaliza para #rrggbb minúsculo", () => {
  assert.equal(normalizarHex("#FFF"), "#ffffff");
  assert.equal(normalizarHex("#aBc"), "#aabbcc");
  assert.equal(normalizarHex("#A1B2C3"), "#a1b2c3");
  assert.equal(normalizarHex("#000000"), "#000000");
  const ok = validarCores({ background: "#ABC", card: "#112233", border: "#fff", text: "#000", muted: "#7f7F7f", track: "#123", accent: "#22C55E", tools: { cline: "#0F0" } }, IDS);
  assert.equal(ok.background, "#aabbcc");
  assert.equal(ok.accent, "#22c55e");
  assert.equal(ok.tools.cline, "#00ff00");
  assert.deepEqual(validarCores({}, IDS), {});
});

for (const chave of ["background", "card", "border", "text", "muted", "track", "accent"]) {
  test(`cores: ${chave} recusa tudo que não é #rgb/#rrggbb (injeção, comentários, funções, tipos errados)`, () => {
    for (const ruim of INVALIDAS) {
      assert.throws(() => validarCores({ [chave]: ruim }, IDS), /colors\.|esperado|inválida/, `${chave}=${JSON.stringify(ruim)}`);
      assert.throws(() => validarCores({ [chave]: ruim }, IDS, "colorsDark"), /colorsDark/, `colorsDark.${chave}`);
    }
  });
}

test("cores: tools recusa valor inválido, id inexistente, id herdado e formato errado", () => {
  for (const ruim of INVALIDAS) assert.throws(() => validarCores({ tools: { cline: ruim } }, IDS), /colors\.tools/, JSON.stringify(ruim));
  for (const id of ["nao-existe", "Claude-Code", "constructor", "__proto__", "toString", "", "cline;}", "claude-code\n"]) {
    assert.throws(() => validarCores({ tools: JSON.parse(`{${JSON.stringify(id)}: "#fff"}`) }, IDS), /ferramenta desconhecida/, id);
  }
  for (const ruim of [null, "#fff", [], ["cline"], 1, true]) assert.throws(() => validarCores({ tools: ruim }, IDS), /tools/);
});

test("cores: chave desconhecida e raiz que não é objeto são recusadas", () => {
  for (const k of ["fill", "color", "font", "fontSize", "radius", "bg", "Background", "__proto__", "constructor", "tools ", "foreground"]) {
    assert.throws(() => validarCores(JSON.parse(`{${JSON.stringify(k)}: "#fff"}`), IDS), /chave desconhecida/, k);
  }
  for (const raiz of [null, undefined, "#fff", 1, true, [], ["#fff"]]) assert.throws(() => validarCores(raiz, IDS), /esperado um objeto/);
});

test("cores: a configuração recusa as mesmas coisas em colors, colorsDark e tools, com mensagem clara", () => {
  const base = { githubUser: "fulano" };
  assert.doesNotThrow(() => normalizarConfig({ ...base, model: "model-3", colors: { accent: "#22c55e", tools: { cline: "#fff" } }, colorsDark: { background: "#1a1033" } }));
  for (const ruim of INVALIDAS.filter((x) => typeof x === "string" || x === null || typeof x === "number")) {
    assert.throws(() => normalizarConfig({ ...base, colors: { accent: ruim } }), /Configuração: colors\.accent/, JSON.stringify(ruim));
    assert.throws(() => normalizarConfig({ ...base, colorsDark: { text: ruim } }), /Configuração: colorsDark\.text/, JSON.stringify(ruim));
    assert.throws(() => normalizarConfig({ ...base, colors: { tools: { "claude-code": ruim } } }), /Configuração: colors\.tools\.claude-code/, JSON.stringify(ruim));
  }
  assert.throws(() => normalizarConfig({ ...base, colors: { tools: { "nao-existe": "#fff" } } }), /ferramenta desconhecida/);
  assert.throws(() => normalizarConfig({ ...base, colorsDark: { foo: "#fff" } }), /colorsDark: chave desconhecida/);
  assert.throws(() => normalizarConfig({ ...base, colors: "#fff" }), /colors: esperado um objeto/);
  assert.throws(() => normalizarConfig({ ...base, model: "model-9" }), /model deve ser model-1\|model-2\|model-3/);
  assert.throws(() => normalizarConfig({ ...base, cores: {} }), /chave desconhecida "cores"/);
  assert.throws(() => normalizarConfig({ ...base, fontSize: 10 }), /chave desconhecida/);
  // a configuração guarda o valor normalizado
  assert.equal(normalizarConfig({ ...base, colors: { accent: "#ABC" } }).colors.accent, "#aabbcc");
});

test("cores: o renderizador valida de novo (defesa em profundidade) e nada hostil chega ao SVG", async () => {
  const m = await metricasSinteticas();
  const hostis = ["red;}</style><script>alert(1)</script>", "url(javascript:alert(1))", '#fff"/><script>x</script>', "#fff/*", "/*", "#fff}", "var(--bg)", "#fff !important", "red"];
  for (const modelo of MODELOS) {
    for (const h of hostis) {
      assert.throws(() => gerarSvg(m, { modelo, cores: { background: h } }), /colors\.background/, h);
      assert.throws(() => gerarSvg(m, { modelo, coresEscuro: { accent: h } }), /colorsDark\.accent/, h);
      assert.throws(() => gerarSvg(m, { modelo, cores: { tools: { cline: h } } }), /colors\.tools\.cline/, h);
    }
    assert.throws(() => gerarSvg(m, { modelo, cores: { tools: { "nao-existe": "#fff" } } }), /ferramenta desconhecida/);
    assert.throws(() => gerarSvg(m, { modelo, cores: { fill: "#fff" } }), /chave desconhecida/);
    const svg = gerarSvg(m, { modelo, cores: { background: "#AbC", accent: "#F00" } });
    assert.doesNotMatch(svg, /#AbC|#F00/);
    assert.ok(svg.includes("#aabbcc") && svg.includes("#ff0000"));
    semRecursoExterno(svg);
  }
  assert.throws(() => gerarSvg(m, { modelo: "model-7" }), /modelo inválido/);
});

test("cores: todo valor de cor no SVG é hexadecimal #rrggbb (inclusive a escala de calor derivada)", async () => {
  const m = await metricasSinteticas();
  const svg = gerarSvg(m, { modelo: "model-3", cores: { background: "#123", accent: "#4ade80", tools: { cline: "#f0f" } }, tema: "light" });
  const decl = [...svg.matchAll(/--(?:bg|card|line|fg|muted|track|accent|h\d|t\d):([^;]*);/g)].map((x) => x[1]);
  assert.ok(decl.length >= 14);
  for (const v of decl) assert.match(v, hex);
  assert.ok(svg.includes("--bg:#112233;"));
  const e = escalaCalor("#112233", "#4ade80");
  assert.equal(e.length, 5);
  for (const c of e) assert.match(c, hex);
  assert.equal(misturar("#000000", "#ffffff", 0), "#000000");
  assert.equal(misturar("#000000", "#ffffff", 1), "#ffffff");
  assert.equal(misturar("#000000", "#ffffff", 0.5), "#808080");
});

// ---------- cores x tema ----------

test("temas com cores: colors vale para o claro e, no auto sem colorsDark, para o escuro; colorsDark só no escuro", async () => {
  const m = await metricasSinteticas();
  const c = { background: "#ff00ff", accent: "#00ff00" };
  const cd = { background: "#0000ff", accent: "#ffff00" };
  const bg = (svg) => [...svg.matchAll(/--bg:(#[0-9a-f]{6});/g)].map((x) => x[1]);

  // auto sem colorsDark: as duas faixas usam colors (o escuro parte do padrão escuro e recebe os mesmos valores)
  assert.deepEqual(bg(gerarSvg(m, { tema: "auto", cores: c })), ["#ff00ff", "#ff00ff"]);
  // auto com colorsDark: claro = colors, escuro = colorsDark
  assert.deepEqual(bg(gerarSvg(m, { tema: "auto", cores: c, coresEscuro: cd })), ["#ff00ff", "#0000ff"]);
  // auto só com colorsDark: claro continua o padrão
  assert.deepEqual(bg(gerarSvg(m, { tema: "auto", coresEscuro: cd })), ["#ffffff", "#0000ff"]);
  // light: só colors (colorsDark é ignorado e nem aparece)
  const claro = gerarSvg(m, { tema: "light", cores: c, coresEscuro: cd });
  assert.deepEqual(bg(claro), ["#ff00ff"]);
  assert.doesNotMatch(claro, /#0000ff|#ffff00|prefers-color-scheme/);
  // dark: colorsDark; sem ele, colors
  assert.deepEqual(bg(gerarSvg(m, { tema: "dark", cores: c, coresEscuro: cd })), ["#0000ff"]);
  assert.deepEqual(bg(gerarSvg(m, { tema: "dark", cores: c })), ["#ff00ff"]);
  // chaves não informadas mantêm o padrão do tema
  assert.ok(gerarSvg(m, { tema: "dark", coresEscuro: cd }).includes("--card:#161b22;"));
  assert.ok(gerarSvg(m, { tema: "light", cores: c }).includes("--card:#f6f8fa;"));
  // cores de ferramenta: variáveis diferentes no claro e no escuro
  const ferr = gerarSvg(m, { tema: "auto", cores: { tools: { "claude-code": "#111111" } }, coresEscuro: { tools: { "claude-code": "#eeeeee" } } });
  assert.match(ferr, /--t0:#111111;/);
  assert.match(ferr, /--t0:#eeeeee;/);
  assert.match(ferr, /fill="var\(--t0\)"/);
  // objetos de cores vazios não mudam nada
  assert.equal(gerarSvg(m, { cores: {}, coresEscuro: {} }), gerarSvg(m));
});

// ---------- CLI: render, init, publish ----------

async function ambienteCli({ initExtra = [] } = {}) {
  const raiz = await mkdtemp(join(tmpdir(), "ai-usage-metrics-teste-"));
  pastas.push(raiz);
  const remoto = join(raiz, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remoto], { env: process.env });
  const stateDir = join(raiz, "estado");
  const paths = caminhos(stateDir);
  const saidas = [];
  const out = (l) => saidas.push(l);
  const io = { isTTY: false, async ask() { return "n"; } };
  const cmd = (args, ioLocal = io) => main([...args, "--state-dir", stateDir], out, ioLocal);
  await cmd(["init", "--user", "fulano", "--remote", remoto, "--public", "meu-site", "--title", "Meu painel", ...initExtra]);
  return { raiz, remoto, stateDir, paths, saidas, cmd, texto: () => saidas.join("\n") };
}
const gravarJson = async (paths, json) => {
  await mkdir(paths.saida, { recursive: true });
  await writeFile(paths.json, JSON.stringify(json, null, 2) + "\n", "utf8");
};
const gitRemoto = (remoto, ...args) => execFileSync("git", [`--git-dir=${remoto}`, ...args], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "ignore"] }).trim();
const CINCO = ["metrics.json", "metrics.model-1.svg", "metrics.model-2.svg", "metrics.model-3.svg", "metrics.svg"];
const COLORS = '{"accent":"#22C55E","tools":{"claude-code":"#a78bfa"}}';
const COLORS_DARK = '{"background":"#1a1033","card":"#241747","text":"#f3e8ff"}';

test("init: grava model/colors só se passados; imprime exemplo de colors e as URLs dos 4 arquivos; chave desconhecida é recusada", async () => {
  const a = await ambienteCli();
  const padrao = JSON.parse(await readFile(a.paths.config, "utf8"));
  assert.equal(padrao.colors, undefined);
  assert.equal(padrao.colorsDark, undefined);
  assert.equal(padrao.model, undefined, "sem --model, nada é gravado (o padrão é model-1)");
  const t = a.texto();
  assert.match(t, /"colors": \{ "accent"/);
  for (const arq of ["metrics.svg", "metrics.model-1.svg", "metrics.model-2.svg", "metrics.model-3.svg"]) assert.ok(t.includes(`/ai-metrics/main/${arq}`), arq);

  const b = await ambienteCli({ initExtra: ["--model", "model-3", "--colors", COLORS, "--colors-dark", COLORS_DARK] });
  const cfg = JSON.parse(await readFile(b.paths.config, "utf8"));
  assert.equal(cfg.model, "model-3");
  assert.deepEqual(cfg.colors, { accent: "#22c55e", tools: { "claude-code": "#a78bfa" } });
  assert.equal(cfg.colorsDark.background, "#1a1033");

  await assert.rejects(a.cmd(["init", "--user", "fulano", "--overwrite", "--model", "model-9"]), /model deve ser/);
  await assert.rejects(a.cmd(["init", "--user", "fulano", "--overwrite", "--colors", '{"accent":"red"}']), /colors\.accent/);
  await assert.rejects(a.cmd(["init", "--user", "fulano", "--overwrite", "--colors", "{ruim"]), /--colors deve ser um JSON/);
  await writeFile(a.paths.config, JSON.stringify({ ...padrao, fonte: "Comic" }), "utf8");
  await assert.rejects(a.cmd(["render"]), /chave desconhecida "fonte"/);
});

test("render: por padrão grava metrics.svg (model da config) e os 3 metrics.model-N.svg com as mesmas cores", async () => {
  const a = await ambienteCli({ initExtra: ["--model", "model-2", "--colors", COLORS, "--theme", "light"] });
  await gravarJson(a.paths, await metricasSinteticas());
  await a.cmd(["render"]);
  const nomes = (await readdir(a.paths.saida)).sort();
  assert.deepEqual(nomes, ["metrics.json", "metrics.model-1.svg", "metrics.model-2.svg", "metrics.model-3.svg", "metrics.svg"]);
  const principal = await readFile(a.paths.svg, "utf8");
  const m2 = await readFile(a.paths.svgsModelos[1], "utf8");
  assert.equal(principal, m2, "metrics.svg é o model-2 da configuração");
  for (const arq of a.paths.svgsModelos) {
    const svg = await readFile(arq, "utf8");
    assert.ok(svg.includes("--accent:#22c55e;"), "mesmas cores em todos");
    semRecursoExterno(svg);
  }
  assert.equal(dimensoes(await readFile(a.paths.svgsModelos[0], "utf8")).w, 840);
  assert.equal(dimensoes(principal).w, 420);

  // --model sobrepõe a configuração
  await a.cmd(["render", "--model", "model-3"]);
  assert.equal(await readFile(a.paths.svg, "utf8"), await readFile(a.paths.svgsModelos[2], "utf8"));
  await assert.rejects(a.cmd(["render", "--model", "model-8"]), /--model deve ser/);
});

test("render --out grava só aquele arquivo; --out-dir grava o conjunto numa pasta; os dois juntos são recusados", async () => {
  const a = await ambienteCli();
  await gravarJson(a.paths, await metricasSinteticas());
  const alvo = join(a.raiz, "so-um.svg");
  await a.cmd(["render", "--out", alvo, "--model", "model-3"]);
  assert.ok(existsSync(alvo));
  assert.ok(!existsSync(a.paths.svg), "nada além do arquivo pedido");
  assert.match(await readFile(alvo, "utf8"), /--h4:/);

  const pasta = join(a.raiz, "conjunto");
  await a.cmd(["render", "--out-dir", pasta]);
  assert.deepEqual((await readdir(pasta)).sort(), ["metrics.model-1.svg", "metrics.model-2.svg", "metrics.model-3.svg", "metrics.svg"]);
  await assert.rejects(a.cmd(["render", "--out", alvo, "--out-dir", pasta]), /--out .* OU --out-dir/);
});

test("render: JSON adulterado (campo extra / caminho) é recusado antes de gerar qualquer SVG", async () => {
  const a = await ambienteCli();
  const m = await metricasSinteticas();
  m.projects[0].name = "C:/Users/fulano/projeto";
  await gravarJson(a.paths, m);
  await assert.rejects(a.cmd(["render"]));
  assert.ok(!existsSync(a.paths.svg));
});

test("publish: dry-run lista os 5 arquivos; --yes envia exatamente os 5 (planos, sem subpastas), regerados e com as cores", async () => {
  const a = await ambienteCli({ initExtra: ["--model", "model-3", "--colors", COLORS, "--colors-dark", COLORS_DARK] });
  await gravarJson(a.paths, await metricasSinteticas());
  // um SVG qualquer no disco NÃO é enviado: o publish regera tudo a partir do JSON validado
  await writeFile(a.paths.svg, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf8");

  await a.cmd(["publish"]);
  const t = a.texto();
  for (const nome of CINCO) assert.ok(t.includes(`- ${nome} `), nome);
  assert.match(t, /somente esses 5 arquivos/);
  assert.match(t, /\[novo: \+\d+ -0 linhas\]/);
  assert.equal(gitRemoto(a.remoto, "for-each-ref"), "", "dry-run não envia");

  await a.cmd(["publish", "--yes"], { isTTY: true, ask: async () => assert.fail("não deveria perguntar") });
  const arquivos = gitRemoto(a.remoto, "ls-tree", "-r", "--name-only", "main").split("\n").sort();
  assert.deepEqual(arquivos, CINCO, "nada fora da allowlist e nenhuma subpasta");
  const lerRemoto = (nome) => gitRemoto(a.remoto, "show", `main:${nome}`);
  assert.doesNotMatch(lerRemoto("metrics.svg"), /<script/);
  assert.equal(lerRemoto("metrics.svg"), lerRemoto("metrics.model-3.svg"), "metrics.svg = model da configuração");
  assert.equal(dimensoes(lerRemoto("metrics.model-1.svg")).w, 840);
  assert.equal(dimensoes(lerRemoto("metrics.model-2.svg")).w, 420);
  for (const nome of CINCO.filter((n) => n.endsWith(".svg"))) {
    const svg = lerRemoto(nome);
    semRecursoExterno(svg);
    assert.ok(svg.includes("--accent:#22c55e;"), `${nome}: cores do usuário`);
    assert.ok(svg.includes("--bg:#1a1033;"), `${nome}: colorsDark no escuro`);
  }
  assert.deepEqual(gitRemoto(a.remoto, "log", "--format=%s", "main").split("\n"), ["chore(metrics): update AI usage metrics"]);

  // publicar de novo o mesmo conteúdo não cria commit
  await a.cmd(["publish", "--yes"]);
  assert.equal(gitRemoto(a.remoto, "log", "--format=%s", "main").split("\n").length, 1);
});

test("publish: JSON e SVGs publicados não contêm caminho, e-mail nem o usuário do sistema operacional", async () => {
  const a = await ambienteCli({ initExtra: ["--colors", COLORS] });
  await gravarJson(a.paths, await metricasSinteticas());
  await a.cmd(["publish", "--yes"]);
  const so = userInfo().username.toLowerCase();
  for (const nome of CINCO) {
    const txt = gitRemoto(a.remoto, "show", `main:${nome}`);
    const baixo = txt.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, "").toLowerCase().replaceAll("\\", "/");
    assert.doesNotMatch(baixo, /[a-z]:\//, `${nome}: caminho de disco`);
    assert.doesNotMatch(baixo, /\/users\/|\/home\//, `${nome}: caminho de usuário`);
    assert.doesNotMatch(txt, /[\w.+-]+@[\w-]+\.[\w.-]+/, `${nome}: e-mail`);
    assert.ok(!baixo.includes(homedir().replaceAll("\\", "/").toLowerCase()), `${nome}: pasta pessoal`);
    if (so.length >= 4) assert.ok(!baixo.includes(so), `${nome}: usuário do SO`);
  }
});

test("publish: config com cor inválida é recusada antes de qualquer envio; SVG com vazamento nunca é gravado", async () => {
  const a = await ambienteCli();
  await gravarJson(a.paths, await metricasSinteticas());
  const cfg = JSON.parse(await readFile(a.paths.config, "utf8"));
  await writeFile(a.paths.config, JSON.stringify({ ...cfg, colors: { accent: "red;}</style><script>" } }), "utf8");
  await assert.rejects(a.cmd(["publish", "--yes"]), /Configuração inválida.*colors\.accent/s);
  assert.equal(gitRemoto(a.remoto, "for-each-ref"), "");
});
