// Histórico persistente (camada A): mescla a SÉRIE DIÁRIA local com o último metrics.json publicado (o "baseline").
// Algoritmo e aproximações: docs/historico.md. O esquema do JSON (v1) NÃO muda.
import { mkdir, rm } from "node:fs/promises";
import { TS_MIN } from "./adapters/seguro.mjs";
import { ADAPTERS } from "./adapters/index.mjs";
import { LIMITE_PADRAO, lerArquivoLimitado } from "./limitado.mjs";
import { garantirSemVazamento } from "./privacy.mjs";
import { MOTIVOS_VALIDOS } from "./regressao.mjs";
import { escreverAtomico, exigirArquivoSeguro, lerMetricasDoClone } from "./publish.mjs";
import { MAX_PONTOS, exigirMetricasValidas } from "./schema.mjs";

export { lerArquivoLimitado };

/** Teto do arquivo de baseline (history.json, metrics.json do clone, restore --from-file). */
export const MAX_BYTES_BASELINE = LIMITE_PADRAO;
export const ARQUIVO_HISTORICO = "history.json";

const TETO_COMPONENTE = 2e14; // mesmo teto por tipo de token do aggregate.mjs: o total nunca passa de 8e14 (< 1e15 do esquema)
const MAX_NUM = 1e15; // teto de qualquer número do esquema
const TIPOS = ["input", "output", "cacheRead", "cacheWrite"];
const DIA = 86_400_000;
const dataMin = new Date(TS_MIN).toISOString().slice(0, 10);

const dataMax = (hoje) => new Date(hoje.getTime() + DIA).toISOString().slice(0, 10); // mesmo limite do tsValido: agora + 1 dia
const soma = (...n) => n.reduce((a, b) => a + b, 0);
const metaRegistro = () => ADAPTERS.map(({ id, name, capabilities }) => ({ id, name, capabilities }));

// ---------- validação do baseline (entrada NÃO confiável) ----------

/**
 * Coerência interna de um baseline JÁ válido pelo esquema: os totais não podem exceder a soma da própria série (o esquema sozinho
 * aceitaria `totals.sessions = 1e15` com 3 dias). Série cortada em 4000 pontos: os totais legitimamente passam da soma e só o
 * período (início <= primeiro ponto, fim = último) é conferido. Devolve o motivo ou null.
 */
export function coerenciaBaseline(j) {
  const pts = j.timeline.points;
  const cortada = pts.length >= MAX_PONTOS;
  const S = (f) => pts.reduce((a, p) => a + f(p), 0);
  const inco = (m) => `INCOERENTE (possível adulteração): ${m}`;
  if (!cortada) {
    const t = j.totals;
    if (t.userMessages > S((p) => p.userMessages)) return inco("totals.userMessages maior que a soma da série");
    if (t.assistantMessages > S((p) => p.assistantMessages)) return inco("totals.assistantMessages maior que a soma da série");
    if (t.tokens.total > S((p) => p.tokens)) return inco("totals.tokens.total maior que a soma da série");
    if (t.sessions > S((p) => p.sessions)) return inco("totals.sessions maior que a soma das sessões da série");
    if (t.activeDays > pts.length) return inco("totals.activeDays maior que o número de dias da série");
    for (const f of j.tools) {
      const so = (k) => pts.reduce((a, p) => a + (p.byTool[f.id]?.[k] ?? 0), 0);
      if (f.sessions > so("sessions") || f.userMessages > so("userMessages") || f.tokens.total > so("tokens")) return inco("uma ferramenta tem totais maiores que a sua própria série");
    }
  }
  if (!pts.length) return j.period === null ? null : inco("período informado, mas a série está vazia");
  const datas = pts.map((p) => p.date).sort();
  if (!j.period) return inco("série com dias, mas sem período");
  if (j.period.to !== datas.at(-1)) return inco("período não bate com a última data da série");
  if (cortada ? j.period.from > datas[0] : j.period.from !== datas[0]) return inco("período não bate com a primeira data da série");
  return null;
}

/**
 * Valida estritamente um baseline: allowlist do esquema v1, esquema 1, não sintético, coerente e sem vazamento (caminho, e-mail...).
 * @returns {{ ok: true, json: any } | { ok: false, motivo: string }}
 */
