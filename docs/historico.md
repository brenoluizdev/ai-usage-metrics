# Histórico persistente (mescla da série diária)

Sem histórico, cada `export` calcula tudo só a partir dos registros que existem no disco **naquele momento**. Se você formatar o PC, trocar de computador ou se o Claude Code apagar sessões antigas por idade, o painel perderia a série diária, os totais e o calendário. Com o histórico (ligado por padrão), o `export` mescla a **série diária** com a do último `metrics.json` publicado. O esquema do JSON (v1) não muda e nada além do que já era público é publicado.

## De onde vem o baseline

O "baseline" é o último `metrics.json` publicado. Ordem de busca:

1. `<state-dir>/history.json`: cópia validada do último `metrics.json` **publicado com sucesso** (gravada pelo `publish` logo depois de um envio bem-sucedido, ou quando ele constata que nada mudou e o conteúdo já estava publicado; modo `0600`, escrita atômica, link simbólico recusado). O `restore` também grava este arquivo.
2. `metrics.json` do clone local em cache (`<state-dir>/repo/`), **só se o clone for nosso** (as mesmas checagens do `publish`: marcador de posse, `.git` de verdade, `.git/config` só com as chaves esperadas, remoto igual ao configurado) e estiver na branch configurada.

Sem baseline, o comportamento é o de sempre. `"history": false` na configuração, `export --no-history` (só naquela execução) e `--since` (que limita o período de propósito) desligam a mescla. Com `--tool`, só as ferramentas escolhidas entram na mescla.

## history.json é monotônico

O `publish` não copia o JSON publicado para o `history.json`: grava a **mescla por máximo** entre o `history.json` anterior e o JSON publicado. Assim ele nunca encolhe, mesmo depois de um `export --no-history`, `--since`, `--tool`, `"history": false` ou `publish --input <json menor>` (que podem publicar um JSON menor). Zerar é um ato explícito: `history reset` (apaga só o `history.json`, com confirmação `[s/N]` ou `--yes`; o `metrics.json` do clone local continua servindo de baseline até o próximo publish).

## Guarda de regressão no publish

`src/regressao.mjs`. O JSON a publicar é comparado com o melhor baseline local (mescla do `history.json` e do clone) e com o `metrics.json` já publicado (`anterior`, lido do clone; e, no envio, com o que o remoto realmente tem depois do `fetch`). Há regressão se faltar alguma data da referência ou se sessões, mensagens ou tokens forem menores. A comparação usa a **série** (soma dos pontos), não os totais declarados, e só `sessions` usa o menor entre o total declarado e a série.

- Dry-run e `export` mostram `PERDA DE HISTÓRICO` com antes -> depois, dias removidos e a causa provável (`--no-history`, `--since`, `--tool`, `history:false`).
- `publish` manual em terminal: exige digitar exatamente `publicar com perda de histórico`. Sem terminal: exige `--accept-history-loss`.
- `run` agendado (`autoPublish`): **bloqueia** e explica; a aprovação automática nunca cobre perda de histórico.
- A guarda também vale quando o baseline foi ignorado (inválido, incoerente): o `anterior` do clone/remoto continua sendo comparado.

## Validação do baseline (entrada não confiável)

O arquivo é tratado como texto de fora: teto de 5 MiB (lido de verdade com limite: abre o arquivo e lê no máximo teto + 1 byte); JSON legível; allowlist estrita do esquema v1 (`exigirMetricasValidas`); `schemaVersion` 1; `synthetic: false`; barreira de privacidade; e **coerência interna**: `totals.userMessages`, `assistantMessages`, `tokens.total` e `sessions` não podem passar da soma da própria série, `activeDays` não pode passar do número de pontos, o `period` tem de bater com as datas dos pontos e cada ferramenta não pode passar da sua própria série. (Série cortada em 4000 pontos: os totais legitimamente passam da soma, então só o período é conferido, com início <= primeiro ponto.) Se falhar, é **ignorado** com o aviso `histórico ignorado: <origem>: <motivo>` e o export segue só com os registros locais. Além disso, na mescla:

- ferramentas fora do registro de adaptadores em uso são descartadas (com aviso) e seus valores saem de cada dia;
- datas fora de 2000-01-01..amanhã são descartadas (com aviso);
- nomes de projeto do baseline nunca entram.

## Regra de mescla (`src/historico.mjs`, `mesclarHistorico`)

Só `timeline.points` é mesclado, por data:

- só no local: fica o local; só no baseline: fica o do baseline;
- nos dois: o **maior valor, campo a campo** (`sessions`, `userMessages`, `assistantMessages`, `tokens` e, dentro de `byTool[id]`, `sessions`, `userMessages`, `tokens`). Depois garante que o ponto não fique abaixo da soma das ferramentas do dia.

**Por que o máximo:** a contagem de um dia só cresce com o tempo, e um registro local pode ter sido apagado em parte; então o valor menor é o que perdeu dados. Somar contaria duas vezes as mesmas sessões (local e baseline descrevem o mesmo dia). O máximo também é idempotente: reaplicar a mescla sobre o próprio resultado não infla nada.

Se a série passar de 4000 dias, ficam os mais recentes, com aviso (como no resto do código).

