// Gerador do SVG do painel. Determinístico, sem dependências e sem IA: mesmo JSON + mesmas opções = mesmo SVG.
// O SVG é autocontido (CSS inline, sem script, sem fonte nem imagem externa), pois o GitHub só exibe SVG assim em README.

/** @typedef {import("./types.mjs").Metricas} Metricas */
/** @typedef {"auto"|"light"|"dark"} Tema */

import { ADAPTERS } from "./adapters/index.mjs";
import { PADRAO_CLARO, PADRAO_ESCURO, comPadrao, escalaCalor, validarCores } from "./cores.mjs";

export const TEMAS = ["auto", "light", "dark"];
export const IDIOMAS = ["en", "pt-BR"];
export const MODELOS = ["model-1", "model-2", "model-3"];
export const MODELO_PADRAO = "model-1";

// Cores por ferramenta conhecida; as demais recebem uma cor estável da paleta, pela posição.
// Map (e não objeto): ids como "constructor" ou "__proto__" não podem cair em propriedades herdadas.
const COR = new Map([["claude-code", "#d97757"], ["cline", "#10b981"], ["chatgpt", "#f59e0b"]]);
const PALETA = ["#6366f1", "#14b8a6", "#ec4899", "#84cc16", "#0ea5e9", "#a855f7"];
const COR_PROJETO = PADRAO_CLARO.accent;

const TEXTOS = {
  en: {
    titulo: "AI usage",
    tituloExemplo: "AI usage (sample data)",
    periodo: "Period",
    semDados: "no data",
    sessoes: "Sessions",
    mensagens: "My messages",
    tokens: "Tokens (with cache)",
    dias: "Active days",
    porMes: "Sessions per month",
    projetos: "Most used projects",
    semProjetos: "No projects",
    msg: "msg",
    sess: "sess",
    rodape: (d) => `Generated locally on ${d} · days in UTC · private projects are anonymized`,
    desc: (p, s, m, d) => `Period ${p}: ${s} sessions, ${m} messages, ${d} active days.`,
    meses: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    unidades: ["", "k", "M", "B"],
    sepUnidade: "",
    locale: "en-US",
    data: (a, m, d) => `${a}-${m}-${d}`,
    rotuloMes: (nome, ano) => `${nome} ${ano}`,
    porFerramenta: "Sessions by tool",
    rodapeCurto: (d) => `Generated locally on ${d} · UTC`,
    sessUm: "session",
    sessVarios: "sessions",
    diaUm: "active day",
    diaVarios: "active days",
    semana: ["", "Mon", "", "Wed", "", "Fri", ""],
    calResumo: (s, d) => `${s} · ${d} · last 53 weeks`,
    calNota: "Sessions per day (UTC)",
    menos: "Less",
    mais: "More",
  },
  "pt-BR": {
    titulo: "Uso de IA",
    tituloExemplo: "Uso de IA (dados de exemplo)",
    periodo: "Período",
    semDados: "sem dados",
    sessoes: "Sessões",
    mensagens: "Mensagens minhas",
    tokens: "Tokens (com cache)",
    dias: "Dias ativos",
    porMes: "Sessões por mês",
    projetos: "Projetos com mais uso",
    semProjetos: "Sem projetos",
    msg: "msg",
    sess: "sess",
    rodape: (d) => `Gerado localmente em ${d} · dias em UTC · projetos privados anonimizados`,
    desc: (p, s, m, d) => `Período ${p}: ${s} sessões, ${m} mensagens, ${d} dias ativos.`,
    meses: ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"],
    unidades: ["", "mil", "mi", "bi"],
    sepUnidade: " ",
    locale: "pt-BR",
    data: (a, m, d) => `${d}/${m}/${a}`,
    rotuloMes: (nome, ano) => `${nome}/${ano}`,
    porFerramenta: "Sessões por ferramenta",
    rodapeCurto: (d) => `Gerado localmente em ${d} · UTC`,
    sessUm: "sessão",
    sessVarios: "sessões",
    diaUm: "dia ativo",
    diaVarios: "dias ativos",
    semana: ["", "seg", "", "qua", "", "sex", ""],
    calResumo: (s, d) => `${s} · ${d} · últimas 53 semanas`,
    calNota: "Sessões por dia (UTC)",
    menos: "Menos",
    mais: "Mais",
  },
};

