// Posse do clone local de dados (pasta "repo" dentro do state-dir). A ferramenta só recria/renomeia uma pasta que ELA criou.
// Marcador: <state-dir>/repo.owner.json = { tool, id (32 hex aleatórios), path (caminho real da pasta repo), createdAt }
// + cópia do id em <repo>/.git/ai-usage-metrics-owner. O marcador de fora sobrevive se o .git do clone for adulterado;
// a cópia de dentro impede tratar como nosso um repositório do usuário posto no lugar do nosso clone.
import { randomBytes } from "node:crypto";
import { lstat, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const FERRAMENTA = "ai-usage-metrics";
export const MAX_VELHOS = 3;
const ID = /^[0-9a-f]{32}$/;
const PREFIXO_VELHO = "repo.velho-";
const PADRAO_VELHO = /^repo\.velho-\d{13}-[0-9a-f]{6}$/;

export const arquivoMarcador = (stateDir) => join(stateDir, "repo.owner.json");
export const marcadorInterno = (clone) => join(clone, ".git", "ai-usage-metrics-owner");

const igualCaminho = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Caminho real esperado da pasta do clone (o state-dir pode ser alcançado por links/8.3; comparamos o caminho resolvido). */
export async function caminhoRealDoClone(stateDir, clone) {
  return join(await realpath(dirname(clone)), basename(clone));
}

async function lerJson(arquivo) {
  const st = await lstat(arquivo);
  if (!st.isFile() || st.size > 4096) return null;
  try {
    return JSON.parse(await readFile(arquivo, "utf8"));
  } catch {
    return null;
  }
}

/** Lê um marcador estruturalmente válido (sem comparar caminho). Devolve null se ausente ou inválido. */
export async function lerMarcador(arquivo) {
  try {
    const m = await lerJson(arquivo);
    if (m && m.tool === FERRAMENTA && typeof m.id === "string" && ID.test(m.id) && typeof m.path === "string") return m;
  } catch {
    /* ausente */
  }
  return null;
}

/** Grava os dois marcadores para um clone recém-criado por nós. */
export async function gravarMarcadores(stateDir, clone) {
  const id = randomBytes(16).toString("hex");
  const path = await caminhoRealDoClone(stateDir, clone);
  await writeFile(marcadorInterno(clone), id + "\n", { encoding: "utf8", mode: 0o600 });
  await writeFile(arquivoMarcador(stateDir), JSON.stringify({ tool: FERRAMENTA, id, path, createdAt: new Date().toISOString() }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

/**
 * O clone atual é nosso? Exige: marcador de fora válido e amarrado ao caminho real; se o .git é uma pasta real, a cópia
 * interna do id tem de existir e bater (senão alguém pôs outro repositório no lugar). .git adulterado (arquivo/link/ausente)
 * não invalida: a posse vem do marcador de fora e a pasta é só RENOMEADA, nunca apagada.
 */
export async function cloneEhNosso(stateDir, clone) {
  const m = await lerMarcador(arquivoMarcador(stateDir));
  if (!m) return false;
  try {
    if (!igualCaminho(m.path, await caminhoRealDoClone(stateDir, clone))) return false;
  } catch {
    return false;
  }
  let stGit;
  try {
    stGit = await lstat(join(clone, ".git"));
  } catch {
    return true; // sem .git: nosso clone danificado
  }
  if (stGit.isSymbolicLink() || !stGit.isDirectory()) return true;
  try {
    const st = await lstat(marcadorInterno(clone));
    if (!st.isFile() || st.size > 100) return false;
    return (await readFile(marcadorInterno(clone), "utf8")).trim() === m.id;
  } catch {
    return false;
  }
}

/**
 * Renomeia o clone nosso para repo.velho-<timestamp>-<aleatório> (com o marcador ao lado) e poda os mais antigos. Devolve o novo nome.
 * Se o marcador não puder ser renomeado, avisa (o velho fica sem marcador: nunca será podado, só acumula até alguém removê-lo).
 */
export async function aposentarClone(stateDir, clone, { avisar = () => {} } = {}) {
  const nome = `${PREFIXO_VELHO}${String(Date.now()).padStart(13, "0")}-${randomBytes(3).toString("hex")}`;
  const destino = join(stateDir, nome);
  await rename(clone, destino);
  try {
    await rename(arquivoMarcador(stateDir), join(stateDir, `${nome}.owner.json`));
  } catch (e) {
    avisar(`não consegui mover o marcador de posse para '${nome}.owner.json' (${e.code ?? "erro"}). A pasta '${nome}' ficará sem marcador: a ferramenta não a apaga sozinha e ela só vai acumular; remova-a você mesmo quando não precisar mais.`);
  }
  await podarVelhos(stateDir);
  return nome;
}

/** Um repo.velho-* é nosso (apagável) só se for pasta real, com .owner.json válido e coerente com o id gravado em .git/ai-usage-metrics-owner. */
async function velhoEhNosso(stateDir, nome) {
  const pasta = join(stateDir, nome);
  const st = await lstat(pasta).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  const m = await lerMarcador(join(stateDir, `${nome}.owner.json`)).catch(() => null);
  if (!m) return false;
  try {
    // o caminho gravado era o do clone ('repo') dentro deste mesmo state-dir
    if (basename(m.path) !== "repo" || !igualCaminho(dirname(m.path), await realpath(stateDir))) return false;
    const stGit = await lstat(join(pasta, ".git"));
    if (stGit.isSymbolicLink() || !stGit.isDirectory()) return false;
    const st2 = await lstat(marcadorInterno(pasta));
    if (!st2.isFile() || st2.size > 100) return false;
    return (await readFile(marcadorInterno(pasta), "utf8")).trim() === m.id;
  } catch {
    return false;
  }
}

/** Mantém no máximo MAX_VELHOS pastas repo.velho-*; só apaga as que passam em velhoEhNosso (marcador de fora + de dentro coerentes). */
export async function podarVelhos(stateDir, max = MAX_VELHOS) {
  let itens;
  try {
    itens = await readdir(stateDir);
  } catch {
    return;
  }
  const velhos = itens.filter((n) => PADRAO_VELHO.test(n)).sort();
  for (const n of velhos.slice(0, Math.max(0, velhos.length - max))) {
    if (!(await velhoEhNosso(stateDir, n))) continue; // não é comprovadamente nosso: não apaga
    await rm(join(stateDir, n), { recursive: true, force: true });
    await rm(join(stateDir, `${n}.owner.json`), { force: true });
  }
}
