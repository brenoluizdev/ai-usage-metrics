// Trava contra execuções concorrentes na mesma pasta de estado (duas execuções simultâneas poderiam
// corromper o clone em cache ou publicar dados pela metade). Arquivo `.lock` criado com "wx" (exclusivo).
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Uma trava com mais que isto é considerada velha mesmo que o pid exista (pid reaproveitado ou processo travado). */
export const IDADE_MAXIMA_MS = 6 * 60 * 60 * 1000;

function processoVivo(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // existe, mas é de outro usuário
  }
}

/**
 * Remove a trava velha SEM corrida. Dois processos que leram a mesma trava velha não podem apagá-la um depois do outro (o
 * segundo apagaria a trava NOVA do primeiro). Por isso: (1) uma guarda exclusiva (.lock.reclaim, criada com "wx") serializa a
 * recuperação; (2) dentro dela a trava é relida e só é tocada se continua sendo a MESMA que foi avaliada como velha;
 * (3) ela é renomeada para um nome único antes de ser apagada. Devolve true se removeu.
 */
async function recuperarVelha(arquivo, info) {
  const guarda = `${arquivo}.reclaim`;
  let fh;
  try {
    fh = await open(guarda, "wx", 0o600);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    try {
      if (Date.now() - (await stat(guarda)).mtimeMs > 60_000) await rm(guarda, { force: true }); // guarda de um processo que morreu no meio
    } catch {
      /* some entre as chamadas */
    }
    return false;
  }
  try {
    await fh.close();
    let atual = null;
    try {
      atual = JSON.parse(await readFile(arquivo, "utf8"));
    } catch {
      /* ilegível ou ausente */
    }
    const mesma = (info?.pid ?? null) === (atual?.pid ?? null) && (info?.startedAt ?? null) === (atual?.startedAt ?? null);
    if (!mesma) return false; // alguém já recuperou e criou uma trava nova: não mexe nela
    const aposentada = `${arquivo}.velha.${process.pid}.${randomBytes(6).toString("hex")}`;
    try {
      await rename(arquivo, aposentada);
      await rm(aposentada, { force: true });
    } catch {
      return false;
    }
    return true;
  } finally {
    await rm(guarda, { force: true });
  }
}

/**
 * Adquire a trava ou lança um erro claro. Devolve a função que a libera.
 * Trava velha (processo morto, arquivo ilegível e antigo, ou mais de 6 h) é removida automaticamente.
 * @param {string} dir pasta de estado
 * @param {{ agora?: number, idadeMaximaMs?: number }} [opt]
 */
export async function adquirirLock(dir, { agora = Date.now(), idadeMaximaMs = IDADE_MAXIMA_MS } = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const arquivo = join(dir, ".lock");
  for (let tentativa = 0; tentativa < 12; tentativa++) {
    try {
      const fh = await open(arquivo, "wx", 0o600);
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date(agora).toISOString() }) + "\n");
      } finally {
        await fh.close();
      }
      return async () => {
        try {
          const atual = JSON.parse(await readFile(arquivo, "utf8"));
          if (atual?.pid === process.pid) await rm(arquivo, { force: true });
        } catch {
          /* já removida */
        }
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let info = null;
    try {
      info = JSON.parse(await readFile(arquivo, "utf8"));
    } catch {
      /* ilegível */
    }
    let inicio = info && typeof info.startedAt === "string" ? Date.parse(info.startedAt) : NaN;
    if (!Number.isFinite(inicio)) {
      try {
        inicio = (await stat(arquivo)).mtimeMs;
      } catch {
        continue; // sumiu entre as leituras: tenta de novo
      }
    }
    const velha = agora - inicio > idadeMaximaMs;
    // Arquivo ainda vazio/ilegível e muito recente: outra execução está criando a trava agora.
    const vivo = info ? processoVivo(info.pid) : agora - inicio < 10_000;
    if (!vivo || velha) {
      if (!(await recuperarVelha(arquivo, info))) await new Promise((r) => setTimeout(r, 25)); // outro processo está recuperando: espera um pouco
      continue;
    }
    throw new Error(
      `Outra execução do ai-usage-metrics (pid ${info?.pid ?? "?"}, desde ${info?.startedAt ?? "?"}) está usando ${dir}. Aguarde terminar. Se tem certeza de que não há outra rodando, apague ${arquivo}.`,
    );
  }
  throw new Error(`Não consegui obter a trava em ${dir}; tente de novo em instantes ou apague ${arquivo} se não houver outra execução.`);
}