/** Escapa texto para XML e remove caracteres de controle inválidos. Todo texto vindo de dados ou opções passa por aqui. */
export function esc(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const cortar = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function corDe(id, ids) {
  if (COR.has(id)) return COR.get(id);
  const i = ids.filter((x) => !COR.has(x)).indexOf(id);
  return PALETA[(i < 0 ? 0 : i) % PALETA.length];
}

const temCor = (o) => o !== undefined && Object.keys(o).some((k) => k !== "tools" || Object.keys(o.tools).length > 0);

/**
 * Resolve as cores (validadas de novo aqui, mesmo que a configuração já tenha validado) e monta o CSS.
 * Regras: `cores` vale para o claro e, no tema auto sem `coresEscuro`, também para o escuro. `coresEscuro` só vale no escuro.
 * Tema light usa só `cores`; tema dark usa `coresEscuro` (ou, se não houver, `cores`).
 * Sem nenhuma cor informada, o CSS é idêntico ao de sempre (e o model-1 gera o mesmo SVG de antes).
 */
function montarEstilo(tema, opcoes, ids, modelo, tamanhoTitulo) {
  const idsValidos = ADAPTERS.map((a) => a.id);
  const c = opcoes.cores === undefined ? undefined : validarCores(opcoes.cores, idsValidos, "colors");
  const cd = opcoes.coresEscuro === undefined ? undefined : validarCores(opcoes.coresEscuro, idsValidos, "colorsDark");
  const parcialClaro = tema === "dark" ? undefined : c;
  const parcialEscuro = tema === "light" ? undefined : (cd ?? c);
  const personalizado = temCor(parcialClaro) || temCor(parcialEscuro);
  const extras = personalizado || modelo === "model-3"; // o model-3 sempre precisa da escala de calor (--h0..--h4)

  const vars = (padrao, parcial) => {
    const s = comPadrao(padrao, parcial);
    let v = `--bg:${s.background};--card:${s.card};--line:${s.border};--fg:${s.text};--muted:${s.muted};--track:${s.track};`;
    if (extras) {
      v += `--accent:${s.accent};`;
      escalaCalor(s.background, s.accent).forEach((h, i) => (v += `--h${i}:${h};`));
      ids.forEach((id, i) => (v += `--t${i}:${parcial?.tools && Object.hasOwn(parcial.tools, id) ? parcial.tools[id] : corDe(id, ids)};`));
    }
    return v;
  };
  const claro = vars(PADRAO_CLARO, parcialClaro);
  const escuro = vars(PADRAO_ESCURO, parcialEscuro);
  const raiz =
    tema === "light"
      ? `:root{${claro}}`
      : tema === "dark"
        ? `:root{${escuro}}`
        : `:root{${claro}}@media (prefers-color-scheme: dark){:root{${escuro}}}`;
  const css =
    `${raiz}` +
    `text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;fill:var(--fg)}` +
    `.t{font-size:${tamanhoTitulo}px;font-weight:600}.s{font-size:12px;fill:var(--muted)}` +
    `.n{font-size:26px;font-weight:600}.l{font-size:12px;fill:var(--muted)}` +
    `.h{font-size:13px;font-weight:600}.v{font-size:11px;fill:var(--muted)}`;
  return {
    css,
    // cor de uma ferramenta: valor fixo (padrão) ou variável CSS (quando há cores personalizadas, que mudam entre claro e escuro)
    cor: (id) => (personalizado ? `var(--t${ids.indexOf(id)})` : corDe(id, ids)),
    acento: personalizado ? "var(--accent)" : COR_PROJETO,
  };
}

/** Formatadores dependentes de idioma. */
function formatadores(idioma) {
  const T = TEXTOS[idioma];
  const numero = (n) => n.toLocaleString(T.locale);
  const compacto = (n) => {
    let i = 0;
    let v = n;
    while (v >= 1000 && i < 3) {
      v /= 1000;
      i++;
    }
    if (i === 0) return String(n);
    return `${v.toLocaleString(T.locale, { maximumFractionDigits: 1 })}${T.sepUnidade}${T.unidades[i]}`;
  };
  const data = (iso) => {
    if (!iso) return "-";
    const [a, m, d] = iso.slice(0, 10).split("-");
    return T.data(a, m, d);
  };
  const rotuloMes = (mes) => {
    const [ano, m] = mes.split("-");
    return T.rotuloMes(T.meses[Number(m) - 1] ?? m, ano.slice(2));
  };
  return { numero, compacto, data, rotuloMes };
}

/** Soma a série diária por mês (AAAA-MM), mantendo a divisão por ferramenta. */
export function porMes(pontos) {
  const meses = new Map();
  for (const p of pontos) {
    const m = p.date.slice(0, 7);
    const alvo = meses.get(m) ?? new Map();
    for (const [id, v] of Object.entries(p.byTool)) {
      let a = alvo.get(id);
      if (!a) alvo.set(id, (a = { sessions: 0, userMessages: 0 }));
      a.sessions += v.sessions;
      a.userMessages += v.userMessages;
    }
    meses.set(m, alvo);
  }
  return [...meses.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([mes, porFerramenta]) => ({ mes, porFerramenta }));
}

function tile(x, y, w, rotulo, valor) {
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="64" rx="10" fill="var(--card)" stroke="var(--line)"/>` +
    `<text class="n" x="${x + 14}" y="${y + 33}">${esc(valor)}</text>` +
    `<text class="l" x="${x + 14}" y="${y + 52}">${esc(rotulo)}</text>`
  );
}

function graficoMensal(m, T, F, K, x, y, w, h) {
  const meses = porMes(m.timeline.points).slice(-6);
  const ids = m.tools.map((t) => t.id);
  const totais = meses.map((mes) => ids.reduce((s, id) => s + (mes.porFerramenta.get(id)?.sessions ?? 0), 0));
  const max = Math.max(1, ...totais);
  const base = y + h - 22;
  const alturaUtil = h - 96; // espaço para a legenda e para o número acima da barra mais alta
  const passo = meses.length ? (w - 20) / meses.length : 0;
  const larg = meses.length ? Math.min(54, passo - 14) : 0;

  let out = `<text class="h" x="${x}" y="${y + 14}">${esc(T.porMes)}</text>`;
  out += `<line x1="${x}" y1="${base}" x2="${x + w}" y2="${base}" stroke="var(--line)"/>`;

  meses.forEach((mes, i) => {
    const cx = x + 10 + i * passo + (passo - larg) / 2;
    let topo = base;
    for (const id of ids) {
      const v = mes.porFerramenta.get(id)?.sessions ?? 0;
      if (!v) continue;
      const alt = (v / max) * alturaUtil;
      topo -= alt;
      out += `<rect x="${cx.toFixed(1)}" y="${topo.toFixed(1)}" width="${larg.toFixed(1)}" height="${alt.toFixed(1)}" fill="${K.cor(id)}"/>`;
    }
    out += `<text class="v" x="${(cx + larg / 2).toFixed(1)}" y="${(topo - 5).toFixed(1)}" text-anchor="middle">${totais[i]}</text>`;
    out += `<text class="v" x="${(cx + larg / 2).toFixed(1)}" y="${base + 15}" text-anchor="middle">${esc(F.rotuloMes(mes.mes))}</text>`;
  });

  // Legenda (nomes como "ChatGPT (catálogo...)" viram "ChatGPT")
  let lx = x;
  const ly = y + 32;
  for (const t of m.tools) {
    const nome = cortar(t.name.split(" (")[0] || t.name, 20);
    out += `<rect x="${lx}" y="${ly - 9}" width="10" height="10" rx="2" fill="${K.cor(t.id)}"/>`;
    out += `<text class="v" x="${lx + 15}" y="${ly}">${esc(nome)}</text>`;
    lx += 15 + nome.length * 5.6 + 14;
  }
  return out;
}

function topProjetos(m, T, F, K, x, y, w) {
  // Ordena por mensagens suas; fontes sem mensagens caem para sessões.
  const lista = m.projects
    .map((p) => ({ nome: p.name, valor: p.userMessages > 0 ? p.userMessages : p.sessions, unidade: p.userMessages > 0 ? T.msg : T.sess }))
    .sort((a, b) => b.valor - a.valor)
    .slice(0, 6);
  const max = Math.max(1, ...lista.map((p) => p.valor));
  const barraX = x + 128;
  const barraW = w - 128 - 44;

  let out = `<text class="h" x="${x}" y="${y + 14}">${esc(T.projetos)}</text>`;
  if (!lista.length) out += `<text class="v" x="${x}" y="${y + 40}">${esc(T.semProjetos)}</text>`;
  lista.forEach((p, i) => {
    const ry = y + 34 + i * 30;
    out += `<text class="v" x="${x}" y="${ry + 11}">${esc(cortar(p.nome, 20))}</text>`;
    out += `<rect x="${barraX}" y="${ry}" width="${barraW}" height="14" rx="7" fill="var(--track)"/>`;
    out += `<rect x="${barraX}" y="${ry}" width="${Math.max(6, (p.valor / max) * barraW).toFixed(1)}" height="14" rx="7" fill="${K.acento}"/>`;
    out += `<text class="v" x="${barraX + barraW + 8}" y="${ry + 11}">${esc(F.numero(p.valor))} ${esc(p.unidade)}</text>`;
  });
  return out;
}

const plural = (n, um, varios) => (n === 1 ? um : varios);
const DIA_MS = 86_400_000;
const utcDe = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const isoDe = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Moldura comum: <svg> com tamanho fixo, título, descrição, CSS e o fundo arredondado. */
function moldura(W, H, titulo, descricao, css, corpo) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="ttl desc">` +
    `<title id="ttl">${esc(titulo)}</title>` +
    `<desc id="desc">${esc(descricao)}</desc>` +
    `<style>${css}</style>` +
    `<rect width="${W}" height="${H}" rx="14" fill="var(--bg)" stroke="var(--line)"/>` +
    corpo +
    `</svg>\n`
  );
}

