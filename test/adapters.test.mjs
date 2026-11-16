import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { chatgptCodexApp } from "../src/adapters/chatgpt-codex-app.mjs";
import { claudeCode } from "../src/adapters/claude-code.mjs";
import { cline } from "../src/adapters/cline.mjs";
import { claudeFalso, clineFalso, codexFalso, homeFalsa, subagenteFalso } from "./fixtures.mjs";

async function todos(adapter, ctx) {
  const out = [];
  for await (const e of adapter.events(ctx)) out.push(e);
  return out;
}

test("claude-code: conta prompts reais, deduplica respostas e soma tokens", async () => {
  const home = await homeFalsa();
  try {
    await claudeFalso(home);
    assert.equal(await claudeCode.available({ home }), true);
    const ev = await todos(claudeCode, { home });
    const users = ev.filter((e) => e.kind === "user");
    const ass = ev.filter((e) => e.kind === "assistant");
    assert.equal(users.length, 2, "ignora tool_result e meta");
    assert.equal(ass.length, 2, "m1 conta uma vez; synthetic é ignorado");
    const m1 = ass.find((e) => e.tokens.cacheRead === 100);
    assert.deepEqual(m1.tokens, { input: 10, output: 7, cacheRead: 100, cacheWrite: 50 }, "fica a última linha da resposta");
    assert.ok(ev.every((e) => e.session === "sess-1" && e.project === "C:\\Users\\fulano\\Desktop\\projeto-alfa"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("claude-code: eventos não carregam texto de conversa", async () => {
  const home = await homeFalsa();
  try {
    await claudeFalso(home);
    const texto = JSON.stringify(await todos(claudeCode, { home }));
    for (const segredo of ["SECRETO", "SAIDA-DA-FERRAMENTA", "RESPOSTA"]) assert.ok(!texto.includes(segredo), segredo);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("claude-code: subagentes entram na sessão-mãe; filtro since", async () => {
  const home = await homeFalsa();
  try {
    await claudeFalso(home);
    await subagenteFalso(home);
    const ev = await todos(claudeCode, { home });
    assert.equal(ev.filter((e) => e.session === "sess-1").length, ev.length);
    assert.equal(ev.filter((e) => e.kind === "assistant").length, 3);
    const depois = await todos(claudeCode, { home, since: Date.parse("2026-03-01T13:00:00Z") });
    assert.equal(depois.length, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("claude-code: sem a pasta, não está disponível", async () => {
  const home = await homeFalsa();
  try {
    assert.equal(await claudeCode.available({ home }), false);
    assert.deepEqual(await todos(claudeCode, { home }), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("cline: sessão, mensagens digitadas e tokens (subagente na sessão-mãe)", async () => {
  const home = await homeFalsa();
  try {
    await clineFalso(home);
    const ev = await todos(cline, { home });
    assert.equal(ev.filter((e) => e.kind === "session").length, 1);
    assert.equal(ev.filter((e) => e.kind === "user").length, 1, "tool_result não conta");
    const ass = ev.filter((e) => e.kind === "assistant");
    assert.equal(ass.length, 2);
    assert.equal(ass.reduce((s, e) => s + e.tokens.input, 0), 101);
    assert.ok(ev.every((e) => e.session === "s1"));
    assert.ok(!JSON.stringify(ev).includes("SECRETO"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("chatgpt (catálogo do app): só conversas do ChatGPT presentes, sem título", async () => {
  const home = await homeFalsa();
  try {
    await codexFalso(home);
    const ev = await todos(chatgptCodexApp, { home });
    assert.deepEqual(ev.map((e) => e.session).sort(), ["t1", "t2"]);
    assert.ok(ev.every((e) => e.kind === "session" && e.project === null));
    assert.ok(!JSON.stringify(ev).includes("TITULO"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