export function validarBaseline(json, { home } = {}) {
  try {
    exigirMetricasValidas(json);
  } catch (e) {
    return { ok: false, motivo: `fora do esquema v1 (${String(e.message).split("\n")[1]?.trim() ?? "inválido"})` };
  }
  if (json.synthetic) return { ok: false, motivo: "é um JSON sintético (de exemplo)" };
  const inco = coerenciaBaseline(json);
  if (inco) return { ok: false, motivo: inco };
  try {
    garantirSemVazamento(JSON.stringify(json), home ?? "/nao-usado");
  } catch {
    return { ok: false, motivo: "barreira de privacidade recusou o conteúdo" };
  }
  return { ok: true, json };
}

/** Valida o TEXTO de um baseline (tamanho, JSON, esquema, coerência). Mensagens de motivo nunca repetem o conteúdo. */
export function validarTextoDeBaseline(texto, opts) {
  if (Buffer.byteLength(texto) > MAX_BYTES_BASELINE) return { ok: false, motivo: "grande demais (mais de 5 MiB)" };
  let json;
  try {
    json = JSON.parse(texto);
  } catch {
    return { ok: false, motivo: "JSON ilegível" };
  }
  return validarBaseline(json, opts);
}

/** Recusa caminho de rede no Windows (UNC, \\?\, \\.\, //host/...): preserva o "100% offline" do restore --from-file. */
export function motivoCaminhoDeRede(caminho, plataforma = process.platform) {
  const s = String(caminho);
  if (/^[\\/]{2}[?.][\\/]/.test(s)) return "prefixo de caminho estendido/dispositivo (\\\\?\\, //?/ ou \\\\.\\)";
  if (plataforma === "win32" && /^[\\/]{2}/.test(s)) return "caminho de rede/UNC (\\\\servidor\\pasta ou //servidor/pasta)";
  return null;
}

/** Mescla DOIS baselines válidos pelo máximo (usado para history.json + clone, restore e para manter o history.json monotônico). */
export function mesclarBaselines(a, b, { avisar, hoje } = {}) {
  const [novo, velho] = a.generatedAt >= b.generatedAt ? [a, b] : [b, a];
  return mesclarHistorico(novo, velho, { tools: metaRegistro(), avisar, hoje });
}

/**
 * Procura o baseline: history.json e metrics.json do clone local (só se o clone for nosso: mesmas checagens do publish), os DOIS
 * validados; se ambos servem, o baseline é a MESCLA POR MÁXIMO dos dois (history.json fica velho quando outro computador publica);
 * se um é inválido, usa o outro com aviso. Inválido/incoerente/adulterado: ignora e avisa ("histórico ignorado: ..."), sem derrubar nada.
 * @returns {Promise<{ json: any, origem: string } | null>}
 */
export async function carregarBaseline({ paths, config, home, avisar }) {
  const tenta = (origem, r) => {
    if (r === null) return null;
    if (r.motivo) {
      avisar?.(`histórico ignorado: ${origem}: ${r.motivo}.`);
      return null;
    }
    const v = validarTextoDeBaseline(r.texto, { home });
    if (!v.ok) {
      avisar?.(`histórico ignorado: ${origem}: ${v.motivo}.`);
      return null;
    }
    return v.json;
  };
  const h = tenta(ARQUIVO_HISTORICO, await lerArquivoLimitado(paths.historico));
  let c = null;
  if (config) {
    let doClone;
    try {
      doClone = await lerMetricasDoClone({ config, caminhos: paths });
    } catch {
      doClone = { motivo: "não consegui conferir o clone" };
    }
    c = tenta("clone local", doClone);
  }
  if (h && c) {
    try {
      return { json: mesclarBaselines(h, c, { avisar }).json, origem: "history.json + clone local" };
    } catch {
      avisar?.("histórico: não consegui mesclar history.json com o clone local; usando só o history.json.");
      return { json: h, origem: ARQUIVO_HISTORICO };
    }
  }
  if (h) return { json: h, origem: ARQUIVO_HISTORICO };
  if (c) return { json: c, origem: "clone local" };
  return null;
}

