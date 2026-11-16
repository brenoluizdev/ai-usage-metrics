// Tipos compartilhados (JSDoc). Nenhum evento carrega texto de conversa.

/**
 * @typedef {{ input: number, output: number, cacheRead: number, cacheWrite: number }} Tokens
 */

/**
 * Evento mínimo extraído de uma fonte. Só números, datas e a pasta de trabalho.
 * @typedef {Object} UsageEvent
 * @property {string} tool         id da ferramenta (ex.: "claude-code")
 * @property {string|null} project caminho da pasta de trabalho (cwd) BRUTO; só vive em memória, nunca vai ao JSON público
 * @property {string} session      id da sessão/conversa dentro da ferramenta
 * @property {number} ts           instante em ms desde 1970 (UTC)
 * @property {"user"|"assistant"|"session"} kind  mensagem do usuário, resposta da IA, ou só o início de uma sessão (fontes sem mensagens)
 * @property {Tokens} [tokens]     quando a fonte informa
 */

/**
 * @typedef {Object} AdapterContext
 * @property {string} home    pasta do usuário (injetável nos testes)
 * @property {number} [since] ignora eventos antes deste instante (ms)
 */

/**
 * Contrato de um adaptador. Para adicionar uma fonte, exporte um objeto assim e registre em adapters/index.mjs.
 * @typedef {Object} Adapter
 * @property {string} id
 * @property {string} name
 * @property {{ messages: boolean, tokens: boolean, projects: boolean }} capabilities
 * @property {(ctx: AdapterContext) => Promise<boolean>} available   a fonte existe neste computador?
 * @property {(ctx: AdapterContext) => AsyncIterable<UsageEvent>} events
 */

export {};

/**
 * @typedef {{ input: number, output: number, cacheRead: number, cacheWrite: number, total: number }} TokensTotais
 * @typedef {{ sessions: number, userMessages: number, assistantMessages: number, tokens: TokensTotais, firstActivity: string|null, lastActivity: string|null }} Resumo
 * @typedef {Resumo & { id: string, name: string, provides: { messages: boolean, tokens: boolean } }} Ferramenta
 * @typedef {Resumo & { name: string, public: boolean, tools: Array<{ id: string, sessions: number, userMessages: number, assistantMessages: number, tokens: TokensTotais }> }} Projeto
 * @typedef {{ date: string, sessions: number, userMessages: number, assistantMessages: number, tokens: number, byTool: Record<string, { sessions: number, userMessages: number, tokens: number }> }} PontoDiario
 */

/**
 * JSON agregado, esquema v1 (docs/esquema.md). O validador de src/schema.mjs é a fonte da verdade.
 * @typedef {Object} Metricas
 * @property {1} schemaVersion
 * @property {string} generatedAt
 * @property {boolean} synthetic
 * @property {{ from: string, to: string } | null} period
 * @property {{ projects: number, sessions: number, userMessages: number, assistantMessages: number, activeDays: number, tokens: TokensTotais }} totals
 * @property {Ferramenta[]} tools
 * @property {Projeto[]} projects
 * @property {{ granularity: "day", timezone: "UTC", points: PontoDiario[] }} timeline
 */
