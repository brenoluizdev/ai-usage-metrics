# Esquema do JSON agregado (versão 1)

Com o histórico ligado (padrão), `timeline.points` e os totais derivados dela podem incluir dias do último JSON publicado: veja [`historico.md`](historico.md). O esquema não muda.

Gerado por `ai-usage-metrics export` e validado por `src/schema.mjs` (fonte da verdade; tipos JSDoc em `src/types.mjs`). Mudança incompatível = novo `schemaVersion`.

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-04T12:00:00.000Z",
  "synthetic": false,                       // true só em exemplos fictícios
  "period": { "from": "2026-01-05", "to": "2026-06-03" },   // null se não há atividade
  "totals": { "projects": 8, "sessions": 360, "userMessages": 2771, "assistantMessages": 8313,
              "activeDays": 141, "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 } },
  "tools": [ { "id": "claude-code", "name": "Claude Code",
               "provides": { "messages": true, "tokens": true },   // false = a fonte não informa
               "sessions": 0, "userMessages": 0, "assistantMessages": 0, "tokens": { /* idem */ },
               "firstActivity": "2026-01-05", "lastActivity": "2026-06-03" } ],
  "projects": [ { "name": "meu-site" /* ou "projeto-privado-1", "sem-projeto" */, "public": true,
                  "sessions": 0, "userMessages": 0, "assistantMessages": 0, "tokens": { /* idem */ },
                  "firstActivity": "...", "lastActivity": "...",
                  "tools": [ { "id": "claude-code", "sessions": 0, "userMessages": 0, "assistantMessages": 0, "tokens": { /* idem */ } } ] } ],
  "timeline": { "granularity": "day", "timezone": "UTC",
                "points": [ { "date": "2026-01-05", "sessions": 0, "userMessages": 0, "assistantMessages": 0, "tokens": 0,
                              "byTool": { "claude-code": { "sessions": 0, "userMessages": 0, "tokens": 0 } } } ] }
}
```

## Definições

- **sessions** (totais, ferramenta, projeto): sessões distintas. Em `timeline`, é o número de sessões com atividade naquele dia (uma sessão de vários dias conta em cada dia).
- **userMessages**: mensagens digitadas pelo usuário (sem resultados de ferramenta). **assistantMessages**: respostas distintas da IA.
- **tokens**: soma dos tokens informados; `total` inclui leitura e escrita de cache (por isso é grande) e precisa bater com a soma dos quatro tipos.
- `projects` vem ordenado por `userMessages` (desc), depois sessões e tokens. `public: false` significa nome anonimizado (`projeto-privado-N`).
- Datas em UTC.

## Allowlist estrita (o que o validador aceita)

O validador **recusa** qualquer coisa fora disto:

- Só as chaves listadas acima, em cada nível, e todas obrigatórias. Campo extra = erro.
- Números: inteiros de 0 a 1e15. Datas: `AAAA-MM-DD` válidas. `generatedAt`: instante ISO em UTC (`...Z`).
- `tools[].id` e chaves de `byTool`: `[a-z0-9][a-z0-9-]{0,30}`.
- Nomes (`tools[].name`, `projects[].name` público): letras, números, espaço e `. _ ( ) + -`, até 60 caracteres. Sem barras, `@`, `:` nem quebras de linha, então caminhos e e-mails não passam.
- Projeto com `public: false` só pode se chamar `projeto-privado-N`.

Na hora do `publish` há checagens adicionais (além do esquema):

- `id` e `name` de ferramenta têm de ser exatamente os das fontes registradas no código (nada de texto livre ali);
- todo projeto com nome público precisa estar na allowlist (`publicProjects`) da sua configuração;
- a barreira de privacidade recusa caminho de disco, pasta pessoal, e-mail e nome de arquivo de dados.

Limite honesto: um nome de projeto público é texto escolhido por você na configuração; o validador só garante o formato (letras, números e poucos símbolos), não o significado. Escolha nomes que você aceite ver publicados.

Nunca há: texto de mensagens, código, caminhos, nomes de usuário do sistema, e-mails, títulos de conversa, ids de sessão ou nomes de modelo.
