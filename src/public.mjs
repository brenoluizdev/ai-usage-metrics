import { mesclarContador, novoContador, porAtividade, resumo, SEM_PROJETO } from "./aggregate.mjs";
import { garantirSemVazamento } from "./privacy.mjs";
import { MAX_PONTOS, MAX_PROJETOS } from "./schema.mjs";

export const SCHEMA_VERSION = 1;

/**
 * Monta o JSON público (esquema v1, ver docs/esquema.md). Projetos fora da allowlist saem anonimizados.
 * @param {Awaited<ReturnType<import("./aggregate.mjs").aggregate>>} agg
 * A allowlist casa pelo CAMINHO completo normalizado (mais específico) ou pelo nome da pasta. Pastas diferentes que
 * resolvem para o mesmo nome público são somadas e geram um aviso (opts.avisar).
 * @param {{ allowlist: Map<string,string>, home: string, now?: Date, avisar?: (msg: string) => void }} opts
 */
export function toPublic(agg, opts) {
  const tools = [...agg.tools.values()]
    .filter((t) => t.c.sessions.size > 0)
    .map((t) => ({
      id: t.meta.id,
      name: t.meta.name,
      provides: { messages: !!t.meta.capabilities.messages, tokens: !!t.meta.capabilities.tokens },
      ...resumo(t.c),
    }))
    .sort((a, b) => b.sessions - a.sessions || a.id.localeCompare(b.id));

  // 1) cada pasta (caminho normalizado) decide o seu destino; 2) pastas com o mesmo destino são somadas.
  const grupos = new Map();
  for (const p of agg.projetos.values()) {
    const semProjeto = p.name === SEM_PROJETO;
    const alias = semProjeto ? undefined : (opts.allowlist.get(p.caminho) ?? opts.allowlist.get(p.name.toLowerCase()));
    const chave = semProjeto ? "sem" : alias !== undefined ? `pub:${alias.toLowerCase()}` : `priv:${p.name.toLowerCase()}`;
    let g = grupos.get(chave);
    if (!g) {
      grupos.set(chave, (g = { semProjeto, alias, nomeReal: p.name, c: novoContador(), porTool: new Map(), pastas: new Set() }));
    }
    g.pastas.add(p.caminho);
    mesclarContador(g.c, p.c);
    for (const [id, c] of p.porTool) {
      if (!g.porTool.has(id)) g.porTool.set(id, novoContador());
      mesclarContador(g.porTool.get(id), c);
    }
  }
  for (const g of grupos.values()) {
    if (g.alias !== undefined && g.pastas.size > 1) {
      opts.avisar?.(`O nome público "${g.alias}" junta ${g.pastas.size} pastas distintas com o mesmo nome. Use o caminho completo em publicProjects para escolher só uma.`);
    }
  }

  const ordenados = [...grupos.values()]
    .map((g) => ({ g, ...resumo(g.c), name: g.nomeReal }))
    .sort(porAtividade);

  let n = 0;
  const todosProjetos = ordenados.map((p) => {
    const { g } = p;
    const publico = g.semProjeto || g.alias !== undefined;
    const nome = g.semProjeto ? "sem-projeto" : (g.alias ?? `projeto-privado-${++n}`);
    const { g: _g, name: _descartado, ...numeros } = p;
    void _g;
    void _descartado;
    return {
      name: nome,
      public: publico,
      ...numeros,
      tools: [...g.porTool.entries()]
        .map(([id, c]) => ({ id, ...resumo(c) }))
        .sort((a, b) => b.sessions - a.sessions || a.id.localeCompare(b.id))
        .map(({ id, sessions, userMessages, assistantMessages, tokens }) => ({ id, sessions, userMessages, assistantMessages, tokens })),
    };
  });
  if (todosProjetos.length > MAX_PROJETOS) opts.avisar?.(`Há ${todosProjetos.length} projetos; só os ${MAX_PROJETOS} mais ativos foram exportados.`);
  const projects = todosProjetos.slice(0, MAX_PROJETOS);

  const todosOsDias = [...agg.dias.entries()].sort(([a], [b]) => a.localeCompare(b));
  // O esquema aceita até MAX_PONTOS dias: se houver mais, ficam os mais recentes (degrada com aviso em vez de falhar).
  if (todosOsDias.length > MAX_PONTOS) opts.avisar?.(`A série diária tem ${todosOsDias.length} dias; só os ${MAX_PONTOS} mais recentes foram exportados.`);
  const points = todosOsDias
    .slice(-MAX_PONTOS)
    .map(([date, l]) => ({
      date,
      sessions: l.sessions,
      userMessages: l.userMessages,
      assistantMessages: l.assistantMessages,
      tokens: l.tokens,
      byTool: Object.fromEntries(
        [...l.byTool.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, v]) => [id, v]),
      ),
    }));

  const totais = resumo(agg.total);
  const saida = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    synthetic: false,
    period: totais.firstActivity ? { from: totais.firstActivity, to: totais.lastActivity } : null,
    totals: {
      projects: todosProjetos.length,
      sessions: totais.sessions,
      userMessages: totais.userMessages,
      assistantMessages: totais.assistantMessages,
      activeDays: todosOsDias.length,
      tokens: totais.tokens,
    },
    tools,
    projects,
    timeline: { granularity: "day", timezone: "UTC", points },
  };
  garantirSemVazamento(JSON.stringify(saida), opts.home);
  return saida;
}
