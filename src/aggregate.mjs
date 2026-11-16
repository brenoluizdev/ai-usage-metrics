import { MAX_CWD_CHARS, tsValido } from "./adapters/seguro.mjs";
import { caminhoDoProjeto, nomeDoProjeto } from "./privacy.mjs";

/** @typedef {import("./types.mjs").Tokens} Tokens */
/** @typedef {import("./types.mjs").UsageEvent} UsageEvent */

export const SEM_PROJETO = "(sem projeto)";

/**
 * Tetos de entradas DISTINTAS no total (antes do corte de 1000 projetos do esquema): protegem a memória contra milhões de
 * pastas/sessões únicas. Excedente de projetos vai para "(sem projeto)"; sessões novas além do teto são ignoradas. Sempre com aviso.
 */
export const LIMITES_PADRAO = Object.freeze({ projetos: 10_000, sessoes: 500_000, sessoesDia: 2_000_000 });

// Teto por contador de token: soma saturada, para que registros adversariais não estourem o limite do esquema (1e15).
const TETO_TOKENS = 2e14;
const TETO_DIA = 1e15;
const tokensVazios = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const soma = (x, y) => Math.min(TETO_TOKENS, x + y);
const somar = (a, b) => {
  if (!b) return;
  a.input = soma(a.input, b.input);
  a.output = soma(a.output, b.output);
  a.cacheRead = soma(a.cacheRead, b.cacheRead);
  a.cacheWrite = soma(a.cacheWrite, b.cacheWrite);
};

/** Junta o contador "origem" em "destino" (usado quando várias pastas viram o mesmo projeto público/privado). */
export function mesclarContador(destino, origem) {
  for (const k of origem.sessions) destino.sessions.add(k);
  destino.userMessages += origem.userMessages;
  destino.assistantMessages += origem.assistantMessages;
  somar(destino.tokens, origem.tokens);
  destino.first = Math.min(destino.first, origem.first);
  destino.last = Math.max(destino.last, origem.last);
}
export const totalDeTokens = (t) => t.input + t.output + t.cacheRead + t.cacheWrite;

const dia = (ts) => new Date(ts).toISOString().slice(0, 10); // dia em UTC

export function novoContador() {
  return { sessions: new Set(), userMessages: 0, assistantMessages: 0, tokens: tokensVazios(), first: Infinity, last: -Infinity };
}

function aplicar(c, ev, sessionKey) {
  c.sessions.add(sessionKey);
  if (ev.kind === "user") c.userMessages++;
  else if (ev.kind === "assistant") c.assistantMessages++;
  somar(c.tokens, ev.tokens);
  if (ev.ts < c.first) c.first = ev.ts;
  if (ev.ts > c.last) c.last = ev.ts;
}

/**
 * Agrega eventos em contadores por ferramenta, projeto e dia. Os nomes de projeto ainda são os REAIS
 * (nome da pasta): a anonimização acontece em `toPublic` (public.mjs).
 * @param {AsyncIterable<UsageEvent>|Iterable<UsageEvent>} eventos
 * Eventos com data inválida (fora de 2000..agora+1 dia) são descartados, com aviso, sem derrubar a execução.
 * Projetos são separados pelo CAMINHO normalizado (duas pastas com o mesmo nome continuam distintas até o toPublic).
 * @param {{ home: string, tools?: Array<{id:string,name:string,capabilities:object}>, avisar?: (msg: string) => void }} opts
 */
