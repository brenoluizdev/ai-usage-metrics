// Fixtures 100% sintéticas: nomes, datas e números inventados. Nunca copie conversas reais para cá.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { DatabaseSync } from "node:sqlite";

// Toda pasta criada por homeFalsa() é apagada ao fim do arquivo de teste que importou este módulo (B6: nada sobra em %TEMP%).
const criadas = [];
after(async () => {
  for (const p of criadas.splice(0)) await rm(p, { recursive: true, force: true });
});

export async function homeFalsa() {
  const home = await mkdtemp(join(tmpdir(), "ai-usage-teste-"));
  criadas.push(home);
  return home;
}

const linha = (o) => JSON.stringify(o);

/** Cria uma sessão do Claude Code com 2 prompts, 1 resultado de ferramenta, 1 meta e 1 resposta repetida. */
export async function claudeFalso(home, { pasta = "proj-a", cwd = "C:\\Users\\fulano\\Desktop\\projeto-alfa", sessao = "sess-1", dia = "2026-03-01" } = {}) {
  const dir = join(home, ".claude", "projects", pasta);
  await mkdir(dir, { recursive: true });
  const t = (h) => `${dia}T${h}:00:00.000Z`;
  const usage = (i, o, cr, cw) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
  const linhas = [
    { type: "mode", sessionId: sessao },
    { type: "user", cwd, timestamp: t("10"), message: { role: "user", content: "TEXTO-SECRETO-1" } },
    { type: "assistant", cwd, timestamp: t("10"), message: { id: "m1", model: "modelo-x", usage: usage(10, 5, 100, 50), content: [{ type: "text", text: "RESPOSTA-SECRETA" }] } },
    // mesma resposta repetida (um bloco por linha): deve contar uma vez
    { type: "assistant", cwd, timestamp: t("10"), message: { id: "m1", model: "modelo-x", usage: usage(10, 7, 100, 50), content: [{ type: "tool_use" }] } },
    { type: "user", cwd, timestamp: t("11"), message: { role: "user", content: [{ type: "tool_result", content: "SAIDA-DA-FERRAMENTA" }] } },
    { type: "user", cwd, timestamp: t("11"), isMeta: true, message: { role: "user", content: "meta" } },
    { type: "user", cwd, timestamp: t("12"), message: { role: "user", content: [{ type: "text", text: "TEXTO-SECRETO-2" }] } },
    { type: "assistant", cwd, timestamp: t("12"), message: { id: "m2", model: "<synthetic>", usage: usage(1, 1, 1, 1), content: [] } },
    { type: "assistant", cwd, timestamp: t("13"), message: { id: "m3", model: "modelo-x", usage: usage(1, 2, 3, 4), content: [] } },
  ];
  await writeFile(join(dir, `${sessao}.jsonl`), linhas.map(linha).join("\n") + "\n{linha-truncada", "utf8");
  return dir;
}

export async function subagenteFalso(home, { pasta = "proj-a", sessao = "sess-1", cwd = "C:\\Users\\fulano\\Desktop\\projeto-alfa" } = {}) {
  const dir = join(home, ".claude", "projects", pasta, sessao, "subagents");
  await mkdir(dir, { recursive: true });
  const l = { type: "assistant", isSidechain: true, cwd, timestamp: "2026-03-01T14:00:00.000Z", message: { id: "s1", model: "modelo-x", usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } };
  await writeFile(join(dir, "agent-abc.jsonl"), linha(l) + "\n", "utf8");
}

/** Banco do Cline com uma sessão e um subagente. */
export async function clineFalso(home) {
  const dbDir = join(home, ".cline", "data", "db");
  const sessDir = join(home, ".cline", "data", "sessions", "s1");
  await mkdir(dbDir, { recursive: true });
  await mkdir(sessDir, { recursive: true });
  const msgPai = join(sessDir, "s1.messages.json");
  const msgSub = join(sessDir, "agent_1.messages.json");
  const ts = Date.parse("2026-03-02T09:00:00.000Z");
  await writeFile(
    msgPai,
    JSON.stringify({
      messages: [
        { id: "1", role: "user", ts, content: [{ type: "text", text: "PEDIDO-SECRETO" }] },
        { id: "2", role: "assistant", ts: ts + 1000, content: [], metrics: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0 } },
        { id: "3", role: "user", ts: ts + 2000, content: [{ type: "tool_result", content: "x" }] },
      ],
    }),
  );
  await writeFile(msgSub, JSON.stringify({ messages: [{ id: "1", role: "assistant", ts: ts + 3000, content: [], metrics: { inputTokens: 1, outputTokens: 1 } }] }));
  const db = new DatabaseSync(join(dbDir, "sessions.db"));
  db.exec("CREATE TABLE sessions (session_id TEXT, started_at TEXT, cwd TEXT, workspace_root TEXT, is_subagent INTEGER, messages_path TEXT)");
  const ins = db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?)");
  ins.run("s1", "2026-03-02T09:00:00.000Z", "C:\\Users\\fulano\\Desktop\\projeto-beta", "C:\\Users\\fulano\\Desktop\\projeto-beta", 0, msgPai);
  ins.run("s1__agent_1", "2026-03-02T09:01:00.000Z", "C:\\Users\\fulano\\Desktop\\projeto-beta", "C:\\Users\\fulano\\Desktop\\projeto-beta", 1, msgSub);
  db.close();
}

export async function codexFalso(home) {
  const dir = join(home, ".codex", "sqlite");
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "codex.db"));
  db.exec("CREATE TABLE local_thread_catalog (thread_id TEXT, display_title TEXT, source_created_at REAL, cwd TEXT, source_kind TEXT, missing_candidate INTEGER)");
  const ins = db.prepare("INSERT INTO local_thread_catalog VALUES (?,?,?,?,?,?)");
  ins.run("t1", "TITULO-SECRETO", Date.parse("2026-03-03T10:00:00Z") / 1000, null, "chatgpt", 0);
  ins.run("t2", "TITULO-SECRETO-2", Date.parse("2026-03-04T10:00:00Z") / 1000, null, "chatgpt", 0);
  ins.run("t3", "x", Date.parse("2026-03-04T10:00:00Z") / 1000, null, "chatgpt", 1); // ausente: ignorada
  ins.run("t4", "x", Date.parse("2026-03-04T10:00:00Z") / 1000, "C:\\Users\\fulano\\Desktop\\outro", "codex", 0); // não é ChatGPT
  db.close();
}
