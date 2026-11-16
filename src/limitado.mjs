// Leitura de arquivo com teto de tamanho DE VERDADE: abre o arquivo e lê no máximo `limite + 1` bytes (nunca stat + readFile,
// que leria um arquivo que cresce entre a checagem e a leitura). Recusa link simbólico, a menos que `seguirLink`.
import { lstat, open, stat } from "node:fs/promises";

export const LIMITE_PADRAO = 5 * 1024 * 1024;

/** @returns {Promise<{ texto: string } | { motivo: string } | null>} null = não existe */
export async function lerArquivoLimitado(arquivo, { seguirLink = false, limite = LIMITE_PADRAO } = {}) {
  let st;
  try {
    st = await lstat(arquivo);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    return { motivo: "ilegível" };
  }
  if (st.isSymbolicLink()) {
    if (!seguirLink) return { motivo: "é um link simbólico" };
    st = await stat(arquivo).catch(() => null);
    if (!st) return { motivo: "ilegível" };
  }
  if (!st.isFile()) return { motivo: "não é um arquivo comum" };
  let fh;
  try {
    fh = await open(arquivo, "r");
    const buf = Buffer.alloc(limite + 1);
    let lidos = 0;
    while (lidos < buf.length) {
      const { bytesRead } = await fh.read(buf, lidos, buf.length - lidos, lidos);
      if (bytesRead === 0) break;
      lidos += bytesRead;
    }
    if (lidos > limite) return { motivo: `grande demais (mais de ${Math.round(limite / 1024 / 1024) || limite} ${limite >= 1024 * 1024 ? "MiB" : "bytes"})` };
    return { texto: buf.subarray(0, lidos).toString("utf8") };
  } catch {
    return { motivo: "ilegível" };
  } finally {
    await fh?.close().catch(() => {});
  }
}