/** Grava history.json (texto já em JSON). Atômico, 0600 e recusa link simbólico no destino. Valida de novo antes de gravar. */
export async function gravarBaseline(paths, texto, { home } = {}) {
  const v = validarTextoDeBaseline(texto, { home });
  if (!v.ok) throw new Error(`não gravei o histórico: ${v.motivo}.`);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await escreverAtomico(paths.dir, ARQUIVO_HISTORICO, texto, { mode: 0o600 });
}

/**
 * Grava o history.json depois de um envio: a MESCLA POR MÁXIMO entre o history.json anterior e o JSON publicado, nunca uma cópia
 * do publicado. Assim ele nunca encolhe (um export com --no-history/--since/--tool não apaga o histórico). Zerar é um ato explícito:
 * `history reset`.
 */
export async function gravarHistoricoMonotonico(paths, textoPublicado, { home, avisar } = {}) {
  const novo = validarTextoDeBaseline(textoPublicado, { home });
  if (!novo.ok) throw new Error(`não gravei o histórico: ${novo.motivo}.`);
  let final = novo.json;
  const prev = await lerArquivoLimitado(paths.historico);
  if (prev && !prev.motivo) {
    const v = validarTextoDeBaseline(prev.texto, { home });
    if (v.ok) final = mesclarBaselines(novo.json, v.json, { avisar }).json;
    else avisar?.(`histórico anterior ignorado ao atualizar o history.json: ${v.motivo}.`);
  }
  await gravarBaseline(paths, JSON.stringify(final, null, 2) + "\n", { home });
}

/** `history reset`: apaga o history.json (nunca segue link simbólico). Devolve true se existia. */
export async function apagarHistorico(paths) {
  await exigirArquivoSeguro(paths.historico);
  const existe = (await lerArquivoLimitado(paths.historico)) !== null;
  if (existe) await rm(paths.historico);
  return existe;
}

// ---------- mescla (função pura) ----------

const copiaPonto = (p) => ({ date: p.date, sessions: p.sessions, userMessages: p.userMessages, assistantMessages: p.assistantMessages, tokens: p.tokens, byTool: Object.fromEntries(Object.entries(p.byTool).map(([id, v]) => [id, { ...v }])) });

/**
 * Máximo campo a campo de dois pontos do MESMO dia. Por que o máximo é a escolha segura: as contagens de um dia só crescem com o
 * tempo e um registro local pode ter sido apagado em parte (o Claude Code limpa sessões antigas), então o valor menor é sempre o
 * que perdeu dados; somar contaria duas vezes as mesmas sessões (local e baseline descrevem o mesmo dia); o máximo nunca infla ao
 * reaplicar a mescla. Depois garante point >= soma de byTool (sessões, mensagens e tokens são por ferramenta, sem sobreposição).
 */
export function maxPonto(a, b) {
  const byTool = {};
  for (const id of new Set([...Object.keys(a.byTool), ...Object.keys(b.byTool)])) {
    const x = a.byTool[id];
    const y = b.byTool[id];
    byTool[id] = { sessions: Math.max(x?.sessions ?? 0, y?.sessions ?? 0), userMessages: Math.max(x?.userMessages ?? 0, y?.userMessages ?? 0), tokens: Math.max(x?.tokens ?? 0, y?.tokens ?? 0) };
  }
  const vals = Object.values(byTool);
  return {
    date: a.date,
    sessions: Math.min(MAX_NUM, Math.max(a.sessions, b.sessions, soma(...vals.map((v) => v.sessions)))),
    userMessages: Math.min(MAX_NUM, Math.max(a.userMessages, b.userMessages, soma(...vals.map((v) => v.userMessages)))),
    assistantMessages: Math.max(a.assistantMessages, b.assistantMessages),
    tokens: Math.min(MAX_NUM, Math.max(a.tokens, b.tokens, soma(...vals.map((v) => v.tokens)))),
    byTool,
  };
}

const igualPonto = (a, b) => JSON.stringify([a.sessions, a.userMessages, a.assistantMessages, a.tokens, Object.entries(a.byTool).sort()]) === JSON.stringify([b.sessions, b.userMessages, b.assistantMessages, b.tokens, Object.entries(b.byTool).sort()]);

