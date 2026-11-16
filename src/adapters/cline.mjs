import { access, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_CWD_CHARS, MAX_MENSAGENS_JSON_BYTES, arquivoDentroDoLimite, avisoCwdGrande, num, tsValido } from "./seguro.mjs";

const MAX_SESSOES = 200_000;

/** O banco é de outro programa (o Cline): ficamos em modo SOMENTE LEITURA (readOnly: true; coberto em teste). */
const abrirSomenteLeitura = (arquivo) => new DatabaseSync(arquivo, { readOnly: true });

/**
 * Só lemos messages_path se, depois de resolver links simbólicos, ele ficar DENTRO de <home>/.cline e for arquivo comum
 * de tamanho razoável. O caminho vem do banco (dado não confiável): sem isso, uma linha adulterada leria qualquer arquivo.
 */
async function lerMensagens(caminho, home, ctx) {
  try {
    const raiz = await realpath(join(home, ".cline"));
    const real = await realpath(String(caminho));
    if (!real.startsWith(raiz + sep)) {
      ctx?.avisar?.("Cline: um messages_path fora de ~/.cline foi ignorado.");
      return [];
    }
    if (!(await arquivoDentroDoLimite(real, MAX_MENSAGENS_JSON_BYTES, ctx, "Cline"))) return [];
    const j = JSON.parse(await readFile(real, "utf8"));
    return Array.isArray(j?.messages) ? j.messages : [];
  } catch {
    return []; // arquivo ausente ou ilegível: segue só com o início da sessão
  }
}

const dbPath = (home) => join(home, ".cline", "data", "db", "sessions.db");

/**
 * Cline CLI: tabela `sessions` (cwd, início, modelo) + arquivo `.messages.json` de cada sessão.
 * Subagentes (is_subagent = 1) entram na sessão-mãe. Prompts do sistema e textos são ignorados.
 * @type {import("../types.mjs").Adapter}
 */
export const cline = {
  id: "cline",
  name: "Cline (CLI)",
  capabilities: { messages: true, tokens: true, projects: true },
  async available(ctx) {
    try {
      await access(dbPath(ctx.home));
      return true;
    } catch {
      return false;
    }
  },
  async *events(ctx) {
    let db;
    try {
      db = abrirSomenteLeitura(dbPath(ctx.home));
    } catch {
      return;
    }
    let linhas;
    try {
      linhas = db
        .prepare(`SELECT session_id, started_at, CASE WHEN length(cwd) > ${MAX_CWD_CHARS} THEN NULL ELSE cwd END AS cwd, CASE WHEN length(workspace_root) > ${MAX_CWD_CHARS} THEN NULL ELSE workspace_root END AS workspace_root, (length(cwd) > ${MAX_CWD_CHARS} OR length(workspace_root) > ${MAX_CWD_CHARS}) AS cwd_grande, is_subagent, messages_path FROM sessions LIMIT ${MAX_SESSOES}`)
        .all();
    } catch {
      return; // esquema diferente do esperado
    } finally {
      db.close();
    }
    if (linhas.some((s) => s.cwd_grande)) ctx?.avisar?.(avisoCwdGrande("Cline"));
    for (const s of linhas) {
      const sessao = String(s.is_subagent ? String(s.session_id).split("__")[0] : s.session_id);
      const project = s.workspace_root || s.cwd || null;
      const inicio = Date.parse(s.started_at);
      const msgs = s.messages_path ? await lerMensagens(s.messages_path, ctx.home, ctx) : [];
      if (!s.is_subagent && tsValido(inicio) && (!ctx.since || inicio >= ctx.since)) {
        yield { tool: "cline", project, session: sessao, ts: inicio, kind: "session" };
      }
      for (const m of msgs) {
        if (!m || typeof m !== "object") continue;
        const ts = typeof m.ts === "number" ? m.ts : inicio;
        if (!tsValido(ts) || (ctx.since && ts < ctx.since)) continue; // data absurda: descarta o evento
        if (m.role === "user" && !s.is_subagent) {
          const c = m.content;
          const digitado =
            typeof c === "string" || (Array.isArray(c) && c.some((b) => b?.type === "text") && !c.some((b) => b?.type === "tool_result"));
          if (digitado) yield { tool: "cline", project, session: sessao, ts, kind: "user" };
        } else if (m.role === "assistant") {
          const k = m.metrics ?? {};
          yield {
            tool: "cline",
            project,
            session: sessao,
            ts,
            kind: "assistant",
            tokens: {
              input: num(k.inputTokens),
              output: num(k.outputTokens),
              cacheRead: num(k.cacheReadTokens),
              cacheWrite: num(k.cacheWriteTokens),
            },
          };
        }
      }
    }
  },
};
