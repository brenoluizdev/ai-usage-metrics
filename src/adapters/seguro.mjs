// Defesas comuns dos adaptadores contra registros adversariais ou corrompidos (arquivos gigantes, datas absurdas,
// números fora de faixa). Nada aqui lê conteúdo de conversa: só tamanho, datas e inteiros.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

/** Datas aceitas: de 2000-01-01 até agora + 1 dia (relógios fora de sincronia). Fora disso o evento é descartado. */
export const TS_MIN = Date.UTC(2000, 0, 1);
export const tsValido = (ts, agora = Date.now()) => typeof ts === "number" && Number.isFinite(ts) && ts >= TS_MIN && ts <= agora + 86_400_000;

/** Teto por campo de token em UMA mensagem (1 bilhão). Acima disso (ou não inteiro/negativo) o valor é descartado (vira 0). */
export const MAX_TOKENS_POR_CAMPO = 1_000_000_000;
export const num = (x) => (typeof x === "number" && Number.isSafeInteger(x) && x > 0 && x <= MAX_TOKENS_POR_CAMPO ? x : 0);

/** Teto do caminho de projeto (cwd) guardado na memória: acima disso o valor é descartado e o evento vai para "(sem projeto)". */
export const MAX_CWD_CHARS = 4096;
export const cwdGrande = (v) => typeof v === "string" && v.length > MAX_CWD_CHARS;
export const avisoCwdGrande = (rotulo) => `${rotulo}: caminho(s) de projeto maiores que ${MAX_CWD_CHARS} caracteres foram descartados (a atividade foi agrupada em "(sem projeto)").`;

export const MAX_ARQUIVO_BYTES = 512 * 1024 * 1024; // transcrição (.jsonl)
export const MAX_LINHA_BYTES = 16 * 1024 * 1024; // uma linha de transcrição
// Tetos de entradas DISTINTAS guardadas na memória por arquivo (um arquivo de 512 MiB cheio de ids únicos pequenos
// esgotaria a RAM antes de o corte de 1000 projetos do esquema valer). Acima do teto: ignora o excedente e avisa.
export const MAX_IDS_POR_ARQUIVO = 200_000; // ids de resposta distintos
export const MAX_PROMPTS_POR_ARQUIVO = 2_000_000; // mensagens de usuário guardadas
export const MAX_MENSAGENS_JSON_BYTES = 64 * 1024 * 1024; // .messages.json do Cline

/** true se o arquivo é comum e cabe no teto; senão avisa (sem caminho no aviso) e devolve false. */
export async function arquivoDentroDoLimite(arquivo, limite, ctx, rotulo) {
  let st;
  try {
    st = await stat(arquivo);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  if (st.size > limite) {
    ctx?.avisar?.(`${rotulo}: arquivo ignorado por exceder ${Math.round(limite / 1048576)} MiB.`);
    return false;
  }
  return true;
}

/**
 * Lê um arquivo em streaming, linha a linha, descartando linhas maiores que `maxLinha` (sem estourar a memória).
 * @param {string} arquivo
 * @param {{ maxLinha?: number, aoDescartar?: () => void }} [opt]
 * @returns {AsyncGenerator<string>}
 */
export async function* lerLinhas(arquivo, { maxLinha = MAX_LINHA_BYTES, aoDescartar } = {}) {
  const NL = 0x0a;
  let partes = [];
  let tam = 0;
  let descartando = false;
  const fecha = () => {
    const texto = partes.length ? Buffer.concat(partes, tam) : Buffer.alloc(0);
    partes = [];
    tam = 0;
    return texto;
  };
  for await (const pedaco of createReadStream(arquivo, { highWaterMark: 256 * 1024 })) {
    let ini = 0;
    while (ini < pedaco.length) {
      const fim = pedaco.indexOf(NL, ini);
      const trecho = pedaco.subarray(ini, fim === -1 ? pedaco.length : fim);
      if (!descartando) {
        if (tam + trecho.length > maxLinha) {
          descartando = true;
          partes = [];
          tam = 0;
          aoDescartar?.();
        } else {
          partes.push(trecho);
          tam += trecho.length;
        }
      }
      if (fim === -1) break;
      if (!descartando) {
        const t = fecha().toString("utf8");
        yield t.endsWith("\r") ? t.slice(0, -1) : t;
      }
      descartando = false;
      ini = fim + 1;
    }
  }
  if (!descartando && tam > 0) yield fecha().toString("utf8");
}