// ---------- model-1: painel completo (padrão) ----------

function modelo1({ m, T, F, K, titulo, periodo, rodape }) {
  const W = 840;
  const H = 440;
  const tileW = (W - 40 - 3 * 12) / 4;
  const tiles = [
    [T.sessoes, F.numero(m.totals.sessions)],
    [T.mensagens, F.numero(m.totals.userMessages)],
    [T.tokens, F.compacto(m.totals.tokens.total)],
    [T.dias, F.numero(m.totals.activeDays)],
  ];
  const corpo =
    `<text class="t" x="20" y="38">${esc(titulo)}</text>` +
    `<text class="s" x="20" y="58">${esc(`${T.periodo}: ${periodo}`)}</text>` +
    tiles.map(([r, v], i) => tile(20 + i * (tileW + 12), 76, tileW, r, v)).join("") +
    graficoMensal(m, T, F, K, 20, 164, 380, 232) +
    topProjetos(m, T, F, K, 436, 164, W - 436 - 20) +
    `<text class="s" x="20" y="${H - 16}">${esc(rodape)}</text>`;
  return moldura(W, H, titulo, T.desc(periodo, m.totals.sessions, m.totals.userMessages, m.totals.activeDays), K.css, corpo);
}

// ---------- model-2: cartão compacto e estreito ----------

