import { chatgptCodexApp } from "./chatgpt-codex-app.mjs";
import { claudeCode } from "./claude-code.mjs";
import { cline } from "./cline.mjs";

/** Para adicionar uma fonte: crie o adaptador (contrato em ../types.mjs) e inclua aqui. */
export const ADAPTERS = [claudeCode, cline, chatgptCodexApp];