export async function aggregate(eventos, opts) {
  const tools = new Map();
  const projetos = new Map();
  const dias = new Map();
  const total = novoContador();
  const sessaoDia = new Set();

  for (const t of opts.tools ?? []) tools.set(t.id, { meta: t, c: novoContador() });

  const lim = { ...LIMITES_PADRAO, ...(opts.limites ?? {}) };
  const sessoesVistas = new Set();
  let descartados = 0;
  let foraDoTeto = 0;
  let projetosAgrupados = 0;
  let cwdsGigantes = 0;
  for await (let ev of eventos) {
    if (!tsValido(ev.ts)) {
      descartados++;
      continue;
    }
    if (typeof ev.project === "string" && ev.project.length > MAX_CWD_CHARS) {
      cwdsGigantes++; // rede de segurança para qualquer adaptador: caminho enorme não vira chave de mapa
      ev = { ...ev, project: null };
    }
    const sessionKey = `${ev.tool}\u0000${ev.session}`;
    if (!sessoesVistas.has(sessionKey)) {
      if (sessoesVistas.size >= lim.sessoes) {
        foraDoTeto++;
        continue;
      }
      sessoesVistas.add(sessionKey);
    }
    let nome = nomeDoProjeto(ev.project, opts.home) ?? SEM_PROJETO;
    let caminho = nome === SEM_PROJETO ? SEM_PROJETO : (caminhoDoProjeto(ev.project, opts.home) ?? nome.toLowerCase());
    if (!projetos.has(caminho) && projetos.size >= lim.projetos) {
      projetosAgrupados++;
      nome = caminho = SEM_PROJETO;
    }

    if (!tools.has(ev.tool)) tools.set(ev.tool, { meta: { id: ev.tool, name: ev.tool, capabilities: {} }, c: novoContador() });
    aplicar(tools.get(ev.tool).c, ev, sessionKey);

    let p = projetos.get(caminho);
    if (!p) projetos.set(caminho, (p = { name: nome, caminho, c: novoContador(), porTool: new Map() }));
    aplicar(p.c, ev, sessionKey);
    if (!p.porTool.has(ev.tool)) p.porTool.set(ev.tool, novoContador());
    aplicar(p.porTool.get(ev.tool), ev, sessionKey);

    aplicar(total, ev, sessionKey);

    const d = dia(ev.ts);
    let linha = dias.get(d);
    if (!linha) dias.set(d, (linha = { sessions: 0, userMessages: 0, assistantMessages: 0, tokens: 0, byTool: new Map() }));
    let lt = linha.byTool.get(ev.tool);
    if (!lt) linha.byTool.set(ev.tool, (lt = { sessions: 0, userMessages: 0, tokens: 0 }));
    const tk = ev.tokens ? totalDeTokens(ev.tokens) : 0;
    if (ev.kind === "user") {
      linha.userMessages++;
      lt.userMessages++;
    } else if (ev.kind === "assistant") linha.assistantMessages++;
    linha.tokens = Math.min(TETO_DIA, linha.tokens + tk);
    lt.tokens = Math.min(TETO_DIA, lt.tokens + tk);
    const sd = `${sessionKey}\u0000${d}`;
    if (!sessaoDia.has(sd) && sessaoDia.size < lim.sessoesDia) {
      sessaoDia.add(sd);
      linha.sessions++;
      lt.sessions++;
    }
  }
  if (cwdsGigantes) opts.avisar?.(`${cwdsGigantes} evento(s) com caminho de projeto maior que ${MAX_CWD_CHARS} caracteres foram agrupados em "${SEM_PROJETO}".`);
  if (foraDoTeto) opts.avisar?.(`Mais de ${lim.sessoes} sessões distintas: ${foraDoTeto} evento(s) de sessões excedentes foram ignorados.`);
  if (projetosAgrupados) opts.avisar?.(`Mais de ${lim.projetos} pastas de projeto distintas: ${projetosAgrupados} evento(s) de pastas excedentes foram agrupados em "${SEM_PROJETO}".`);
  if (descartados) opts.avisar?.(`${descartados} evento(s) com data inválida (fora de 2000..amanhã) foram descartados.`);
  return { total, tools, projetos, dias };
}

/** Ordem do ranking: mais mensagens do usuário primeiro; empate por sessões; depois tokens. */
export const porAtividade = (a, b) =>
  b.userMessages - a.userMessages || b.sessions - a.sessions || b.tokens.total - a.tokens.total || a.name.localeCompare(b.name);

/** Converte um contador interno em objeto simples e serializável. */
export function resumo(c) {
  const tokens = { ...c.tokens, total: totalDeTokens(c.tokens) };
  return {
    sessions: c.sessions.size,
    userMessages: c.userMessages,
    assistantMessages: c.assistantMessages,
    tokens,
    firstActivity: Number.isFinite(c.first) ? dia(c.first) : null,
    lastActivity: Number.isFinite(c.last) ? dia(c.last) : null,
  };
}