/** Segmento da barra empilhada; só as pontas externas da barra são arredondadas. */
function segmento(x, y, w, h, r, esq, dir, cor) {
  const rl = esq ? Math.min(r, w / 2) : 0;
  const rr = dir ? Math.min(r, w / 2) : 0;
  const f = (n) => n.toFixed(1);
  const d =
    `M${f(x + rl)} ${f(y)}H${f(x + w - rr)}` +
    (rr ? `A${f(rr)} ${f(rr)} 0 0 1 ${f(x + w)} ${f(y + rr)}` : "") +
    `V${f(y + h - rr)}` +
    (rr ? `A${f(rr)} ${f(rr)} 0 0 1 ${f(x + w - rr)} ${f(y + h)}` : "") +
    `H${f(x + rl)}` +
    (rl ? `A${f(rl)} ${f(rl)} 0 0 1 ${f(x)} ${f(y + h - rl)}` : "") +
    `V${f(y + rl)}` +
    (rl ? `A${f(rl)} ${f(rl)} 0 0 1 ${f(x + rl)} ${f(y)}` : "") +
    "Z";
  return `<path d="${d}" fill="${cor}"/>`;
}

function modelo2({ m, T, F, K, titulo, periodo, rodape }) {
  const W = 420;
  const tileW = (W - 40 - 12) / 2;
  const tiles = [
    [T.sessoes, F.numero(m.totals.sessions)],
    [T.mensagens, F.numero(m.totals.userMessages)],
    [T.tokens, F.compacto(m.totals.tokens.total)],
    [T.dias, F.numero(m.totals.activeDays)],
  ];
  const lista = m.tools
    .filter((t) => t.sessions > 0)
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 8);
  const total = lista.reduce((s, t) => s + t.sessions, 0);
  const barraY = 258;
  const barraW = W - 40;
  const legY = barraY + 34;
  const H = legY + Math.max(1, lista.length) * 22 + 38;

  let corpo =
    `<text class="t" x="20" y="38">${esc(cortar(titulo, 32))}</text>` +
    `<text class="s" x="20" y="58">${esc(`${T.periodo}: ${periodo}`)}</text>` +
    tiles.map(([r, v], i) => tile(20 + (i % 2) * (tileW + 12), 76 + Math.floor(i / 2) * 76, tileW, r, v)).join("");
  corpo += `<text class="h" x="20" y="${barraY - 14}">${esc(T.porFerramenta)}</text>`;
  corpo += `<rect x="20" y="${barraY}" width="${barraW}" height="14" rx="7" fill="var(--track)"/>`;
  if (total > 0) {
    let acum = 0;
    lista.forEach((t, i) => {
      const x = 20 + (acum / total) * barraW;
      acum += t.sessions;
      const xFim = 20 + (acum / total) * barraW;
      corpo += segmento(x, barraY, xFim - x, 14, 7, i === 0, i === lista.length - 1, K.cor(t.id));
    });
  }
  if (!lista.length) corpo += `<text class="v" x="20" y="${legY}">${esc(T.semDados)}</text>`;
  lista.forEach((t, i) => {
    const y = legY + i * 22;
    const nome = cortar(t.name.split(" (")[0] || t.name, 22);
    corpo += `<rect x="20" y="${y - 9}" width="10" height="10" rx="2" fill="${K.cor(t.id)}"/>`;
    corpo += `<text class="v" x="36" y="${y}">${esc(nome)}</text>`;
    corpo += `<text class="v" x="${W - 20}" y="${y}" text-anchor="end">${esc(`${F.numero(t.sessions)} · ${Math.round((100 * t.sessions) / total)}%`)}</text>`;
  });
  corpo += `<text class="s" x="20" y="${H - 16}">${esc(rodape)}</text>`;
  return moldura(W, H, titulo, T.desc(periodo, m.totals.sessions, m.totals.userMessages, m.totals.activeDays), K.css, corpo);
}

