// Guarda de regressão do histórico: o JSON a publicar tem MENOS dias ou totais menores que uma referência (baseline/remoto)?
// Só funções puras sobre JSON já validado pelo esquema v1. As referências são comparadas pela SÉRIE (soma dos pontos), não pelos
// totais declarados (que um arquivo adulterado poderia inflar); só `sessions` usa o menor entre o total declarado e a série.

export const FRASE_PERDA = "publicar com perda de histórico";

const soma = (pts, f) => pts.reduce((a, p) => a + f(p), 0);

/** Resumo comparável de um JSON de métricas válido. */
export function resumoDeReferencia(j) {
  const pts = j.timeline.points;
  return {
    dias: new Set(pts.map((p) => p.date)),
    from: j.period?.from ?? null,
    to: j.period?.to ?? null,
    sessions: Math.min(j.totals.sessions, soma(pts, (p) => p.sessions)),
    userMessages: soma(pts, (p) => p.userMessages),
    tokens: soma(pts, (p) => p.tokens),
  };
}

/**
 * Compara o JSON a publicar com uma referência. Devolve null se nada regride; senão os números antes/depois.
 * Regride se tem menos dias (ou perde alguma data da referência) ou algum total menor (sessions, userMessages, tokens).
 */
export function avaliarRegressao(novo, ref) {
  const r = resumoDeReferencia(ref);
  const pts = novo.timeline.points;
  const dn = new Set(pts.map((p) => p.date));
  const removidos = [...r.dias].filter((d) => !dn.has(d)).length;
  const depois = { dias: dn.size, from: novo.period?.from ?? null, to: novo.period?.to ?? null, sessions: novo.totals.sessions, userMessages: soma(pts, (p) => p.userMessages), tokens: soma(pts, (p) => p.tokens) };
  const menor = removidos > 0 || depois.dias < r.dias.size || depois.sessions < r.sessions || depois.userMessages < r.userMessages || depois.tokens < r.tokens;
  if (!menor) return null;
  return { removidos, antes: { ...r, dias: r.dias.size }, depois };
}

/** A pior regressão entre várias referências (mais dias removidos; empate: a primeira). */
export function piorRegressao(novo, refs) {
  let pior = null;
  for (const ref of refs) {
    if (!ref) continue;
    const r = avaliarRegressao(novo, ref);
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
