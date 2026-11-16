// Validador do esquema v1 com ALLOWLIST ESTRITA: só os campos abaixo são aceitos, com formato fixo.
// Qualquer campo extra, texto livre, caminho, e-mail ou valor fora do formato é rejeitado.
// É a última porta antes de enviar algo para um repositório público.

/** @typedef {import("./types.mjs").Metricas} Metricas */

const ID_FERRAMENTA = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** Nomes exibidos: letras, números, espaço e . _ ( ) + - (até 60). Sem barras, arroba, dois-pontos etc. */
const NOME_EXIBIDO = /^[\p{L}\p{N} ._()+-]{1,60}$/u;
// Nomes que são propriedades herdadas de objetos JS: rejeitados como id (defesa em profundidade; o código usa Map).
const ID_RESERVADOS = new Set(["constructor", "prototype", "valueof", "tostring", "hasownproperty", "isprototypeof", "propertyisenumerable", "tolocalestring", "proto", "__proto__"]);
const NOME_PRIVADO = /^projeto-privado-\d{1,4}$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const INSTANTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const MAX_FERRAMENTAS = 50;
export const MAX_PROJETOS = 1000;
export const MAX_PONTOS = 4000;
const MAX_NUMERO = 1e15;

const ehObjeto = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function dataValida(s) {
  if (typeof s !== "string" || !DATA.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Valida um objeto contra o esquema v1.
 * @param {unknown} json
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validarMetricas(json) {
  const errors = [];
  const erro = (caminho, msg) => {
    if (errors.length < 60) errors.push(`${caminho}: ${msg}`);
  };

  /** exige exatamente estas chaves (nem mais, nem menos) */
  const chaves = (o, caminho, esperadas) => {
    if (!ehObjeto(o)) {
      erro(caminho, "deve ser um objeto");
      return false;
    }
    for (const k of Object.keys(o)) if (!esperadas.includes(k)) erro(`${caminho}.${k}`, "campo não permitido");
    for (const k of esperadas) if (!(k in o)) erro(`${caminho}.${k}`, "campo obrigatório ausente");
    return true;
  };
  const inteiro = (v, caminho) => {
    if (!Number.isSafeInteger(v) || v < 0 || v > MAX_NUMERO) erro(caminho, "deve ser inteiro de 0 a 1e15");
  };
  const booleano = (v, caminho) => {
    if (typeof v !== "boolean") erro(caminho, "deve ser verdadeiro/falso");
  };
  const data = (v, caminho, anulavel = false) => {
    if (anulavel && v === null) return;
    if (!dataValida(v)) erro(caminho, "deve ser uma data AAAA-MM-DD válida");
  };
  const idFerramenta = (v, caminho) => {
    if (typeof v !== "string" || !ID_FERRAMENTA.test(v) || ID_RESERVADOS.has(v)) erro(caminho, "id inválido (minúsculas, números e hífen)");
  };
  const nomeExibido = (v, caminho) => {
    if (typeof v !== "string" || !NOME_EXIBIDO.test(v)) erro(caminho, "nome inválido (letras, números, espaço e . _ ( ) + -; até 60)");
  };
  const tokens = (t, caminho) => {
    if (!chaves(t, caminho, ["input", "output", "cacheRead", "cacheWrite", "total"])) return;
    for (const k of ["input", "output", "cacheRead", "cacheWrite", "total"]) inteiro(t[k], `${caminho}.${k}`);
    if (t.total !== t.input + t.output + t.cacheRead + t.cacheWrite) erro(`${caminho}.total`, "não bate com a soma dos tipos de token");
  };
  const contagens = (o, caminho) => {
    inteiro(o.sessions, `${caminho}.sessions`);
    inteiro(o.userMessages, `${caminho}.userMessages`);
    inteiro(o.assistantMessages, `${caminho}.assistantMessages`);
    tokens(o.tokens, `${caminho}.tokens`);
  };

  if (!chaves(json, "$", ["schemaVersion", "generatedAt", "synthetic", "period", "totals", "tools", "projects", "timeline"])) {
    return { ok: false, errors };
  }
  if (json.schemaVersion !== 1) erro("$.schemaVersion", "só o esquema 1 é suportado");
  if (typeof json.generatedAt !== "string" || !INSTANTE.test(json.generatedAt) || Number.isNaN(Date.parse(json.generatedAt))) {
    erro("$.generatedAt", "deve ser um instante ISO em UTC (AAAA-MM-DDTHH:MM:SSZ)");
  }
  booleano(json.synthetic, "$.synthetic");

  if (json.period !== null) {
    if (chaves(json.period, "$.period", ["from", "to"])) {
      data(json.period.from, "$.period.from");
      data(json.period.to, "$.period.to");
    }
  }

  if (chaves(json.totals, "$.totals", ["projects", "sessions", "userMessages", "assistantMessages", "activeDays", "tokens"])) {
    for (const k of ["projects", "sessions", "userMessages", "assistantMessages", "activeDays"]) inteiro(json.totals[k], `$.totals.${k}`);
    tokens(json.totals.tokens, "$.totals.tokens");
  }

  if (!Array.isArray(json.tools) || json.tools.length > MAX_FERRAMENTAS) erro("$.tools", `deve ser uma lista com até ${MAX_FERRAMENTAS} itens`);
  else {
    json.tools.forEach((t, i) => {
      const c = `$.tools[${i}]`;
      if (!chaves(t, c, ["id", "name", "provides", "sessions", "userMessages", "assistantMessages", "tokens", "firstActivity", "lastActivity"])) return;
      idFerramenta(t.id, `${c}.id`);
      nomeExibido(t.name, `${c}.name`);
      if (chaves(t.provides, `${c}.provides`, ["messages", "tokens"])) {
        booleano(t.provides.messages, `${c}.provides.messages`);
        booleano(t.provides.tokens, `${c}.provides.tokens`);
      }
      contagens(t, c);
      data(t.firstActivity, `${c}.firstActivity`, true);
      data(t.lastActivity, `${c}.lastActivity`, true);
    });
  }

  if (!Array.isArray(json.projects) || json.projects.length > MAX_PROJETOS) erro("$.projects", `deve ser uma lista com até ${MAX_PROJETOS} itens`);
  else {
    json.projects.forEach((p, i) => {
      const c = `$.projects[${i}]`;
      if (!chaves(p, c, ["name", "public", "sessions", "userMessages", "assistantMessages", "tokens", "firstActivity", "lastActivity", "tools"])) return;
      booleano(p.public, `${c}.public`);
      if (p.public === false) {
        if (typeof p.name !== "string" || !NOME_PRIVADO.test(p.name)) erro(`${c}.name`, 'projeto não público deve se chamar "projeto-privado-N"');
      } else nomeExibido(p.name, `${c}.name`);
      contagens(p, c);
      data(p.firstActivity, `${c}.firstActivity`, true);
      data(p.lastActivity, `${c}.lastActivity`, true);
      if (!Array.isArray(p.tools) || p.tools.length > MAX_FERRAMENTAS) erro(`${c}.tools`, "lista inválida");
      else {
        p.tools.forEach((t, j) => {
          const cc = `${c}.tools[${j}]`;
          if (!chaves(t, cc, ["id", "sessions", "userMessages", "assistantMessages", "tokens"])) return;
          idFerramenta(t.id, `${cc}.id`);
          contagens(t, cc);
        });
      }
    });
  }

  if (chaves(json.timeline, "$.timeline", ["granularity", "timezone", "points"])) {
    if (json.timeline.granularity !== "day") erro("$.timeline.granularity", 'deve ser "day"');
    if (json.timeline.timezone !== "UTC") erro("$.timeline.timezone", 'deve ser "UTC"');
    const pts = json.timeline.points;
    if (!Array.isArray(pts) || pts.length > MAX_PONTOS) erro("$.timeline.points", `deve ser uma lista com até ${MAX_PONTOS} itens`);
    else {
      pts.forEach((p, i) => {
        const c = `$.timeline.points[${i}]`;
        if (!chaves(p, c, ["date", "sessions", "userMessages", "assistantMessages", "tokens", "byTool"])) return;
        data(p.date, `${c}.date`);
        for (const k of ["sessions", "userMessages", "assistantMessages", "tokens"]) inteiro(p[k], `${c}.${k}`);
        if (!ehObjeto(p.byTool) || Object.keys(p.byTool).length > MAX_FERRAMENTAS) erro(`${c}.byTool`, "deve ser um objeto por ferramenta");
        else {
          for (const [id, v] of Object.entries(p.byTool)) {
            idFerramenta(id, `${c}.byTool(chave)`);
            if (chaves(v, `${c}.byTool.${id}`, ["sessions", "userMessages", "tokens"])) {
              for (const k of ["sessions", "userMessages", "tokens"]) inteiro(v[k], `${c}.byTool.${id}.${k}`);
            }
          }
        }
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Lança erro com a lista de problemas se o JSON não obedecer ao esquema. */
export function exigirMetricasValidas(json) {
  const { ok, errors } = validarMetricas(json);
  if (!ok) throw new Error(`JSON recusado pelo esquema v1 (allowlist estrita):\n  - ${errors.join("\n  - ")}`);
  return /** @type {Metricas} */ (json);
}
