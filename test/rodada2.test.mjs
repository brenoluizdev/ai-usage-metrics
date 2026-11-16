// Segunda rodada de endurecimento (auditoria 2). Fixtures sintéticas, pastas temporárias, sem rede.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { claudeCode } from "../src/adapters/claude-code.mjs";
import { validarRemoto } from "../src/config.mjs";

const pastas = [];
after(async () => {
  for (const p of pastas) await rm(p, { recursive: true, force: true });
});
const tmp = async (prefixo = "ai-usage-metrics-r2-") => {
  const d = await mkdtemp(join(tmpdir(), prefixo));
  pastas.push(d);
  return d;
};
const coletar = async (adapter, ctx) => {
  const out = [];
  for await (const e of adapter.events(ctx)) out.push(e);
  return out;
};

// ---------- N1 ----------
test("N1: linhas null/número/string/array/booleano/truncadas/cwd de tipo errado são ignoradas sem abortar", async () => {
  const home = await tmp();
  const dir = join(home, ".claude", "projects", "p");
  await mkdir(dir, { recursive: true });
  const ok = (id, h) => JSON.stringify({ type: "assistant", cwd: "/x/proj", timestamp: `2026-03-01T${h}:00:00.000Z`, message: { id, model: "m", usage: { input_tokens: 3, output_tokens: 4 } } });
  const linhas = [
    "null", "1", '"x"', "[]", "[1,{\"cwd\":\"a\"}]", "true", "false", '{"cwd": 5, "timestamp": "2026-03-01T01:00:00Z"}', '{"cwd": {"a":1}}',
    '{"type":"user","cwd":["a"],"timestamp":"2026-03-01T02:00:00Z","message":"texto"}',
    '{"type":"assistant","timestamp":"2026-03-01T03:00:00Z","message":{"id":{"o":1},"usage":"abc"}}',
    '{"type":"assistant","timestamp":"2026-03-01T03:00:00Z","message":[1,2]}',
    ok("a1", "10"), '{"truncado": ', ok("a2", "11"),
  ];
  await writeFile(join(dir, "s.jsonl"), linhas.join("\n"), "utf8");
  const ev = await coletar(claudeCode, { home });
  const respostas = ev.filter((e) => e.kind === "assistant" && e.tokens.input === 3);
  assert.equal(respostas.length, 2);
  assert.equal(respostas[0].project, "/x/proj");
});

// ---------- N2 ----------
test("N2: remoto com %, ./.. crus, hosts IDN/homógrafos/punycode e não-ASCII são recusados; os válidos continuam", () => {
  const antes = process.env.AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE;
  delete process.env.AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE;
  try {
    for (const ok of ["https://github.com/u/r.git", "https://GitHub.com:443/u/r", "git@github.com:u/r.git", "ssh://git@github.com/u/r.git", "https://git.example.org/a.b/c-d_e.git"]) {
      assert.equal(validarRemoto(ok), ok);
    }
    const ruins = [
      "https://github.com/u/%2e%2e/evil/r.git",
      "https://github.com/u/%2E%2E/r.git",
      "https://github.com/u/%2e/r.git",
      "https://github.com/u/r%2egit",
      "https://github.com/u/a%2Fb.git",
      "https://github.com/u/%41.git",
      "https://github.com/u/./r.git",
      "https://github.com/u/../r.git",
      "git@github.com:u/./r.git",
      "git@github.com:u/../r.git",
      "ssh://git@github.com/u/%2e%2e/r.git",
      "https://gıthub.com/u/r",
      "https://github.com/u/ré.git",
      "https://xn--gthub-3ya.com/u/r",
      "https://XN--gthub-3ya.com/u/r",
      "https://sub.xn--80ak6aa92e.com/u/r",
      "git@xn--gthub-3ya.com:u/r.git",
      "ssh://git@xn--gthub-3ya.com/u/r.git",
      "https://github.com%2eevil.com/u/r",
      "https://。github.com/u/r",
      "https://github．com/u/r",
    ];
    for (const url of ruins) assert.throws(() => validarRemoto(url), /remoteUrl inválido/, url);
  } finally {
    if (antes === undefined) delete process.env.AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE;
    else process.env.AI_USAGE_METRICS_TEST_ALLOW_LOCAL_REMOTE = antes;
  }
});
