// Guarda de regressão do histórico: o JSON a publicar tem MENOS dias ou totais menores que uma referência (baseline/remoto)?
// Só funções puras sobre JSON já validado pelo esquema v1. As referências são comparadas pela SÉRIE (soma dos pontos), não pelos
// totais declarados (que um arquivo adulterado poderia inflar); só `sessions` usa o menor entre o total declarado e a série.

export const FRASE_PERDA = "publicar com perda de histórico";

import { ADAPTERS } from "./adapters/index.mjs";
import { MAX_PONTOS } from "./schema.mjs";

const idsDoRegistro = () => new Set(ADAPTERS.map((a) => a.id));
const soma = (pts, f) => pts.reduce((a, p) => a + f(p), 0);

const DIA = 86_400_000;
const DATA_MIN = "2000-01-01";

/**
 * Resumo comparável de um JSON de métricas válido, já NORMALIZADO como a mescla o faria (senão a guarda dispararia para sempre):
 * descarta datas fora de 2000-01-01..hoje+1 e ferramentas fora do registro atual (ids) e, se `desde` for dado (plano com a janela
 * de 4000 pontos cheia), as datas mais antigas que o primeiro ponto do plano.
 */
export function resumoDeReferencia(j, { ids = idsDoRegistro(), hoje = new Date(), desde = null } = {}) {
  const max = new Date(hoje.getTime() + DIA).toISOString().slice(0, 10);
  const pts = [];
  for (const p of j.timeline.points) {
    if (p.date < DATA_MIN || p.date > max || (desde && p.date < desde)) continue;
    const mantidas = Object.entries(p.byTool).filter(([id]) => ids.has(id));
    if (mantidas.length === Object.keys(p.byTool).length) pts.push(p);
    else if (mantidas.length) pts.push({ ...p, sessions: soma(mantidas, ([, v]) => v.sessions), userMessages: soma(mantidas, ([, v]) => v.userMessages), tokens: soma(mantidas, ([, v]) => v.tokens) });
  }
  const somaSerie = soma(pts, (p) => p.sessions);
  return {
    dias: new Set(pts.map((p) => p.date)),
    from: j.period?.from ?? null,
    to: j.period?.to ?? null,
    sessions: desde ? somaSerie : Math.min(j.totals.sessions, somaSerie), // janela: totais só dentro dela
    userMessages: soma(pts, (p) => p.userMessages),
    tokens: soma(pts, (p) => p.tokens),
  };
}

/**
 * Compara o JSON a publicar com uma referência. Devolve null se nada regride; senão os números antes/depois.
 * Regride se perde alguma data da referência ou algum total é menor (sessions, userMessages, tokens). A referência é normalizada
 * (datas e ferramentas como na mescla). Plano com a série cortada em 4000 pontos: datas da referência mais antigas que o primeiro
 * ponto do plano não contam como removidas e os totais são comparados só dentro da janela do plano.
 */
export function avaliarRegressao(novo, ref, opcoes = {}) {
  const pts = novo.timeline.points;
  const dn = new Set(pts.map((p) => p.date));
  const janela = pts.length >= MAX_PONTOS;
  const desde = janela ? [...dn].sort()[0] : null;
  const r = resumoDeReferencia(ref, { ...opcoes, desde });
  const removidos = [...r.dias].filter((d) => !dn.has(d)).length;
  const depois = { dias: dn.size, from: novo.period?.from ?? null, to: novo.period?.to ?? null, sessions: janela ? soma(pts, (p) => p.sessions) : novo.totals.sessions, userMessages: soma(pts, (p) => p.userMessages), tokens: soma(pts, (p) => p.tokens) };
  const menor = removidos > 0 || depois.dias < r.dias.size || depois.sessions < r.sessions || depois.userMessages < r.userMessages || depois.tokens < r.tokens;
  if (!menor) return null;
  return { removidos, antes: { ...r, dias: r.dias.size }, depois };
}

/** A pior regressão entre várias referências (mais dias removidos; empate: a primeira). */
export function piorRegressao(novo, refs, opcoes = {}) {
  let pior = null;
  for (const ref of refs) {
    if (!ref) continue;
    const r = avaliarRegressao(novo, ref, opcoes);
    if (r && (!pior || r.removidos > pior.removidos)) pior = r;
  }
  return pior;
}

const NOMES_MOTIVO = { "no-history": "--no-history", since: "--since", tool: "--tool", config: '"history": false' };
export const MOTIVOS_VALIDOS = Object.keys(NOMES_MOTIVO);

/** Linhas de aviso em destaque (só números e rótulos fixos). */
export function linhasDeRegressao(r, motivos = []) {
  const a = r.antes;
  const d = r.depois;
  const per = (x) => (x.from ? `${x.from} a ${x.to}` : "sem período");
  const L = [
    `ATENÇÃO: PERDA DE HISTÓRICO. O JSON gerado é MENOR que o histórico: ${a.dias} -> ${d.dias} dia(s) (${r.removidos} dia(s) seriam removidos), sessões ${a.sessions} -> ${d.sessions}, mensagens ${a.userMessages} -> ${d.userMessages}, tokens ${a.tokens} -> ${d.tokens}, período ${per(a)} -> ${per(d)}.`,
  ];
  const nomes = motivos.filter((m) => NOMES_MOTIVO[m]).map((m) => NOMES_MOTIVO[m]);
  if (nomes.length) L.push(`  Causa provável: este export foi feito com ${nomes.join(", ")}, que deixa(m) o histórico de fora ou o limita(m).`);
  L.push("  Publicar assim sobrescreve o histórico publicado. O envio exige confirmação extra (a frase exata em terminal ou --accept-history-loss) e é BLOQUEADO no envio automático.");
  return L;
}
