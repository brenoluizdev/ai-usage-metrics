import { mesclarContador, novoContador, porAtividade, resumo } from "./aggregate.mjs";

// Nomes de pasta vêm do disco (dado não confiável): sem caracteres de controle/escape de terminal na saída.
const limpar = (s) => String(s).replace(/\p{Cc}/gu, "?");

const fmt = (n) => n.toLocaleString("pt-BR");
const compacto = (n) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} bi` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} mi` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} mil` : String(n);
const pad = (s, n) => ((s = limpar(s)), s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const padL = (s, n) => (s.length >= n ? s : " ".repeat(n - s.length) + s);
const barra = (v, max, larg = 24) => "█".repeat(max > 0 ? Math.max(v > 0 ? 1 : 0, Math.round((v / max) * larg)) : 0);

/**
 * Resumo legível para o terminal. Mostra os nomes REAIS dos projetos (é local): não cole em lugar público.
 * @param {Awaited<ReturnType<import("./aggregate.mjs").aggregate>>} agg
 * @param {{ top?: number }} [opts]
 */
export function renderTerminal(agg, opts = {}) {
  const top = opts.top ?? 10;
  const L = [];
  const tot = resumo(agg.total);
  L.push("Uso de IA no seu computador (dados locais, só leitura)");
  L.push("ATENÇÃO: nomes de projetos reais abaixo; não publique esta saída.");
  L.push("");
  L.push(
    `Período: ${tot.firstActivity ?? "-"} a ${tot.lastActivity ?? "-"} | sessões: ${fmt(tot.sessions)} | mensagens suas: ${fmt(tot.userMessages)} | respostas: ${fmt(tot.assistantMessages)} | tokens: ${compacto(tot.tokens.total)}`,
  );
  L.push("");

  L.push("Por ferramenta");
  const tools = [...agg.tools.values()].filter((t) => t.c.sessions.size).map((t) => ({ meta: t.meta, ...resumo(t.c) }));
  tools.sort((a, b) => b.sessions - a.sessions);
  for (const t of tools) {
    const msgs = t.meta.capabilities.messages ? `${padL(fmt(t.userMessages), 7)} msgs` : "  sem contagem de mensagens";
    const tk = t.meta.capabilities.tokens ? `${padL(compacto(t.tokens.total), 9)} tokens` : "";
    L.push(`  ${pad(t.meta.name, 34)} ${padL(fmt(t.sessions), 5)} sessões ${msgs} ${tk}`);
  }
  L.push("");

  // Pastas com o mesmo nome (em caminhos diferentes) são somadas na tela, com aviso.
  const porNome = new Map();
  for (const p of agg.projetos.values()) {
    const k = p.name.toLowerCase();
    const g = porNome.get(k) ?? { name: p.name, c: novoContador(), pastas: 0 };
    mesclarContador(g.c, p.c);
    g.pastas++;
    porNome.set(k, g);
  }
  const projetos = [...porNome.values()].map((g) => ({ ...resumo(g.c), name: g.name, pastas: g.pastas })).sort(porAtividade);
  const maxMsg = Math.max(1, ...projetos.map((p) => p.userMessages));
  L.push(`Projetos mais usados (top ${Math.min(top, projetos.length)} de ${projetos.length}, por mensagens suas)`);
  for (const p of projetos.slice(0, top)) {
    L.push(`  ${pad(p.name, 30)} ${padL(fmt(p.userMessages), 6)} msgs ${padL(fmt(p.sessions), 4)} sess ${padL(compacto(p.tokens.total), 9)} tok  ${barra(p.userMessages, maxMsg)}`);
  }
  const homonimos = projetos.filter((p) => p.pastas > 1);
  if (homonimos.length) {
    L.push("");
    for (const p of homonimos) L.push(`AVISO: ${p.pastas} pastas distintas se chamam "${limpar(p.name)}" e aparecem somadas; se um nome público for dado a esse nome, todas entram nele (use o caminho completo em publicProjects).`);
  }
  const menos = projetos.filter((p) => p.sessions > 0).slice(-Math.min(5, Math.max(0, projetos.length - top))).reverse();
  if (menos.length) {
    L.push("");
    L.push("Projetos menos usados");
    for (const p of menos) L.push(`  ${pad(p.name, 30)} ${padL(fmt(p.userMessages), 6)} msgs ${padL(fmt(p.sessions), 4)} sess  (última atividade ${p.lastActivity})`);
  }

  L.push("");
  L.push("Mensagens suas por mês");
  const meses = new Map();
  for (const [d, l] of agg.dias) meses.set(d.slice(0, 7), (meses.get(d.slice(0, 7)) ?? 0) + l.userMessages);
  const mx = Math.max(1, ...meses.values());
  for (const [m, v] of [...meses].sort(([a], [b]) => a.localeCompare(b))) L.push(`  ${m} ${padL(fmt(v), 6)} ${barra(v, mx, 30)}`);
  return L.join("\n");
}
