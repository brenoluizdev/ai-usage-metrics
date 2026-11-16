import { access } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_CWD_CHARS, avisoCwdGrande, tsValido } from "./seguro.mjs";

const dbPath = (home) => join(home, ".codex", "sqlite", "codex.db");

/**
 * O app desktop (Codex) guarda um catálogo local das conversas do ChatGPT: título, datas e origem.
 * Lemos só id, data de criação e cwd; o título NUNCA é lido. Não há mensagens, tokens nem projeto.
 * @type {import("../types.mjs").Adapter}
 */
export const chatgptCodexApp = {
  id: "chatgpt",
  name: "ChatGPT (catálogo do app desktop)",
  capabilities: { messages: false, tokens: false, projects: false },
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
      db = new DatabaseSync(dbPath(ctx.home), { readOnly: true }) /* somente leitura */;
    } catch {
      return;
    }
    let linhas;
    try {
      linhas = db
        .prepare(`SELECT thread_id, source_created_at, CASE WHEN length(cwd) > ${MAX_CWD_CHARS} THEN NULL ELSE cwd END AS cwd, (length(cwd) > ${MAX_CWD_CHARS}) AS cwd_grande FROM local_thread_catalog WHERE source_kind = 'chatgpt' AND missing_candidate = 0 LIMIT 200000`)
        .all();
    } catch {
      return; // esquema diferente do esperado
    } finally {
      db.close();
    }
    if (linhas.some((r) => r.cwd_grande)) ctx?.avisar?.(avisoCwdGrande("ChatGPT/Codex"));
    for (const r of linhas) {
      const ts = Number(r.source_created_at) * 1000;
      if (!tsValido(ts) || (ctx.since && ts < ctx.since)) continue;
      yield { tool: "chatgpt", project: r.cwd ? String(r.cwd) : null, session: String(r.thread_id), ts, kind: "session" };
    }
  },
};