/** Tira de um ponto do baseline as ferramentas que não estão no registro atual. Devolve null se não sobrou ferramenta alguma. */
function filtrarFerramentas(p, ids) {
  const byTool = {};
  const fora = { sessions: 0, userMessages: 0, tokens: 0 };
  let removeu = false;
  for (const [id, v] of Object.entries(p.byTool)) {
    if (ids.has(id)) byTool[id] = { ...v };
    else {
      removeu = true;
      fora.sessions += v.sessions;
      fora.userMessages += v.userMessages;
      fora.tokens += v.tokens;
    }
  }
  if (!removeu) return copiaPonto(p);
  if (!Object.keys(byTool).length) return null;
  const userMessages = Math.max(0, p.userMessages - fora.userMessages);
  // assistantMessages não é separável por ferramenta: reduz na mesma proporção das mensagens do usuário que restaram.
  const assistantMessages = p.userMessages > 0 ? Math.round((p.assistantMessages * userMessages) / p.userMessages) : p.assistantMessages;
  return { date: p.date, sessions: Math.max(0, p.sessions - fora.sessions), userMessages, assistantMessages, tokens: Math.max(0, p.tokens - fora.tokens), byTool };
}

/** Distribui `e` entre os 4 tipos em proporção a `pesos` (maiores restos; soma exata). Sem pesos, tudo em `input`. */
function distribuir(e, pesos) {
  const W = soma(...TIPOS.map((k) => pesos[k]));
  const r = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (e <= 0) return r;
  if (W <= 0) {
    r.input = e;
    return r;
  }
  const partes = TIPOS.map((k) => {
    const exato = (e * pesos[k]) / W; // e <= 8e14 e pesos <= 2e14: o produto cabe em precisão de ponto flutuante só aproximadamente; o resto absorve o erro
    return { k, base: Math.floor(exato), resto: exato - Math.floor(exato) };
  });
  let falta = e - soma(...partes.map((p) => p.base));
  for (const p of [...partes].sort((x, y) => y.resto - x.resto || TIPOS.indexOf(x.k) - TIPOS.indexOf(y.k))) {
    if (falta <= 0) break;
    p.base++;
    falta--;
  }
  for (const p of partes) r[p.k] = p.base;
  return r;
}

/**
 * Detalhamento de tokens (a série só guarda o TOTAL por dia).
 *  - Mescla não acrescentou nada ao local (série mesclada == série local): detalhamento local, exato.
 *  - Senão: detalhamento do baseline + o EXCEDENTE da série (tokens que a série mesclada tem a mais que a do baseline: dias novos
 *    ou elevados) distribuído na proporção do detalhamento local (ou do baseline, se o local for vazio). É uma aproximação
 *    documentada: dias restaurados mantêm a proporção que o baseline tinha; dias novos usam a do local. Reaplicar é estável,
 *    porque no 2º passo o baseline já contém tudo e o excedente é 0.
 */
function combinarTokens(local, somaLocal, base, somaMesclada) {
  if (somaMesclada === somaLocal) return { ...local };
  const extra = Math.max(0, somaMesclada - base.total); // totais SÓ da série: o total final é a soma da série (limitado pelos tetos)
  const pesos = local.total > 0 ? local : base;
  const d = distribuir(extra, pesos);
  const r = {};
  for (const k of TIPOS) r[k] = Math.min(TETO_COMPONENTE, base[k] + d[k]);
  r.total = soma(...TIPOS.map((k) => r[k]));
  return r;
}

/** Contagem aditiva (sessões, mensagens): igual ao local se a mescla nada acrescentou; senão baseline + acréscimo da série, nunca menos que o local ou o baseline. */
function combinarContagem(local, somaLocal, base, somaBase, somaMesclada) {
  if (somaMesclada === somaLocal) return local;
  return Math.max(base + Math.max(0, somaMesclada - somaBase), local, base);
}

/** Contagem que é exatamente a soma diária (mensagens): local se a mescla nada acrescentou; senão a soma da série mesclada (estável ao reaplicar). */
function combinarSoma(local, somaLocal, somaMesclada) {
  return somaMesclada === somaLocal ? local : Math.max(somaMesclada, local);
}