// ---------- model-3: calendário de atividade (mapa de calor) ----------

const COLUNAS = 53;
const PASSO = 14;
const CELULA = 11;

/**
 * Níveis 1-4 por quantis (posto mais próximo: q25, q50, q75) das sessões dos dias ATIVOS do período; nível 0 = sem atividade.
 * Se todos os dias ativos têm o mesmo valor, todos recebem o nível 4 (não há como graduar).
 * @param {number[]} valoresAtivos sessões de cada dia ativo (todas > 0)
 * @returns {(n: number) => number}
 */
export function niveisPorQuantil(valoresAtivos) {
  const v = [...valoresAtivos].sort((a, b) => a - b);
  const n = v.length;
  const q = (p) => v[Math.max(0, Math.ceil(p * n) - 1)];
  const [q1, q2, q3] = n ? [q(0.25), q(0.5), q(0.75)] : [0, 0, 0];
  const uniforme = n > 0 && v[0] === v[n - 1];
  return (x) => (x <= 0 ? 0 : uniforme ? 4 : x <= q1 ? 1 : x <= q2 ? 2 : x <= q3 ? 3 : 4);
}

function modelo3({ m, T, F, K, titulo, periodo, rodape }) {
  const x0 = 48;
  const y0 = 104;
  const gradeW = COLUNAS * PASSO - (PASSO - CELULA);
  const W = x0 + gradeW + 20;
  const H = 262;

  // Fim do período: a data de geração (UTC) ou o último dia com dados, o que for mais recente. A última coluna é a semana do fim.
  const candidatos = [m.generatedAt ? utcDe(String(m.generatedAt)) : NaN, ...m.timeline.points.map((p) => utcDe(p.date))].filter(Number.isFinite);
  const fim = candidatos.length ? Math.max(...candidatos) : 0;
  const domingoFinal = fim - new Date(fim).getUTCDay() * DIA_MS;
  const inicio = domingoFinal - (COLUNAS - 1) * 7 * DIA_MS;

  const porDia = new Map();
  for (const p of m.timeline.points) {
    const t = utcDe(p.date);
    if (t < inicio || t > fim) continue;
    porDia.set(p.date, (porDia.get(p.date) ?? 0) + p.sessions);
  }
  const ativos = [...porDia.values()].filter((n) => n > 0);
  const nivel = niveisPorQuantil(ativos);
  const totalSessoes = ativos.reduce((s, n) => s + n, 0);

  let corpo =
    `<text class="t" x="20" y="38">${esc(titulo)}</text>` +
    `<text class="s" x="20" y="58">${esc(`${F.numero(totalSessoes)} ${plural(totalSessoes, T.sessUm, T.sessVarios)} · ${F.numero(ativos.length)} ${plural(ativos.length, T.diaUm, T.diaVarios)} · ${T.calPeriodo}`)}</text>`;

  // Rótulos de mês: na primeira coluna do mês, sempre com 3 colunas ou mais de distância do rótulo anterior.
  let mesAnterior = -1;
  let colAnterior = -10;
  for (let c = 0; c < COLUNAS; c++) {
    const mes = new Date(inicio + c * 7 * DIA_MS).getUTCMonth();
    if (mes === mesAnterior) continue;
    mesAnterior = mes;
    if (c - colAnterior < 3) continue;
    colAnterior = c;
    corpo += `<text class="v" x="${x0 + c * PASSO}" y="${y0 - 8}">${esc(T.meses[mes])}</text>`;
  }
  T.semana.forEach((nome, r) => {
    if (nome) corpo += `<text class="v" x="${x0 - 8}" y="${y0 + r * PASSO + 9.5}" text-anchor="end">${esc(nome)}</text>`;
  });

  for (let c = 0; c < COLUNAS; c++) {
    for (let r = 0; r < 7; r++) {
      const t = inicio + (c * 7 + r) * DIA_MS;
      if (t > fim) continue;
      const data = isoDe(t);
      const n = porDia.get(data) ?? 0;
      corpo += `<rect x="${x0 + c * PASSO}" y="${y0 + r * PASSO}" width="${CELULA}" height="${CELULA}" rx="2" fill="var(--h${nivel(n)})"><title>${esc(`${data}: ${n} ${plural(n, T.sessUm, T.sessVarios)}`)}</title></rect>`;
    }
  }

  // Legenda "menos ... mais" (5 níveis) à direita e a nota da métrica à esquerda.
  const ly = y0 + 7 * PASSO + 24;
  const sx = x0 + gradeW - 36 - (5 * PASSO - (PASSO - CELULA)) - 4;
  corpo += `<text class="v" x="${x0}" y="${ly}">${esc(T.calNota)}</text>`;
  corpo += `<text class="v" x="${sx - 6}" y="${ly}" text-anchor="end">${esc(T.menos)}</text>`;
  for (let i = 0; i < 5; i++) corpo += `<rect x="${sx + i * PASSO}" y="${ly - 10}" width="${CELULA}" height="${CELULA}" rx="2" fill="var(--h${i})"/>`;
  corpo += `<text class="v" x="${sx + 5 * PASSO + 2}" y="${ly}">${esc(T.mais)}</text>`;
  corpo += `<text class="s" x="20" y="${H - 16}">${esc(rodape)}</text>`;
  return moldura(W, H, titulo, `${T.desc(periodo, m.totals.sessions, m.totals.userMessages, m.totals.activeDays)} ${T.calNota}.`, K.css, corpo);
}

