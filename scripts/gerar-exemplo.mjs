// Gera o JSON e o SVG SINTÉTICOS de exemplo (números inventados, PRNG fixo) em examples/.
// Uso: npm run exemplo
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate } from "../src/aggregate.mjs";
import { toPublic } from "../src/public.mjs";
import { exigirMetricasValidas } from "../src/schema.mjs";
import { gerarSvg } from "../src/svg.mjs";

const HOME = "/home/exemplo";
let semente = 20260101;
const rnd = () => ((semente = (semente * 1664525 + 1013904223) % 4294967296) / 4294967296);

const projetos = [
  { nome: "meu-site", peso: 10, tool: ["claude-code", "claude-code", "cline"] },
  { nome: "app-de-tarefas", peso: 6, tool: ["claude-code", "cline"] },
  { nome: "api-de-pagamentos", peso: 4, tool: ["claude-code"] },
  { nome: "bot-do-discord", peso: 2, tool: ["cline"] },
  { nome: "estudos", peso: 1, tool: ["claude-code"] },
  { nome: "segredo-a", peso: 3, tool: ["claude-code"] },
  { nome: "segredo-b", peso: 1, tool: ["cline"] },
];

const eventos = [];
let n = 0;
const inicio = Date.parse("2026-01-05T09:00:00Z");
for (let d = 0; d < 150; d++) {
  const dia = inicio + d * 86_400_000;
  const fimDeSemana = [0, 6].includes(new Date(dia).getUTCDay());
  for (const p of projetos) {
    if (rnd() > (fimDeSemana ? 0.15 : 0.35) * (p.peso / 6 + 0.4)) continue;
    const tool = p.tool[Math.floor(rnd() * p.tool.length)];
    const sessao = `s${++n}`;
    const prompts = 2 + Math.floor(rnd() * 8 * (p.peso / 4 + 0.5));
    for (let i = 0; i < prompts; i++) {
      const ts = dia + i * 300_000;
      eventos.push({ tool, project: `${HOME}/dev/${p.nome}`, session: sessao, ts, kind: "user" });
      for (let r = 0; r < 3; r++) {
        eventos.push({
          tool,
          project: `${HOME}/dev/${p.nome}`,
          session: sessao,
          ts: ts + 20_000 * (r + 1),
          kind: "assistant",
          tokens: { input: 50 + Math.floor(rnd() * 400), output: 200 + Math.floor(rnd() * 1500), cacheRead: Math.floor(rnd() * 90_000), cacheWrite: Math.floor(rnd() * 8_000) },
        });
      }
    }
  }
  if (rnd() < 0.2) eventos.push({ tool: "chatgpt", project: null, session: `c${++n}`, ts: dia + 3_600_000, kind: "session" });
}

const meta = [
  { id: "claude-code", name: "Claude Code", capabilities: { messages: true, tokens: true, projects: true } },
  { id: "cline", name: "Cline (CLI)", capabilities: { messages: true, tokens: true, projects: true } },
  { id: "chatgpt", name: "ChatGPT (catálogo do app desktop)", capabilities: { messages: false, tokens: false, projects: false } },
];
const agg = await aggregate(eventos, { home: HOME, tools: meta });
const allow = new Map([
  ["meu-site", "meu-site"],
  ["app-de-tarefas", "app-de-tarefas"],
  ["api-de-pagamentos", "api-de-pagamentos"],
  ["bot-do-discord", "bot-do-discord"],
  ["estudos", "estudos"],
]);
const json = toPublic(agg, { allowlist: allow, home: HOME, now: new Date("2026-06-04T12:00:00Z") });
json.synthetic = true;

exigirMetricasValidas(json);
const pasta = resolve(dirname(fileURLToPath(import.meta.url)), "..", "examples");
await mkdir(pasta, { recursive: true });
await writeFile(resolve(pasta, "metrics.example.json"), JSON.stringify(json, null, 2) + "\n", "utf8");
for (const tema of ["light", "dark"]) {
  await writeFile(resolve(pasta, `metrics.example.${tema}.svg`), gerarSvg(json, { tema, titulo: "AI usage" }), "utf8");
}
console.log(`Exemplo sintético gravado em ${pasta}`);
