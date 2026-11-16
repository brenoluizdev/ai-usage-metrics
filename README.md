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

## Fontes suportadas

| Ferramenta | O que é medido |
|---|---|
| Claude Code (CLI e extensão do VS Code) | sessões, mensagens, tokens e projeto |
| Cline (CLI) | sessões, mensagens, tokens e projeto |
| ChatGPT (via catálogo do app desktop) | só o número de sessões por dia |

Ainda não suportados: Cursor, GitHub Copilot CLI, Gemini/Antigravity, threads do Codex, DeepSeek e o uso de ChatGPT ou Claude no navegador (sem dados locais). Os formatos, as limitações e o status de cada fonte estão em [`docs/fontes-de-dados.md`](docs/fontes-de-dados.md).

## Instalação

Requisitos: **Node.js 24 ou mais novo** (usa `node:sqlite`) e **git**.

O pacote ainda não foi publicado no npm. Por enquanto, rode a partir de um clone:

```bash
git clone https://github.com/brenoluizdev/ai-usage-metrics.git
cd ai-usage-metrics
node bin/ai-usage-metrics.mjs --help
```

Nos exemplos abaixo, `ai-usage-metrics` significa `node bin/ai-usage-metrics.mjs`.

## Início rápido

1. Crie, no GitHub, um repositório **público e vazio** chamado `seu-usuario/ai-metrics`. A ferramenta não cria nada no GitHub.
2. Gere a configuração local:
   ```bash
   ai-usage-metrics init --user seu-usuario --public meu-site,outro-projeto --lang pt-BR --title "Meu uso de IA"
   ```
   O `init` grava o `config.json` e imprime o trecho de README e as instruções de agendamento.
3. Veja o que sairia, sem enviar nada:
   ```bash
   ai-usage-metrics export
   ai-usage-metrics render
   ai-usage-metrics publish      # dry-run
   ```
   Abra `~/.ai-usage-metrics/out/metrics.svg` no navegador para conferir o painel.
4. Envie uma vez, conferindo a lista de arquivos, os números e os nomes públicos que o comando mostra:
   ```bash
   ai-usage-metrics publish --yes
   ```
5. Cole no README do seu perfil (repositório `seu-usuario/seu-usuario`):
   ```markdown
   ![AI usage](https://raw.githubusercontent.com/seu-usuario/ai-metrics/main/metrics.svg)
   ```

## Como funciona

```
tarefa agendada (1x/dia)
  -> a CLI lê os registros locais, agrega e anonimiza
  -> metrics.json + metrics.svg (gerados na sua máquina)
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
| `render` | gera o SVG a partir do JSON (`--theme auto\|light\|dark`, `--title`, `--lang en\|pt-BR`) |
| `publish` | dry-run por padrão; com `--yes` (ou resposta interativa) envia o JSON e o SVG |
| `init` | cria a configuração local e imprime o trecho de README e o agendamento |
| `run` | `export`, `render` e `publish` numa etapa, para o agendador |

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
| `lang` | `en` | `en` ou `pt-BR` |
| `autoPublish` | `false` | permite que `run` envie sem confirmação, no agendador |
| `remoteUrl` | `https://github.com/<user>/<repo>.git` | outro remoto: só `https://host/caminho`, `git@host:caminho` ou `ssh://git@host/caminho`, sem usuário, senha nem token |
| `commitName` | `githubUser` | nome do autor do commit público |
| `commitEmail` | `<githubUser>@users.noreply.github.com` | e-mail do autor do commit público. Qualquer e-mail que não seja o noreply do GitHub exige confirmação extra |

## Publicação segura

O `publish` foi desenhado para que um envio acidental seja difícil:

- **Dry-run por padrão.** Sem `--yes`, nada é enviado. Ele mostra o repositório e a branch, os arquivos (só `metrics.json` e `metrics.svg`), a diferença contra o que já está publicado, os números, quantos projetos estão anonimizados, **quais nomes ficariam públicos** e o **autor do commit**.
- **Validação antes de enviar.** O JSON passa por uma allowlist estrita do esquema (qualquer campo extra, texto livre, caminho ou e-mail é rejeitado), pela barreira de privacidade e pela checagem dos nomes públicos. O SVG é gerado de novo a partir do JSON validado.
- **Nunca `--force`.** Se o remoto avançou de forma incompatível, o push falha e nada é sobrescrito.
- **Sem token.** Usa o `git` e as credenciais que você já tem (gerenciador de credenciais ou SSH). Não pede, não guarda e não registra credenciais.
- **Um único `metrics.json` agregado**, sem arquivo por projeto, para não criar uma linha do tempo detalhada no histórico do repositório.
- O `git` roda sem os seus hooks, com ambiente limpo e só com `https` e `ssh` permitidos.

## Agendamento

O `init` imprime as instruções e **não instala nada**. No Windows ele imprime duas versões do `schtasks`, uma para o `cmd.exe` e outra para o PowerShell; use a do terminal onde for colar. No Linux e no macOS, use `cron`. Exemplo (cmd.exe):

```
schtasks /Create /SC DAILY /ST 12:00 /TN "ai-usage-metrics" /TR "\"C:\caminho\node.exe\" \"C:\caminho\bin\ai-usage-metrics.mjs\" run"
```

A tarefa roda sem terminal, então:

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
- O ChatGPT cobre só o que o app desktop sincronizou, e só a contagem por dia.

## Estrutura do projeto

```
bin/        ponto de entrada da CLI
src/        comandos, adaptadores das fontes, agregação, privacidade, publicação e SVG
test/       testes com fixtures sintéticas e repositório git local como remoto
docs/       esquema do JSON e fontes de dados
examples/   JSON e SVG de exemplo (dados fictícios)
templates/  workflow opcional do GitHub Actions
```

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
npm run exemplo  # regera examples/ (JSON e SVG sintéticos)
```

### Workflow opcional do GitHub Actions

`templates/github-actions/render-svg.yml` regera o `metrics.svg` quando o `metrics.json` muda, com permissões mínimas e as ações fixadas por SHA de commit. É opcional, porque o `publish` já envia o SVG pronto. Ele depende de o pacote estar publicado no npm e ainda não foi testado em um GitHub real.

## Licença

[MIT](LICENSE)