/**
 * Gera o SVG a partir do JSON (já validado por schema.mjs).
 * `modelo`: "model-1" (padrão, painel completo), "model-2" (cartão compacto) ou "model-3" (calendário de atividade).
 * `cores` / `coresEscuro`: objetos de cores (src/cores.mjs); são validados aqui de novo e lançam erro se algo for inválido.
 * @param {Metricas} m
 * @param {{ tema?: Tema, titulo?: string, idioma?: "en"|"pt-BR", modelo?: string, cores?: object, coresEscuro?: object }} [opcoes]
 * @returns {string}
 */
export function gerarSvg(m, opcoes = {}) {
  const tema = TEMAS.includes(opcoes.tema) ? opcoes.tema : "auto";
  const idioma = IDIOMAS.includes(opcoes.idioma) ? opcoes.idioma : "en";
  const modelo = opcoes.modelo ?? MODELO_PADRAO;
  if (!MODELOS.includes(modelo)) throw new Error(`modelo inválido: use ${MODELOS.join("|")}.`);
  const T = { ...TEXTOS[idioma], calPeriodo: idioma === "en" ? "last 53 weeks" : "últimas 53 semanas" };
  const F = formatadores(idioma);
  const ids = m.tools.map((t) => t.id);
  const K = montarEstilo(tema, opcoes, ids, modelo, modelo === "model-2" ? 18 : 20);

  const periodo = m.period ? `${F.data(m.period.from)} - ${F.data(m.period.to)}` : T.semDados;
  const base = opcoes.titulo?.trim() ? cortar(opcoes.titulo.trim(), 60) : m.synthetic ? T.tituloExemplo : T.titulo;
  const titulo = m.synthetic && opcoes.titulo?.trim() ? `${base} (${idioma === "en" ? "sample" : "exemplo"})` : base;
  const rodape = modelo === "model-2" ? T.rodapeCurto(F.data(m.generatedAt)) : T.rodape(F.data(m.generatedAt));
  const ctx = { m, T, F, K, titulo, periodo, rodape };
  return modelo === "model-2" ? modelo2(ctx) : modelo === "model-3" ? modelo3(ctx) : modelo1(ctx);
}
