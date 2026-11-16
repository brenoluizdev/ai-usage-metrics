// Métricas 100% sintéticas (nomes e números inventados) para os testes de schema, svg e publish.
import { aggregate } from "../src/aggregate.mjs";
import { toPublic } from "../src/public.mjs";

const HOME = "/home/exemplo";
const tk = (input, output) => ({ input, output, cacheRead: 100, cacheWrite: 10 });

/** @param {{ extra?: boolean, agora?: string, allowlist?: Array<[string,string]> }} [o] */
export async function metricasSinteticas({ extra = false, agora = "2026-03-10T12:00:00Z", allowlist = [["meu-site", "meu-site"]] } = {}) {
  const ev = [];
  const base = Date.parse("2026-01-10T10:00:00Z");
  for (let d = 0; d < 40; d += 3) {
    const ts = base + d * 86_400_000;
    const proj = d % 2 ? "meu-site" : "segredo-x";
    ev.push({ tool: "claude-code", project: `${HOME}/dev/${proj}`, session: `s${d}`, ts, kind: "user" });
    ev.push({ tool: "claude-code", project: `${HOME}/dev/${proj}`, session: `s${d}`, ts: ts + 1000, kind: "assistant", tokens: tk(5, 7) });
    if (d % 6 === 0) ev.push({ tool: "cline", project: `${HOME}/dev/meu-site`, session: `c${d}`, ts, kind: "user" });
  }
  if (extra) ev.push({ tool: "claude-code", project: `${HOME}/dev/meu-site`, session: "novo", ts: Date.parse("2026-03-09T10:00:00Z"), kind: "user" });
  const meta = [
    { id: "claude-code", name: "Claude Code", capabilities: { messages: true, tokens: true } },
    { id: "cline", name: "Cline (CLI)", capabilities: { messages: true, tokens: true } },
  ];
  const agg = await aggregate(ev, { home: HOME, tools: meta });
  return toPublic(agg, { allowlist: new Map(allowlist), home: HOME, now: new Date(agora) });
}
