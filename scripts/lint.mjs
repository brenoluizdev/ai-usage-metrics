// "Lint" sem dependências: checa a sintaxe de todos os .mjs com `node --check`.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(fileURLToPath(new URL("..", import.meta.url)));
const achar = (d) =>
  readdirSync(d).flatMap((n) => {
    if (n === "node_modules" || n.startsWith(".")) return [];
    const p = join(d, n);
    return statSync(p).isDirectory() ? achar(p) : p.endsWith(".mjs") ? [p] : [];
  });
let ruim = 0;
for (const f of achar(raiz)) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (e) {
    ruim++;
    console.error(`${f}\n${e.stderr}`);
  }
}
if (ruim) process.exit(1);
console.log("sintaxe OK");