const somar = (pontos, f) => soma(0, ...pontos.map(f));
const zeroTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

/**
 * Mescla a série diária do JSON local com a do baseline e recalcula totais, período, dias ativos e ferramentas a partir dela.
 * `projects` e `totals.projects` vêm SÓ do local (nomes anonimizados não têm identidade estável entre execuções).
 * Nunca introduz ferramenta fora de `opts.tools` (o registro de adaptadores em uso): ids desconhecidos do baseline são descartados.
 * @param {any} local JSON do export atual (esquema v1, já validado)
 * @param {any} baseline JSON publicado anteriormente (validado; é revalidado aqui)
 * @param {{ tools: Array<{id:string,name:string,capabilities:{messages?:boolean,tokens?:boolean}}>, avisar?: (m:string)=>void, hoje?: Date }} opts
 * @returns {{ json: any, resumo: object }}
 */
export function mesclarHistorico(local, baseline, opts) {
  exigirMetricasValidas(local);
  exigirMetricasValidas(baseline);
  const avisar = opts.avisar ?? (() => {});
  const hoje = opts.hoje ?? new Date();
  const ids = new Set(opts.tools.map((t) => t.id));
  const meta = new Map(opts.tools.map((t) => [t.id, t]));
  const limiteMax = dataMax(hoje);
  const dataOk = (d) => d >= dataMin && d <= limiteMax;

  // 1) baseline saneado: datas dentro de 2000..amanhã, ferramentas do registro, um ponto por data (duplicata = máximo).
  const desconhecidas = new Set();
  for (const p of baseline.timeline.points) for (const id of Object.keys(p.byTool)) if (!ids.has(id)) desconhecidas.add(id);
  const doBase = new Map();
  let datasFora = 0;
  for (const p of baseline.timeline.points) {
    if (!dataOk(p.date)) {
      datasFora++;
      continue;
    }
    const f = filtrarFerramentas(p, ids);
    if (!f) continue;
    doBase.set(p.date, doBase.has(p.date) ? maxPonto(doBase.get(p.date), f) : f);
  }
  if (desconhecidas.size) avisar(`histórico: ferramenta(s) fora do registro atual descartada(s): ${[...desconhecidas].sort().join(", ")}.`);
  if (datasFora) avisar(`histórico: ${datasFora} dia(s) com data fora de 2000..amanhã foram descartados.`);

  // 2) série local (só datas válidas; o export já garante)
  const doLocal = new Map();
  for (const p of local.timeline.points) doLocal.set(p.date, copiaPonto(p));

  // 3) mescla por data
  const mesclado = new Map();
  let soLocais = 0;
  let soBase = 0;
  let elevados = 0;
  for (const [d, l] of doLocal) {
    const b = doBase.get(d);
    if (!b) {
      soLocais++;
      mesclado.set(d, l);
    } else {
      const m = maxPonto(l, b);
      if (!igualPonto(m, l)) elevados++;
      mesclado.set(d, m);
    }
  }
  for (const [d, b] of doBase) {
    if (doLocal.has(d)) continue;
    soBase++;
    mesclado.set(d, b);
  }
  const datas = [...mesclado.keys()].sort();
  const diasAntesDoCorte = datas.length;
  if (datas.length > MAX_PONTOS) avisar(`A série diária tem ${datas.length} dias; só os ${MAX_PONTOS} mais recentes foram exportados.`);
  const points = datas.slice(-MAX_PONTOS).map((d) => mesclado.get(d));

  // 4) totais recalculados a partir da série
  const pl = [...doLocal.values()];
  const pb = [...doBase.values()];
  const S = (pts) => ({ sessions: somar(pts, (p) => p.sessions), user: somar(pts, (p) => p.userMessages), asst: somar(pts, (p) => p.assistantMessages), tokens: somar(pts, (p) => p.tokens) });
  const sl = S(pl);
  const sb = S(pb);
  const sm = S(points);

  // Totais do baseline: os próprios totals, salvo se alguma ferramenta foi descartada/filtrada (--tool): aí, a soma das ferramentas aceitas.
  const ferrBase = baseline.tools.filter((t) => ids.has(t.id));
  const semDescarte = ferrBase.length === baseline.tools.length && desconhecidas.size === 0;
  const bt = baseline.totals;
  // Só a SÉRIE é confiada para contagens (um baseline pode declarar totais que o esquema aceita mas a série não sustenta): o total
  // declarado entra apenas como teto de sessions (distintas) e como detalhamento de tokens.
  const tb = semDescarte ? { sessions: bt.sessions, user: bt.userMessages, asst: bt.assistantMessages, tokens: { ...bt.tokens } } : {
    sessions: somar(ferrBase, (t) => t.sessions),
    user: somar(ferrBase, (t) => t.userMessages),
    asst: somar(ferrBase, (t) => t.assistantMessages),
    tokens: ferrBase.reduce((acc, t) => {
      for (const k of TIPOS) acc[k] += t.tokens[k];
      acc.total = soma(...TIPOS.map((k) => acc[k]));
      return acc;
    }, zeroTokens()),
  };
  const lt = local.totals;
  let limitou = false;
  const lim = (n) => {
    if (n > MAX_NUM) {
      limitou = true;
      return MAX_NUM;
    }
    return n;
  };
  const tokensMescla = combinarTokens(lt.tokens, sl.tokens, tb.tokens, sm.tokens);
  if (tokensMescla.total < sm.tokens && sm.tokens !== sl.tokens) limitou = true;
  const totals = {
    projects: lt.projects,
    sessions: lim(combinarContagem(lt.sessions, sl.sessions, Math.min(tb.sessions, sb.sessions), sb.sessions, sm.sessions)),
    userMessages: lim(combinarSoma(lt.userMessages, sl.user, sm.user)),
    assistantMessages: lim(combinarSoma(lt.assistantMessages, sl.asst, sm.asst)),
    activeDays: points.length, // sobre os pontos já cortados (estável na borda de 4000 dias)
    tokens: tokensMescla,
  };
  void diasAntesDoCorte;

  // 5) ferramentas
  const idsFerr = new Set([...local.tools.map((t) => t.id), ...ferrBase.map((t) => t.id)]);
  const serie = (pts, id) => pts.map((p) => p.byTool[id]).filter(Boolean);
  const tools = [];
  for (const id of idsFerr) {
    const L = local.tools.find((t) => t.id === id);
    const B = ferrBase.find((t) => t.id === id);
    const Sl = serie(pl, id);
    const Sb = serie(pb, id);
    const Sm = serie(points, id);
    const f = (x) => ({ sessions: somar(x, (v) => v.sessions), user: somar(x, (v) => v.userMessages), tokens: somar(x, (v) => v.tokens) });
    const l = f(Sl);
    const b = f(Sb);
    const m = f(Sm);
    const Ls = L?.sessions ?? 0;
    const Lu = L?.userMessages ?? 0;
    const La = L?.assistantMessages ?? 0;
    const Bu = Math.min(B?.userMessages ?? 0, b.user);
    const Ba = B?.assistantMessages ?? 0;
    const igualAoLocal = m.sessions === l.sessions && m.user === l.user && m.tokens === l.tokens;
    let asst = La;
    if (!igualAoLocal) {
      const razao = Bu > 0 ? Ba / Bu : Lu > 0 ? La / Lu : 0;
      asst = Math.max(Ba + Math.round(Math.max(0, m.user - b.user) * razao), La, Ba);
    }
    asst = Math.min(asst, sm.asst); // nunca mais que todas as respostas da série
    const sessions = lim(combinarContagem(Ls, l.sessions, Math.min(B?.sessions ?? 0, b.sessions), b.sessions, m.sessions));
    if (sessions <= 0) continue; // como o export atual: só ferramentas com sessões
    const datasDaFerr = points.filter((p) => p.byTool[id]).map((p) => p.date);
    const cortada = points.length >= MAX_PONTOS; // só com a série cortada as datas declaradas pela ferramenta ajudam
    const primeiros = [datasDaFerr[0], ...(cortada ? [L?.firstActivity, B?.firstActivity] : [])].filter((d) => d && dataOk(d)).sort();
    const ultimos = [datasDaFerr.at(-1), ...(cortada ? [L?.lastActivity, B?.lastActivity] : [])].filter((d) => d && dataOk(d)).sort();
    const reg = meta.get(id);
    tools.push({
      id,
      name: reg.name,
      provides: { messages: !!reg.capabilities?.messages, tokens: !!reg.capabilities?.tokens },
      sessions,
      userMessages: lim(combinarSoma(Lu, l.user, m.user)),
      assistantMessages: asst,
      tokens: combinarTokens(L?.tokens ?? zeroTokens(), l.tokens, B?.tokens ?? zeroTokens(), m.tokens),
      firstActivity: primeiros[0] ?? null,
      lastActivity: ultimos.at(-1) ?? null,
    });
  }
  tools.sort((a, b) => b.sessions - a.sessions || a.id.localeCompare(b.id));

  // 6) período: da série, do período local e do período do baseline (só se as datas forem plausíveis)
  // Série inteira: o período É o intervalo dos pontos. Série cortada em 4000: o início pode vir do período local/do baseline.
  const extremos = [...points.map((p) => p.date), ...(points.length >= MAX_PONTOS ? [local.period?.from, baseline.period?.from] : [])].filter((d) => d && dataOk(d)).sort();
  const period = points.length ? { from: extremos[0], to: points.at(-1).date } : null;
  if (limitou) avisar("histórico: algum total passou do limite do esquema (1e15) e foi limitado.");

  const json = { ...local, period, totals, tools, timeline: { ...local.timeline, points } };
  exigirMetricasValidas(json);
  const diasLocais = doLocal.size;
  const diasBaseline = doBase.size;
  return {
    json,
    resumo: {
      diasLocais,
      diasBaseline,
      diasDoHistorico: soBase,
      diasSoLocais: soLocais,
      diasElevados: elevados,
      diasFinal: points.length,
      // "PC formatado / sessões apagadas": o histórico tem dias que os registros locais não têm, e os registros são bem menores.
      locaisComMuitoMenos: soBase >= 1 && diasLocais * 2 < diasBaseline,
    },
  };
}

