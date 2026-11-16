// Texto vindo de fora (programa, rede, config.json, arquivo) a caminho da tela.

/**
 * Sem ESC/OSC/CSI, sem caracteres de controle (C0, DEL e C1), espaços colapsados, tamanho limitado. Caracteres de FORMATAÇÃO (Cf: bidi
 * U+202A-202E/U+2066-2069, zero-width U+200B-200F, U+FEFF...) viram um escape visível `\u{202e}`: nunca passam crus ao terminal.
 */
export function limparTexto(t, max = 200) {
  return String(t ?? "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\p{Cf}/gu, (c) => `\\u{${c.codePointAt(0).toString(16)}}`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
