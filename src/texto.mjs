// Texto vindo de fora (programa, rede, config.json, arquivo) a caminho da tela.

/** Sem ESC/OSC/CSI, sem caracteres de controle (C0, DEL e C1), espaços colapsados, tamanho limitado. */
export function limparTexto(t, max = 200) {
  return String(t ?? "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