// ---------- texto para o usuário ----------

/** Linhas de resumo (só números: seguro mesmo vindo de um arquivo local). `h` = resumo + origem. */
export function linhasDoHistorico(h) {
  const L = [];
  L.push(`Histórico: série diária mesclada com o último JSON publicado (${h.origem}): ${h.diasDoHistorico} dia(s) vieram só do histórico, ${h.diasSoLocais} são só locais, ${h.diasElevados} foram elevados pelo máximo.`);
  if (h.locaisComMuitoMenos) {
    L.push(`ATENÇÃO: os registros locais têm só ${h.diasLocais} dia(s) e o histórico mantém ${h.diasDoHistorico} dia(s) que eles já não têm (computador novo/formatado ou sessões apagadas?). Os números continuam preservados pelo histórico; o ranking de projetos NÃO (vem só dos registros locais).`);
  }
  return L;
}

const num = (v) => (Number.isSafeInteger(v) && v >= 0 && v <= 1e7 ? v : 0);
/** Lê o resumo gravado pelo export (out/historico.json); qualquer coisa estranha vira "sem histórico". */
export function normalizarResumoGravado(bruto) {
  if (!bruto || typeof bruto !== "object" || bruto.usado !== true) return null;
  return {
    origem: ["clone local", "history.json + clone local"].includes(bruto.origem) ? bruto.origem : "history.json",
    diasLocais: num(bruto.diasLocais),
    diasBaseline: num(bruto.diasBaseline),
    diasDoHistorico: num(bruto.diasDoHistorico),
    diasSoLocais: num(bruto.diasSoLocais),
    diasElevados: num(bruto.diasElevados),
    locaisComMuitoMenos: bruto.locaisComMuitoMenos === true,
  };
}


/** Motivos (rótulos fixos) pelos quais o export ficou sem o histórico/limitado; lidos do out/historico.json (arquivo local, não confiável). */
export function normalizarMotivos(bruto) {
  return Array.isArray(bruto?.motivos) ? bruto.motivos.filter((m) => MOTIVOS_VALIDOS.includes(m)) : [];
}
