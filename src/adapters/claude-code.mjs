import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { MAX_ARQUIVO_BYTES, MAX_IDS_POR_ARQUIVO, MAX_PROMPTS_POR_ARQUIVO, arquivoDentroDoLimite, avisoCwdGrande, cwdGrande, lerLinhas, num, tsValido } from "./seguro.mjs";

/** Pasta com as transcrições: <home>/.claude/projects */
const raiz = (home) => join(home, ".claude", "projects");

async function existe(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Lista os .jsonl de sessão e de subagentes. Retorna [{ arquivo, session }]. */
async function listarArquivos(base) {
  const out = [];
  let projetos;
  try {
    projetos = await readdir(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const p of projetos) {
    if (!p.isDirectory()) continue;
    const dir = join(base, p.name);
    let itens;
    try {
      itens = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of itens) {
      if (it.isFile() && it.name.endsWith(".jsonl")) {
        out.push({ arquivo: join(dir, it.name), session: it.name.slice(0, -6) });
      } else if (it.isDirectory()) {
        // <sessão>/subagents/agent-*.jsonl: o custo dos subagentes entra na sessão-mãe.
        const sub = join(dir, it.name, "subagents");
        let subs = [];
        try {
          subs = await readdir(sub);
        } catch {
          /* sem subagentes */
        }
        for (const s of subs) if (s.endsWith(".jsonl")) out.push({ arquivo: join(sub, s), session: it.name });
      }
    }
  }
  return out;
}

/** Mensagem de verdade do usuário: texto digitado, não resultado de ferramenta nem meta. */
function ehPromptDoUsuario(linha) {
  if (linha.isMeta || linha.isSidechain) return false;
  const c = linha.message?.content;
  if (typeof c === "string") return !c.startsWith("<local-command-") && c.trim() !== "";
  if (Array.isArray(c)) {
    if (c.some((b) => b?.type === "tool_result")) return false;
    return c.some((b) => b?.type === "text" || b?.type === "image");
  }
  return false;
}

/** Lê um arquivo em streaming e devolve eventos. O texto é descartado linha a linha. */
async function* lerArquivo({ arquivo, session }, since, ctx) {
  // Teto de tamanho por arquivo e por linha: um arquivo adversarial não pode esgotar memória nem tempo.
  if (!(await arquivoDentroDoLimite(arquivo, MAX_ARQUIVO_BYTES, ctx, "Claude Code"))) return;
  let descartadas = 0;
  let excedentes = 0; // entradas distintas além dos tetos por arquivo
  const rl = lerLinhas(arquivo, { aoDescartar: () => descartadas++ });
  let cwd = null;
  let cwdGigante = false;
  const usuario = [];
  /** @type {Map<string, {ts:number, tokens:import("../types.mjs").Tokens}>} */
  const respostas = new Map();
  for await (const texto of rl) {
    if (!texto) continue;
    let l;
    try {
      l = JSON.parse(texto);
    } catch {
      continue; // linha truncada (sessão em andamento)
    }
    // Guard ANTES de qualquer leitura de propriedade: `null`, números, strings, booleanos e arrays são linhas inválidas.
    if (!l || typeof l !== "object" || Array.isArray(l)) continue;
    if (!cwd && typeof l.cwd === "string" && l.cwd) {
      if (cwdGrande(l.cwd)) cwdGigante = true; // não guarda: um cwd de 16 MiB multiplicado por milhares de arquivos esgotaria a memória
      else cwd = l.cwd;
    }
    const ts = Date.parse(l.timestamp);
    if (!tsValido(ts)) continue; // data ausente/absurda: descarta o evento, não aborta
    if (l.type === "user" && ehPromptDoUsuario(l)) {
      if (usuario.length < MAX_PROMPTS_POR_ARQUIVO) usuario.push(ts);
      else excedentes++;
    } else if (l.type === "assistant" && !l.isApiErrorMessage && l.message?.usage && l.message.model !== "<synthetic>") {
      // Uma resposta aparece em várias linhas (uma por bloco) com o mesmo message.id: guarda só a última.
      const u = l.message.usage;
      const idBruto = [l.message.id, l.requestId, l.uuid].find((x) => typeof x === "string" && x);
      const id = idBruto ?? `linha-${respostas.size}`;
      if (!respostas.has(id) && respostas.size >= MAX_IDS_POR_ARQUIVO) {
        excedentes++;
        continue;
      }
      respostas.set(id, {
        ts,
        tokens: {
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          cacheRead: num(u.cache_read_input_tokens),
          cacheWrite: num(u.cache_creation_input_tokens),
        },
      });
    }
  }
  if (excedentes) ctx?.avisar?.(`Claude Code: um arquivo passou do teto de entradas distintas (${MAX_IDS_POR_ARQUIVO} respostas / ${MAX_PROMPTS_POR_ARQUIVO} mensagens); ${excedentes} registro(s) excedente(s) foram ignorados.`);
  if (cwdGigante && !cwd) ctx?.avisar?.(avisoCwdGrande("Claude Code"));
  if (descartadas) ctx?.avisar?.(`Claude Code: ${descartadas} linha(s) maiores que o limite foram ignoradas.`);
  for (const ts of usuario) if (!since || ts >= since) yield { tool: "claude-code", project: cwd, session, ts, kind: "user" };
  for (const r of respostas.values())
    if (!since || r.ts >= since) yield { tool: "claude-code", project: cwd, session, ts: r.ts, kind: "assistant", tokens: r.tokens };
}

/** @type {import("../types.mjs").Adapter} */
export const claudeCode = {
  id: "claude-code",
  name: "Claude Code",
  capabilities: { messages: true, tokens: true, projects: true },
  available: (ctx) => existe(raiz(ctx.home)),
  async *events(ctx) {
    for (const f of await listarArquivos(raiz(ctx.home))) yield* lerArquivo(f, ctx.since, ctx);
  },
};