Com dois baselines (`history.json` e clone local) ambos válidos, o baseline é a **mescla por máximo** dos dois (o `history.json` fica velho quando outro computador publica); se só um é válido, usa-se o outro com aviso.

## Recálculo a partir da série mesclada

Os totais são recalculados **só a partir da série**: um baseline pode declarar totais que o esquema aceita mas a série não sustenta, então só a soma dos pontos conta (o total declarado serve apenas de teto para `sessions` e como detalhamento de tokens). Qualquer número que passe do teto do esquema (1e15) é limitado, com aviso, em vez de derrubar a mescla. `activeDays` é o número de pontos já cortados (estável na borda de 4000 dias).

| Campo | Regra |
|---|---|
| `period` | menor e maior data da série (e dos períodos local/baseline, se plausíveis) |
| `totals.activeDays` | número de dias da série (nunca menos que o do local) |
| `totals.userMessages`, `assistantMessages`, `sessions` | se a mescla não acrescentou nada ao local (soma da série mesclada = soma da série local), o valor local, exato. Senão `total do baseline + (soma da série mesclada − soma da série do baseline)`, nunca menos que o local nem que o baseline |
| `tools[i]` | os mesmos contadores, calculados com a série da ferramenta (`byTool`); `firstActivity`/`lastActivity` pelas datas em que a ferramenta aparece |
| `totals.projects`, `projects` | **só dos registros locais** |

### Aproximações (documentadas e honestas)

- **`sessions`:** o total é de sessões **distintas**, mas a série só guarda sessões **por dia** (uma sessão de vários dias conta em cada dia). Para os dias que o local não tem, o acréscimo é contado por dia-de-sessão: pode superestimar o total quando há sessões de vários dias só no histórico.
- **Detalhamento de tokens** (`input/output/cacheRead/cacheWrite`): a série tem só o `tokens` total por dia. Regra: se a mescla não acrescentou nada, o detalhamento local, exato. Senão, o **detalhamento do baseline** + o **excedente** de tokens (soma da série mesclada − soma da série do baseline: dias novos ou elevados) distribuído na proporção do detalhamento **local** (ou do baseline, se o local for vazio; se ambos forem zero, tudo em `input`), com arredondamento por maiores restos para a soma ficar exata. Assim dias restaurados mantêm a proporção que o baseline tinha, e dias novos usam a do local. O `total` sempre bate com a soma dos quatro tipos (invariante do esquema) e cada tipo respeita o teto de 2e14 do agregador.
- **`assistantMessages` por ferramenta:** a série só tem o total do dia. O total geral vem da série; por ferramenta, usa-se o valor local se nada mudou para ela, senão o do baseline mais o acréscimo de mensagens do usuário vezes a razão assistente/usuário do baseline. Quando ferramentas do baseline são descartadas de um dia, o `assistantMessages` do dia é reduzido na proporção das mensagens do usuário que restaram.
- **Ranking de projetos:** **não é restaurado**. Os nomes anonimizados `projeto-privado-N` não têm identidade estável entre execuções (a numeração segue o ranking do momento), então não há como casar projetos do baseline com os locais. Projetos públicos também não são restaurados: vêm só dos registros locais.

## Idempotência

Com o mesmo baseline e os mesmos registros o JSON é o mesmo (exceto `generatedAt`). Como o resultado publicado vira o baseline seguinte, a regra é um ponto fixo: no passo seguinte o excedente é 0 e os totais do baseline já são os da série, então nada é somado de novo.

## Tamanho do clone

`restore` e `publish` clonam o repositório de dados **inteiro** (sem `--depth`): o tempo é limitado pelo timeout do git (120 s por comando), não pelo disco. Repositórios de dados muito grandes podem estourar esse tempo.

## `restore` (computador novo)

Se já existe `history.json`, o restaurado **não o sobrescreve**: grava-se a mescla por máximo e a comparação (dias e totais, local atual / restaurado / resultado) é mostrada; `restore --from-file` pede confirmação (`[s/N]` ou `--yes`) nesse caso, e o restore pela rede já pediu a confirmação antes de baixar. `restore --from-file` recusa caminhos de rede no Windows (`\\\\host\\pasta`, `//host/pasta`, `\\\\?\\`, `\\\\.\\`).


`restore` baixa o último `metrics.json` do repositório de dados e o grava como `history.json`, depois da validação estrita. É rede: pede confirmação (`[s/N]` em terminal ou `--yes`) e usa a mesma maquinaria do `publish` (remoto validado, ambiente do git por allowlist, protocolos permitidos, clone marcado, `cwd` explícito, sem hooks, sem token); só lê, nunca faz commit nem push. `restore --from-file <json>` é 100% offline e valida do mesmo jeito. Repositório vazio ou sem `metrics.json`: diz isso e não grava nada.

## Resumo na saída

`export`, `run` e o dry-run do `publish` mostram quantos dias vieram só do histórico, quantos são só locais e quantos foram elevados pelo máximo, e avisam em destaque quando os registros locais têm muito menos dias que o histórico (caso "PC formatado / sessões apagadas"). O resumo (só números) fica em `out/historico.json` para o dry-run reaproveitar.
