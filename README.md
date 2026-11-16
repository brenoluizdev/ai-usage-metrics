# ai-usage-metrics

[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue.svg)](LICENSE)
[![Node.js >= 24](https://img.shields.io/badge/node-%3E%3D24-339933.svg)](https://nodejs.org/)
[![Dependências: 0](https://img.shields.io/badge/depend%C3%AAncias-0-brightgreen.svg)](package.json)

Mede, no seu computador, quanto e onde você usa ferramentas de IA para programar, e publica um painel em SVG no seu próprio repositório do GitHub, pronto para o README do perfil.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="examples/metrics.example.dark.svg">
  <img alt="Painel de exemplo com sessões, mensagens, tokens, dias ativos, sessões por mês e projetos com mais uso" src="examples/metrics.example.light.svg">
</picture>

<sub>Painel gerado com dados fictícios (`examples/`).</sub>

## Por que existe

Quem usa assistentes de IA todo dia raramente tem números sobre isso: quantas sessões, em quais projetos, com que volume. As próprias ferramentas já guardam esses registros no seu disco. O `ai-usage-metrics` lê esses registros, agrega, anonimiza e gera um painel que você controla, sem servidor de terceiros e sem enviar o conteúdo de nenhuma conversa.

## Recursos

- **100% local e somente leitura.** Os registros das ferramentas nunca são alterados.
- **Determinístico.** Todo número é calculado por código; não há IA no meio.
- **Zero dependências.** Apenas Node.js 24+ e `git`.
- **Privacidade por padrão.** Só contagens e datas saem da sua máquina; projetos aparecem anonimizados (`projeto-privado-N`) a menos que você escolha nomes públicos.
- **Publicação com trava.** O `publish` é um dry-run por padrão e só envia com confirmação explícita.
- **Atualização diária** por tarefa agendada (Agendador de Tarefas do Windows ou `cron`).
- **Temas** claro, escuro ou automático, em inglês ou português (pt-BR).
- **3 modelos de SVG** (painel completo, cartão compacto e calendário de atividade) e **cores personalizáveis**, sem servidor: veja [Modelos e cores](#modelos-e-cores).

## Fontes suportadas

| Ferramenta | O que é medido |
|---|---|
| Claude Code (CLI e extensão do VS Code) | sessões, mensagens, tokens e projeto |
| Cline (CLI) | sessões, mensagens, tokens e projeto |
| ChatGPT (via catálogo do app desktop) | só o número de sessões por dia |

Ainda não suportados: Cursor, GitHub Copilot CLI, Gemini/Antigravity, threads do Codex, DeepSeek e o uso de ChatGPT ou Claude no navegador (sem dados locais). Os formatos, as limitações e o status de cada fonte estão em [`docs/fontes-de-dados.md`](docs/fontes-de-dados.md).

## Instalação

Requisitos: **Node.js 24 ou mais novo** (usa `node:sqlite`) e **git**.

Rode sem instalar, com `npx`:

```bash
npx ai-usage-metrics --help
```

Ou instale globalmente:

```bash
npm install -g ai-usage-metrics
ai-usage-metrics --help
```

Também dá para rodar direto do código-fonte:

```bash
git clone https://github.com/brenoluizdev/ai-usage-metrics.git
cd ai-usage-metrics
node bin/ai-usage-metrics.mjs --help
```

Nos exemplos abaixo, `ai-usage-metrics` é o comando instalado. Com `npx`, escreva `npx ai-usage-metrics`; a partir do código-fonte, `node bin/ai-usage-metrics.mjs`.

## Início rápido

A forma recomendada é o assistente interativo (precisa de um terminal):

```bash
npx ai-usage-metrics setup
```

Ele pergunta, passo a passo, o que precisa e leva você do zero até o primeiro painel publicado e o agendamento diário. Veja a próxima seção. O `init` por flags (abaixo) continua existindo para automação e uso avançado.

## Assistente de configuração (`setup`)

`ai-usage-metrics setup` substitui os passos manuais do `init`: cria o repositório de dados (se você quiser e tiver o `gh`), grava o e-mail noreply com ID, escolhe projetos públicos, modelo e cores com prévia dos seus próprios dados, cria a tarefa agendada e publica pela primeira vez.

- **Só em terminal interativo.** Sem terminal, ou com `--non-interactive`, não faz nada e manda você para o `init`.
- **Cada ação externa tem a sua confirmação `[s/N]` (padrão N)**, descrevendo o que vai acontecer: consultar o `gh`, consultar a API pública do GitHub, criar o repositório de dados (**público**), `restore` do histórico, instalar uma cópia fixa do pacote com `npm install`, criar a tarefa agendada e publicar. Nada disso acontece sem o seu "s".
- **O `gh` é opcional.** Toda etapa tem o caminho manual equivalente. A ferramenta nunca lê, pede, guarda nem imprime token.
- **Nada é gravado antes do resumo final** (exceto as prévias dos SVGs em `<state-dir>/out/preview/`). A configuração é gravada de forma atômica e, ao reconfigurar, a anterior vira `config.json.bak`.
- **Histórico**: o publish do assistente passa pela guarda de regressão (frase exata para publicar com perda) e o `restore` dele mescla sem encolher o histórico local.
- **Refazer**: rode `setup` de novo; os valores atuais viram o padrão (Enter mantém) e há a opção "só mudar modelo e cores".
- **Windows**: se o pacote está no cache do `npx` (o agendamento quebraria quando o cache for limpo), o assistente oferece instalar uma cópia fixa em `~/.ai-usage-metrics-runtime` e agenda a partir dela. Linux/macOS: imprime a linha de `cron` (não validada).

Detalhes do fluxo e das decisões em [`docs/setup.md`](docs/setup.md); modelo de segurança em [`SECURITY.md`](SECURITY.md).

### Alternativa: `init` por flags (automação e uso avançado)

1. Crie, no GitHub, um repositório **público e vazio** chamado `seu-usuario/ai-metrics`. O `init` não cria nada no GitHub.
2. Gere a configuração local:
   ```bash
   ai-usage-metrics init --user seu-usuario --public meu-site,outro-projeto --lang pt-BR --title "Meu uso de IA"
   ```
   O `init` grava o `config.json` e imprime o trecho de README, as URLs dos 4 SVGs e as instruções de agendamento. Para escolher o modelo já aqui: `--model model-2` (veja [Modelos e cores](#modelos-e-cores)).

   **Contas novas do GitHub:** o e-mail de commit padrão (`usuario@users.noreply.github.com`) pode não vincular os commits ao seu perfil. Se isso acontecer, edite o `config.json` e defina `"commitEmail"` com o formato que inclui o ID numérico, `ID+usuario@users.noreply.github.com` (o ID aparece em Settings > Emails, ou em `https://api.github.com/users/seu-usuario`).
3. Veja o que sairia, sem enviar nada:
   ```bash
   ai-usage-metrics export
   ai-usage-metrics render
   ai-usage-metrics publish      # dry-run
   ```
   Abra `~/.ai-usage-metrics/out/metrics.svg` (ou `metrics.model-2.svg`, `metrics.model-3.svg`) no navegador para conferir o painel.
4. Envie uma vez, conferindo a lista de arquivos, os números e os nomes públicos que o comando mostra:
   ```bash
   ai-usage-metrics publish --yes
   ```
5. Cole no README do seu perfil (repositório `seu-usuario/seu-usuario`):
   ```markdown
   ![AI usage](https://raw.githubusercontent.com/seu-usuario/ai-metrics/main/metrics.svg)
   ```

## Modelos e cores

São 3 modelos de SVG, todos gerados na sua máquina e enviados ao seu próprio repositório (sem servidor):

| `model-1` (padrão): painel completo | `model-2`: cartão compacto | `model-3`: calendário de atividade |
|---|---|---|
| <img alt="model-1: cartões, sessões por mês e projetos com mais uso" src="examples/metrics.example.model-1.light.svg" width="300"> | <img alt="model-2: os 4 números e a barra de sessões por ferramenta" src="examples/metrics.example.model-2.light.svg" width="200"> | <img alt="model-3: mapa de calor das últimas 53 semanas" src="examples/metrics.example.model-3.light.svg" width="300"> |
| <img alt="model-1, tema escuro" src="examples/metrics.example.model-1.dark.svg" width="300"> | <img alt="model-2, tema escuro" src="examples/metrics.example.model-2.dark.svg" width="200"> | <img alt="model-3, tema escuro" src="examples/metrics.example.model-3.dark.svg" width="300"> |

O `publish` envia os 4 SVGs; escolha o modelo pela URL (sem rodar de novo). `metrics.svg` é o modelo definido em `model` na configuração:

```markdown
![AI usage](https://raw.githubusercontent.com/seu-usuario/ai-metrics/main/metrics.model-1.svg)
![AI usage](https://raw.githubusercontent.com/seu-usuario/ai-metrics/main/metrics.model-2.svg)
![AI usage](https://raw.githubusercontent.com/seu-usuario/ai-metrics/main/metrics.model-3.svg)
```

O `model-3` usa a métrica `sessions` (sessões por dia, em UTC) das últimas 53 semanas; os níveis de cor vêm dos quantis dos dias ativos. Detalhes em [`docs/modelos.md`](docs/modelos.md).

### Cores

Só cores são personalizáveis (nada de fonte, tamanho, raio ou layout). No `config.json`:

| Chave de `colors` / `colorsDark` | O que pinta |
|---|---|
| `background` | fundo do painel |
| `card` | fundo dos cartões de números |
| `border` | bordas e linhas |
| `text` | título e números |
| `muted` | textos secundários |
| `track` | fundo das barras |
| `accent` | barras do ranking de projetos; também a base da escala de calor do `model-3` (derivada de `accent` e `background`) |
| `tools` | mapa `idDaFerramenta -> cor` (ids de `ai-usage-metrics sources`: `claude-code`, `cline`, `chatgpt`) |

`colors` vale para o tema claro e, com `theme: "auto"` e sem `colorsDark`, também para o escuro. `colorsDark` vale só para o escuro. Com `theme: "light"` só `colors` é usado; com `theme: "dark"`, `colorsDark` (ou `colors`, se ele não existir). Cada valor tem de ser **somente `#rgb` ou `#rrggbb`**: nomes de cor, `rgb()`, `var()`, `url()` e qualquer outra coisa são recusados, assim como chaves ou ferramentas desconhecidas.

Tema escuro personalizado (fundo roxo, destaque verde):

```json
{
  "model": "model-3",
  "colorsDark": { "background": "#1a1033", "card": "#241747", "border": "#3b2a6b", "text": "#f3e8ff", "muted": "#b9a7e0", "track": "#2e1f5c", "accent": "#22c55e" }
}
```

Tema claro:

```json
{ "theme": "light", "colors": { "accent": "#2563eb", "background": "#f8fafc", "tools": { "claude-code": "#1d4ed8" } } }
```

> **Legibilidade é por sua conta.** Não há ajuste automático de contraste: confira o SVG nos dois temas antes de publicar.

## Como funciona

```
tarefa agendada (1x/dia)
  -> a CLI lê os registros locais, agrega e anonimiza
  -> metrics.json + metrics.svg + metrics.model-1/2/3.svg (gerados na sua máquina)
  -> git push para <seu-usuario>/ai-metrics (repositório público seu)
  -> o README do perfil aponta para o SVG
```

Só a última etapa usa a rede (`git clone`, `fetch` e `push` para o remoto que você configurou), e só depois da sua confirmação.

## Comandos

| Comando | O que faz |
|---|---|
| `sources` | lista as fontes e se existem neste computador |
| `report` | resumo no terminal. **Mostra nomes reais de projetos: não cole em lugar público** |
| `export` | gera o JSON agregado e anonimizado (esquema v1, em [`docs/esquema.md`](docs/esquema.md)) |
| `render` | gera os SVGs a partir do JSON (`--theme auto\|light\|dark`, `--title`, `--lang en\|pt-BR`, `--model model-1\|model-2\|model-3`). Sem `--out`, grava `metrics.svg` e os três `metrics.model-N.svg` em `<state-dir>/out`; com `--out arquivo.svg`, grava só aquele arquivo; com `--out-dir pasta`, o conjunto completo nessa pasta |
| `publish` | dry-run por padrão; com `--yes` (ou resposta interativa) envia o JSON e os 4 SVGs (5 arquivos) |
| `setup` | **assistente interativo (recomendado)**: guia do zero até o primeiro painel publicado e o agendamento. Só em terminal; cada ação externa pede `[s/N]` |
| `init` | (automação/avançado) cria a configuração local por flags e imprime o trecho de README e o agendamento |
| `run` | `export`, `render` e `publish` numa etapa, para o agendador. No agendador use `--non-interactive` (nunca pergunta nada) |
| `history reset` | apaga o `history.json` local, só com confirmação (`[s/N]` em terminal ou `--yes`). O que já foi publicado não é tocado |
| `restore` | computador novo: baixa o último `metrics.json` publicado no seu repositório de dados e o grava como histórico local (`history.json`). É rede: pede confirmação (`[s/N]` ou `--yes`). `restore --from-file <json>` faz o mesmo 100% offline |

`publish` e `run` aceitam `--accept-history-loss` (sem terminal: aceita publicar um JSON menor que o histórico). `export` aceita `--no-history` (não mescla com o histórico só nesta execução). Veja "Histórico e computador novo".

Opções gerais: `--state-dir <pasta>`, `--config <arquivo>`, `--since <30d|AAAA-MM-DD>`, `--tool <id>` (repetível) e `--top <n>`. Rode `--help` para a lista completa.

Tudo fica em `~/.ai-usage-metrics` (configuração, estado, clone de dados em `repo/` e saídas em `out/`). Use uma pasta própria para o estado: raiz de unidade, a pasta pessoal inteira e pastas que já são repositórios git são recusadas.

## Configuração

O arquivo `config.json` aceita as chaves abaixo. Chaves desconhecidas são recusadas, para que um erro de digitação não desligue uma trava em silêncio.

| Chave | Padrão | Significado |
|---|---|---|
| `githubUser` | (obrigatória) | seu usuário do GitHub |
| `dataRepo` | `ai-metrics` | repositório público de dados |
| `branch` | `main` | branch que recebe o push |
| `publicProjects` | `[]` | projetos que podem aparecer com nome: uma lista (`["meu-app"]`) ou um mapa (`{"pasta": "Nome público"}`). A chave do mapa pode ser o caminho completo, para separar pastas com o mesmo nome. Todo o resto é anonimizado |
| `theme` | `auto` | `auto` (segue o tema do visitante), `light` ou `dark` |
| `title` | (nenhum) | título do SVG, até 60 caracteres, sem caminho, e-mail nem nome de arquivo |
| `model` | `model-1` | qual modelo vai em `metrics.svg`: `model-1`, `model-2` ou `model-3` (os três sempre são enviados também como `metrics.model-N.svg`) |
| `colors` | (nenhum) | cores do tema claro (e do escuro no `auto`, se não houver `colorsDark`): `background`, `card`, `border`, `text`, `muted`, `track`, `accent` e `tools`; só `#rgb` ou `#rrggbb` |
| `colorsDark` | (nenhum) | as mesmas chaves, só para o tema escuro |
| `lang` | `en` | `en` ou `pt-BR` |
| `history` | `true` | mescla a série diária com o último JSON publicado (veja "Histórico e computador novo"); `false` desliga |
| `autoPublish` | `false` | permite que `run` envie sem confirmação, no agendador |
| `remoteUrl` | `https://github.com/<user>/<repo>.git` | outro remoto: só `https://host/caminho`, `git@host:caminho` ou `ssh://git@host/caminho`, sem usuário, senha nem token |
| `commitName` | `githubUser` | nome do autor do commit público |
| `commitEmail` | `<githubUser>@users.noreply.github.com` | e-mail do autor do commit público. Qualquer e-mail que não seja o noreply do GitHub exige confirmação extra |

## Histórico e computador novo

Sem histórico, cada `export` usaria só os registros que existem agora, e o painel perderia dias se você formatasse o PC, trocasse de computador ou se o Claude Code apagasse sessões antigas. Por isso o `export` (e o `run`) **mescla a série diária** com a do último `metrics.json` publicado (guardado em `~/.ai-usage-metrics/history.json` depois de cada envio bem-sucedido, ou lido do clone local de dados). Desligue com `"history": false` ou `export --no-history`.

- **O que é preservado:** a série diária (sessões, mensagens, tokens por dia e por ferramenta), os totais, o período, os dias ativos e os dados por ferramenta, recalculados a partir da série mesclada.
- **O que NÃO é preservado:** o **ranking de projetos** (`projects` e `totals.projects`) vem só dos registros locais. Os nomes anonimizados `projeto-privado-N` não têm identidade estável entre execuções, então não dá para restaurá-los. Os totais de tokens por tipo (entrada/saída/cache) dos dias restaurados são aproximados (a série guarda só o total por dia), e `sessions` pode ser um pouco superestimado para sessões de vários dias que só existem no histórico.
- **Como o máximo funciona:** se um dia existe nos dois lados, vale o **maior** valor de cada campo. As contagens de um dia só crescem e os registros locais podem ter sido apagados em parte, então o menor valor é o que perdeu dados; somar contaria o mesmo dia duas vezes. Reaplicar a mescla não infla nada (exportar duas vezes dá o mesmo JSON, exceto `generatedAt`).
- **O `history.json` nunca encolhe:** depois de cada envio ele recebe a **mescla por máximo** do anterior com o JSON publicado, não uma cópia. Um `export --no-history`, `--since`, `--tool` ou `"history": false` não apaga o histórico local. Para zerar de propósito: `history reset`.
- **Guarda de regressão no `publish`:** se o JSON a publicar tem menos dias ou totais menores (sessões, mensagens, tokens) que o histórico local ou que o `metrics.json` já publicado, o dry-run mostra um aviso em destaque (antes -> depois, quantos dias seriam removidos, e a causa provável: `--no-history`, `--since`, `--tool` ou `history:false`). Em terminal, o envio exige que você digite exatamente `publicar com perda de histórico`; sem terminal, exige `--accept-history-loss`; o envio automático (`run` agendado) é **bloqueado** e nunca aceita a perda. A mesma checagem roda de novo, no envio, contra o que o repositório de dados tem de verdade (por exemplo, outro computador que publicou mais).
- **Dois computadores:** o baseline é a mescla por máximo do `history.json` e do `metrics.json` do clone local (se um for inválido, usa o outro com aviso). Um baseline com totais incoerentes com a própria série (por exemplo `totals.sessions` gigante) é ignorado com aviso.
- **`restore` não sobrescreve:** se já existe `history.json`, o restaurado é mesclado pelo máximo e a comparação (dias e totais) é mostrada antes de gravar. `restore --from-file` recusa caminhos de rede (UNC) no Windows, para continuar 100% offline.
- **Avisos:** o `export` e o dry-run do `publish` dizem quantos dias vieram só do histórico, quantos são só locais e quantos foram elevados, e avisam em destaque quando os registros locais têm muito menos dias que o histórico.
- Nada disso publica mais do que já era público (a série diária). Detalhes do algoritmo: [`docs/historico.md`](docs/historico.md).

### Computador novo (ou PC formatado)

1. Instale o Node 24+ e o pacote (`npm install -g ai-usage-metrics`).
2. `ai-usage-metrics init --user <seu-usuario>` (com o mesmo repositório de dados de antes).
3. `ai-usage-metrics restore` (confirme com `s`, ou use `--yes`). Ele baixa o último `metrics.json` do SEU repositório, valida e grava o `history.json`. Sem rede: `restore --from-file <metrics.json>`.
4. `ai-usage-metrics run` (ou `export`, `render` e `publish`): o painel mantém a série e os totais antigos e soma o que este computador registrar daqui para a frente.

## Publicação segura

O `publish` foi desenhado para que um envio acidental seja difícil:

- **Dry-run por padrão.** Sem `--yes`, nada é enviado. Ele mostra o repositório e a branch, os arquivos (só `metrics.json`, `metrics.svg` e `metrics.model-1.svg`, `metrics.model-2.svg`, `metrics.model-3.svg`: 5 arquivos planos na raiz do repositório de dados), a diferença contra o que já está publicado, os números, quantos projetos estão anonimizados, **quais nomes ficariam públicos** e o **autor do commit**.
- **Validação antes de enviar.** O JSON passa por uma allowlist estrita do esquema (qualquer campo extra, texto livre, caminho ou e-mail é rejeitado), pela barreira de privacidade e pela checagem dos nomes públicos. Os 4 SVGs são gerados de novo a partir do JSON validado e passam pela barreira de privacidade; as cores são validadas (só hexadecimal).
- **Nunca `--force`.** Se o remoto avançou de forma incompatível, o push falha e nada é sobrescrito.
- **Sem token.** Usa o `git` e as credenciais que você já tem (gerenciador de credenciais ou SSH). Não pede, não guarda e não registra credenciais.
- **Um único `metrics.json` agregado**, sem arquivo por projeto, para não criar uma linha do tempo detalhada no histórico do repositório.
- O `git` roda sem os seus hooks, com ambiente limpo e só com `https` e `ssh` permitidos.

## Agendamento

O assistente `setup` cria a tarefa no Windows por você (com a sua confirmação). O `init` imprime as instruções e **não instala nada**. No Windows ele imprime duas versões do `schtasks`, uma para o `cmd.exe` e outra para o PowerShell; use a do terminal onde for colar. No Linux e no macOS, use `cron`. Exemplo (cmd.exe):

```
schtasks /Create /SC DAILY /ST 12:00 /TN "ai-usage-metrics" /TR "\"C:\caminho\node.exe\" \"C:\caminho\bin\ai-usage-metrics.mjs\" run --non-interactive"
```

A tarefa roda sem terminal, então:

- **mantenha o `--non-interactive`** se montar o comando à mão. O Agendador do Windows dá um console ao processo, e sem essa opção o `run` entende que há uma pessoa digitando e fica esperando a resposta de `[s/N]` para sempre (a versão 0.1.0 tinha esse defeito; a 0.1.1 corrige e o `init` já imprime o comando com a opção);
- o `git` precisa ter credencial salva, senão o push falha (não trava esperando senha);
- `run` sem terminal **só gera os arquivos**, a menos que você tenha definido `"autoPublish": true` **e** feito antes um `publish` manual confirmado em um terminal interativo;
- a aprovação fica amarrada ao repositório e à branch de destino, ao nome e e-mail do autor do commit e aos pares pasta -> nome público. Se qualquer um mudar, o envio automático é bloqueado e explica como reaprovar;
- só uma execução por vez usa a pasta de estado (arquivo `.lock`).

## Privacidade e segurança

- **O que é lido:** só campos estruturais (datas, contagens, tokens e o nome da última pasta do projeto). O texto das conversas é descartado.
- **O que é publicado:** contagens, datas e nomes de projeto, anonimizados por padrão. Datas, volume diário e a ordem do ranking continuam públicos, mesmo com nomes anonimizados.
- **O histórico de um repositório público é permanente.** Apagar um arquivo depois não remove o que já foi enviado (clones e forks podem tê-lo). Por isso o `publish` é dry-run por padrão: confira antes de confirmar.
- **Os dados são autodeclarados.** Qualquer pessoa pode editar o JSON do próprio repositório; o painel não prova nada para terceiros.

O modelo de ameaças, as travas e como reportar uma vulnerabilidade estão em [`SECURITY.md`](SECURITY.md).

## Limitações

- **Validado apenas no Windows.** Linux e macOS usam `os.homedir()` e `path`, mas não foram testados: trate como não suportados até alguém confirmar.
- **Os formatos das ferramentas mudam.** Claude Code, Cline e o app do ChatGPT não documentam seus arquivos locais. Uma atualização pode quebrar um adaptador ou subcontar (o Claude Code, por exemplo, apaga sessões antigas por idade).
- Os números são aproximados e as datas estão em UTC.
- O histórico só preserva a série diária e os totais; o ranking de projetos não é restaurado (veja "Histórico e computador novo").
- O ChatGPT cobre só o que o app desktop sincronizou, e só a contagem por dia.

## Estrutura do projeto

```
bin/        ponto de entrada da CLI
src/        comandos, adaptadores das fontes, agregação, privacidade, publicação, SVG e o assistente (setup.mjs, ambiente.mjs)
test/       testes com fixtures sintéticas e repositório git local como remoto
docs/       esquema do JSON, fontes de dados, modelos e cores, histórico e o assistente setup
examples/   JSON e SVGs de exemplo dos 3 modelos (dados fictícios)
templates/  workflow opcional do GitHub Actions
```

O workflow opcional gera só o `metrics.svg` (com `render --out`, modelo e cores padrão, pois a configuração local não existe no repositório de dados).

## Contribuindo

### Adicionar uma fonte

1. Crie `src/adapters/minha-fonte.mjs` exportando um `Adapter` (contrato em `src/types.mjs`): `id` (minúsculas, números e hífen), `name`, `capabilities`, `available(ctx)` e `events(ctx)`, um gerador assíncrono de eventos `{tool, project, session, ts, kind, tokens?}`.
2. Registre em `src/adapters/index.mjs`.
3. Teste com uma fixture **sintética** em `test/` (veja `test/fixtures.mjs`). Nunca use conversas reais.
4. Documente o formato em `docs/fontes-de-dados.md`.

O adaptador deve ler só campos estruturais e descartar qualquer texto.

### Desenvolvimento

```bash
npm test         # node:test, fixtures sintéticas, repositório git bare local como remoto
npm run lint     # checagem de sintaxe (node --check), sem dependências
npm run exemplo  # regera examples/ (JSON e SVGs sintéticos dos 3 modelos, claro e escuro)
```

### Workflow opcional do GitHub Actions

`templates/github-actions/render-svg.yml` regera o `metrics.svg` quando o `metrics.json` muda, com permissões mínimas e as ações fixadas por SHA de commit. É opcional, porque o `publish` já envia o SVG pronto. Ele depende de o pacote estar publicado no npm e ainda não foi testado em um GitHub real.

## Licença

[MIT](LICENSE)
