// Gerador do SVG do painel. Determinístico, sem dependências e sem IA: mesmo JSON + mesmas opções = mesmo SVG.
// O SVG é autocontido (CSS inline, sem script, sem fonte nem imagem externa), pois o GitHub só exibe SVG assim em README.

/** @typedef {import("./types.mjs").Metricas} Metricas */
/** @typedef {"auto"|"light"|"dark"} Tema */

export const TEMAS = ["auto", "light", "dark"];
export const IDIOMAS = ["en", "pt-BR"];

const W = 840;
const H = 440;

// Cores por ferramenta conhecida; as demais recebem uma cor estável da paleta, pela posição.
// Map (e não objeto): ids como "constructor" ou "__proto__" não podem cair em propriedades herdadas.
const COR = new Map([["claude-code", "#d97757"], ["cline", "#10b981"], ["chatgpt", "#f59e0b"]]);
const PALETA = ["#6366f1", "#14b8a6", "#ec4899", "#84cc16", "#0ea5e9", "#a855f7"];
const COR_PROJETO = "#d97757";

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

function estilo(tema) {
  const claro = "--bg:#ffffff;--card:#f6f8fa;--line:#d0d7de;--fg:#1f2328;--muted:#656d76;--track:#e6eaee;";
  const escuro = "--bg:#0d1117;--card:#161b22;--line:#30363d;--fg:#e6edf3;--muted:#8b949e;--track:#21262d;";
  const vars =
    tema === "light"
      ? `:root{${claro}}`
      : tema === "dark"
        ? `:root{${escuro}}`
        : `:root{${claro}}@media (prefers-color-scheme: dark){:root{${escuro}}}`;
  return (
    `${vars}` +
    `text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;fill:var(--fg)}` +
    `.t{font-size:20px;font-weight:600}.s{font-size:12px;fill:var(--muted)}` +
    `.n{font-size:26px;font-weight:600}.l{font-size:12px;fill:var(--muted)}` +
    `.h{font-size:13px;font-weight:600}.v{font-size:11px;fill:var(--muted)}`
  );
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

function graficoMensal(m, T, F, x, y, w, h) {
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
      out += `<rect x="${cx.toFixed(1)}" y="${topo.toFixed(1)}" width="${larg.toFixed(1)}" height="${alt.toFixed(1)}" fill="${corDe(id, ids)}"/>`;
    }
    out += `<text class="v" x="${(cx + larg / 2).toFixed(1)}" y="${(topo - 5).toFixed(1)}" text-anchor="middle">${totais[i]}</text>`;
    out += `<text class="v" x="${(cx + larg / 2).toFixed(1)}" y="${base + 15}" text-anchor="middle">${esc(F.rotuloMes(mes.mes))}</text>`;
  });

  // Legenda (nomes como "ChatGPT (catálogo...)" viram "ChatGPT")
  let lx = x;
  const ly = y + 32;
  for (const t of m.tools) {
    const nome = cortar(t.name.split(" (")[0] || t.name, 20);
    out += `<rect x="${lx}" y="${ly - 9}" width="10" height="10" rx="2" fill="${corDe(t.id, ids)}"/>`;
    out += `<text class="v" x="${lx + 15}" y="${ly}">${esc(nome)}</text>`;
    lx += 15 + nome.length * 5.6 + 14;
  }
  return out;
}

function topProjetos(m, T, F, x, y, w) {
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
    out += `<rect x="${barraX}" y="${ry}" width="${Math.max(6, (p.valor / max) * barraW).toFixed(1)}" height="14" rx="7" fill="${COR_PROJETO}"/>`;
    out += `<text class="v" x="${barraX + barraW + 8}" y="${ry + 11}">${esc(F.numero(p.valor))} ${esc(p.unidade)}</text>`;
  });
  return out;
}

/**
 * Gera o SVG do painel a partir do JSON (já validado por schema.mjs).
 * @param {Metricas} m
 * @param {{ tema?: Tema, titulo?: string, idioma?: "en"|"pt-BR" }} [opcoes]
 * @returns {string}
 */
export function gerarSvg(m, opcoes = {}) {
  const tema = TEMAS.includes(opcoes.tema) ? opcoes.tema : "auto";
  const idioma = IDIOMAS.includes(opcoes.idioma) ? opcoes.idioma : "en";
  const T = TEXTOS[idioma];
  const F = formatadores(idioma);

  const periodo = m.period ? `${F.data(m.period.from)} - ${F.data(m.period.to)}` : T.semDados;
  const tileW = (W - 40 - 3 * 12) / 4;
  const tiles = [
    [T.sessoes, F.numero(m.totals.sessions)],
    [T.mensagens, F.numero(m.totals.userMessages)],
    [T.tokens, F.compacto(m.totals.tokens.total)],
    [T.dias, F.numero(m.totals.activeDays)],
  ];

  const base = opcoes.titulo?.trim() ? cortar(opcoes.titulo.trim(), 60) : m.synthetic ? T.tituloExemplo : T.titulo;
  const titulo = m.synthetic && opcoes.titulo?.trim() ? `${base} (${idioma === "en" ? "sample" : "exemplo"})` : base;
  const rodape = T.rodape(F.data(m.generatedAt));

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="ttl desc">` +
    `<title id="ttl">${esc(titulo)}</title>` +
    `<desc id="desc">${esc(T.desc(periodo, m.totals.sessions, m.totals.userMessages, m.totals.activeDays))}</desc>` +
    `<style>${estilo(tema)}</style>` +
    `<rect width="${W}" height="${H}" rx="14" fill="var(--bg)" stroke="var(--line)"/>` +
    `<text class="t" x="20" y="38">${esc(titulo)}</text>` +
    `<text class="s" x="20" y="58">${esc(`${T.periodo}: ${periodo}`)}</text>` +
    tiles.map(([r, v], i) => tile(20 + i * (tileW + 12), 76, tileW, r, v)).join("") +
    graficoMensal(m, T, F, 20, 164, 380, 232) +
    topProjetos(m, T, F, 436, 164, W - 436 - 20) +
    `<text class="s" x="20" y="${H - 16}">${esc(rodape)}</text>` +
    `</svg>\n`
  );
}
