# ai-usage-metrics

Mede, no seu computador, o uso das suas ferramentas de IA (Claude Code, Cline, ChatGPT pelo app desktop) e publica um painel em SVG no **seu próprio repositório público** do GitHub, para você mostrar no README do perfil.

- **Sem servidor** de terceiros e **sem IA no meio**: todo número é calculado por código, de forma determinística, a partir de registros que já estão no seu disco.
- **Zero dependências**: só Node 24+ (usa `node:sqlite`, `node:test`, `git`).
- **Privacidade por padrão**: nada de conversas, código, caminhos, e-mail ou ids. Projetos ficam anonimizados (`projeto-privado-N`) a menos que você os coloque numa lista de nomes públicos.

> Status: versão 0.1, privada (não publicada no npm). **Só foi validado no Windows.** Linux/macOS usam `os.homedir()` e `path`, mas não foram testados: trate como não suportados até alguém confirmar.

## Como funciona

```
tarefa agendada (1x/dia) -> CLI lê registros locais, agrega e anonimiza
   -> metrics.json (+ metrics.svg renderizado localmente)
   -> git push para <seu-usuário>/ai-metrics (repositório público seu)
   -> README do perfil aponta para o SVG
```

Exemplos sintéticos (números inventados): `examples/metrics.example.light.svg` e `examples/metrics.example.dark.svg`.

## Instalação

O pacote ainda não está no npm. Por enquanto, clone este repositório e rode com Node 24+:

```bash
node bin/ai-usage-metrics.mjs --help
```

(Depois de publicado, será `npx ai-usage-metrics ...`. Nos exemplos abaixo, `ai-usage-metrics` significa `node bin/ai-usage-metrics.mjs`.)

## Uso

```bash
ai-usage-metrics sources            # quais fontes existem neste PC
ai-usage-metrics report --since 90d # resumo no terminal (nomes REAIS: não cole em lugar público)
ai-usage-metrics init --user seu-usuario --public meu-site,outro-projeto --lang pt-BR --title "Meu uso de IA"
ai-usage-metrics export             # gera o JSON agregado
ai-usage-metrics render             # gera o SVG (temas auto|light|dark)
ai-usage-metrics publish            # DRY-RUN: mostra o que seria enviado
ai-usage-metrics publish --yes      # envia (commit + push), depois de você conferir
ai-usage-metrics run                # export -> render -> publish, para o agendador
```

Tudo fica em `~/.ai-usage-metrics` (configuração `config.json`, estado, clone de dados em `repo/`, saídas em `out/`). Use `--state-dir` para outra pasta. Use uma pasta própria para o estado: raiz de unidade, a pasta pessoal inteira e pastas que já são repositório git são recusadas. A pasta `repo/` só é alterada se tiver sido criada pela ferramenta (marcador `repo.owner.json`); uma pasta `repo` sua é recusada sem apagar nada, e um clone nosso divergente é renomeado para `repo.velho-*` (ficam só os 3 mais recentes). Os arquivos gerados (`metrics.json`, `metrics.svg`, `avisos.json`) usam modo `0600` em Linux/macOS (no Windows valem as ACLs do seu perfil). Projetos com caminho maior que 4096 caracteres são agrupados em "(sem projeto)".

### Passo a passo

1. Crie, no GitHub, um repositório **público e vazio** `seu-usuario/ai-metrics` (o programa não cria nada).
2. `init` grava a configuração e imprime o trecho de README e as instruções de agendamento.
3. `export`, `render` e `publish` (dry-run) para ver o que sairia. Abra `~/.ai-usage-metrics/out/metrics.svg` no navegador.
4. `publish --yes` uma vez, conferindo a lista de arquivos, os números e os nomes públicos que o comando mostra.
5. Cole no README do seu perfil (repositório `seu-usuario/seu-usuario`):
   `![AI usage](https://raw.githubusercontent.com/seu-usuario/ai-metrics/main/metrics.svg)`

### Configuração (`config.json`)

| Chave | Padrão | Significado |
|---|---|---|
| `githubUser` | (obrigatória) | seu usuário do GitHub |
| `dataRepo` | `ai-metrics` | nome do repositório público de dados |
| `branch` | `main` | branch que recebe o push |
| `publicProjects` | `[]` | projetos que podem aparecer com nome: lista (`["meu-app"]`) ou mapa (`{"pasta": "Nome público"}`); a chave do mapa pode ser o **caminho completo** (`{"C:\\dev\\app": "app-pessoal"}` (no JSON a barra invertida é dobrada; `C:/dev/app` também serve)) para separar pastas com o mesmo nome; resto é anonimizado. O nome público não pode ser igual ao seu usuário do sistema nem parecer caminho/e-mail/arquivo |
| `theme` | `auto` | `auto` (segue o tema do visitante), `light` ou `dark` |
| `title` | (nenhum) | título do SVG, até 60 caracteres, sem caminho, e-mail nem nome de arquivo (passa pela barreira de privacidade) |
| `lang` | `en` | `en` ou `pt-BR` |
| `autoPublish` | `false` | permite que `run` envie sem confirmação, no agendador (veja abaixo) |
| `remoteUrl` | `https://github.com/<user>/<repo>.git` | outro remoto: só `https://host/caminho`, `git@host:caminho` ou `ssh://git@host/caminho`, sem usuário/senha/token (`http://`, `git://`, `file://`, caminhos locais, `localhost`, nomes sem ponto e IPs são recusados; host diferente de `github.com` gera um aviso no dry-run). `git@host:caminho` e `ssh://git@host/caminho` contam como destinos diferentes |
| `commitName` | `githubUser` | nome do autor do commit público |
| `commitEmail` | `<githubUser>@users.noreply.github.com` | e-mail do autor do commit público; o noreply com ID numérico (`ID+usuario@users.noreply.github.com`) também vale. Qualquer outro e-mail exige confirmação extra (veja `SECURITY.md`) |

Chaves desconhecidas são recusadas (um erro de digitação não liga nem desliga travas em silêncio).

### `publish`: dry-run e confirmação

- Sem `--yes`, **não envia nada**. Mostra: repositório e branch, a lista de arquivos (só `metrics.json` e `metrics.svg`), diferença contra o que já está no clone local, números, quantos projetos estão anonimizados e **quais nomes ficariam públicos**.
- O dry-run mostra o **autor do commit** (nome e e-mail) que ficará no histórico público. Se o e-mail não for um noreply do GitHub, avisa e exige confirmação extra (frase digitada em terminal, ou `--accept-public-email` sem terminal; o automático bloqueia).
- Em terminal interativo ele pergunta `[s/N]`. Fora de terminal (agendador, pipe) e sem `--yes`, só mostra o plano.
- Antes de qualquer envio o JSON passa por: (1) **allowlist estrita** do esquema v1 (campo extra, texto livre, caminho, e-mail ou usuário do sistema são rejeitados), (2) a barreira de privacidade, (3) checagem de que todo nome público está na sua lista. O SVG enviado é gerado de novo a partir do JSON validado.
- Usa o `git` instalado e as credenciais que você já tem (gerenciador de credenciais ou SSH). Não pede, não guarda e não registra token. Nunca usa `--force`: se o remoto avançou de um jeito incompatível, o push falha e nada é sobrescrito.
- Um único `metrics.json` agregado (não há arquivo por projeto, para não criar uma linha do tempo detalhada no histórico). Mensagem de commit fixa: `chore(metrics): update AI usage metrics`. O git roda sem hooks seus, com ambiente limpo e só com `https`/`ssh` permitidos (detalhes em `SECURITY.md`).
- Só nesta etapa (depois da confirmação) há rede: `git clone`/`fetch`/`push` para o remoto que você configurou. Todo o resto é local.

### Agendamento

`init` imprime as instruções (não instala nada). No Windows ele imprime DUAS versões do `schtasks`, e você usa a do terminal onde vai colar: uma para o **cmd.exe** e outra para o **PowerShell** (esta usa `Start-Process -ArgumentList '...'`, porque o PowerShell não trata `\"` como escape ao chamar um `.exe` e quebraria caminhos com espaço, como `C:\Program Files`). Exemplo da versão cmd.exe:

```
schtasks /Create /SC DAILY /ST 12:00 /TN "ai-usage-metrics" /TR "\"C:\caminho\node.exe\" \"C:\caminho\bin\ai-usage-metrics.mjs\" run"
```

Se algum caminho tiver um caractere que não dá para citar com segurança numa dessas shells (no cmd: `& | < > ^ % !`; em ambas: aspas duplas e quebra de linha), o comando daquela shell **não é impresso** e aparece um aviso. As duas versões foram testadas com o `cmd.exe` e o Windows PowerShell 5.1 reais (sem criar tarefa), conferindo que o valor de `/TR` chega íntegro; o PowerShell 7 não foi testado.

No Linux/macOS use `cron` (instruções impressas pelo `init`; não validadas). A tarefa roda sem terminal, então:

- o `git` precisa ter credencial salva, senão o push falha (não trava esperando senha);
- `run` sem terminal **só gera** os arquivos localmente, a menos que você tenha posto `"autoPublish": true` na configuração **e** já tenha feito um `publish` manual confirmado **num terminal interativo** (`publish --yes` sem terminal não conta). A aprovação fica amarrada ao repositório e à branch de destino, ao **nome e e-mail do autor do commit** e aos pares pasta -> nome público: se qualquer um mudar (ou aparecer um nome público novo), o envio automático é bloqueado e explica como reaprovar (rodar `publish` num terminal e confirmar).
- Só uma execução por vez usa a pasta de estado (arquivo `.lock`); a segunda recebe uma mensagem clara.
- Todos os argumentos dos comandos impressos vão entre aspas, o log do cron respeita `--state-dir` e é criado com `umask 077`. O `schtasks` grava o caminho do Node atual: recrie a tarefa se atualizar/mover o Node.

### Workflow opcional do GitHub Actions

`templates/github-actions/render-svg.yml` regera o `metrics.svg` quando o `metrics.json` muda (permissões mínimas `contents: write`, ações fixadas por SHA de commit; `branches` tem de ser igual à `branch` do seu `config.json`). É **opcional**: o `publish` já envia o SVG pronto. Ele depende de o pacote estar publicado no npm e não foi testado em um GitHub real; leia os TODOs no topo do arquivo.

## Privacidade e limitações

Resumo (detalhes em `SECURITY.md`):

- Lê só campos estruturais (datas, contagens, tokens, nome da última pasta do projeto). O texto das conversas é descartado.
- **O histórico de um repositório público é permanente.** Se algo sensível for enviado, apagar o arquivo depois não remove o histórico (clones e forks já podem tê-lo). Por isso o `publish` é dry-run por padrão: confira antes.
- Datas, quantidades e a ordem do ranking são públicos, mesmo de projetos anonimizados. Um nome de projeto público é o que você escreveu na configuração.
- **Dados autodeclarados**: qualquer um pode editar o JSON do próprio repositório; o painel não prova nada para terceiros.
- **Formatos mudam**: Claude Code, Cline e Codex/ChatGPT desktop não documentam seus arquivos locais. Uma atualização pode quebrar um adaptador ou subcontar (a Claude Code, por exemplo, apaga sessões antigas por idade). Os números são aproximados.
- ChatGPT: só conversas que o app desktop sincronizou, e só a contagem por dia (sem mensagens nem tokens).
- A política de host do remoto é léxica (olha o texto do nome; um domínio que resolva para 127.0.0.1 passa). Um clone nosso recriado pode deixar commits locais não enviados só na cópia `repo.velho-*`. O envio agendado falha, sem mexer em nada, enquanto existir no state-dir uma pasta `repo` que não foi criada pela ferramenta (renomeie-a para seguir).
- Só foi testado no Windows.

## Adicionar uma fonte

1. Crie `src/adapters/minha-fonte.mjs` exportando um `Adapter` (contrato em `src/types.mjs`): `id` (minúsculas, números e hífen), `name`, `capabilities`, `available(ctx)` e `events(ctx)` (gerador assíncrono de eventos `{tool, project, session, ts, kind, tokens?}`).
2. Registre em `src/adapters/index.mjs` (é o registro que o `publish` usa para aceitar o `id` e o `name` da ferramenta).
3. Teste com fixture **sintética** em `test/` (veja `test/fixtures.mjs`). Nunca use conversas reais.
4. Documente o formato em `docs/fontes-de-dados.md`.

Regra: o adaptador lê só campos estruturais e descarta qualquer texto. Veja também `docs/esquema.md`.

## Desenvolvimento

```bash
npm test        # node:test, fixtures sintéticas, repositório git bare local como remoto
npm run lint    # checagem de sintaxe (node --check), sem dependências
npm run exemplo # regera examples/ (JSON e SVG sintéticos)
```

## Pendências antes de publicar

- **Licença**: MIT (arquivo `LICENSE` e campo `license` do `package.json`).
- **Repositório no GitHub**: `repository`, `bugs` e `homepage` do `package.json` já apontam para `github.com/brenoluizdev/ai-usage-metrics`, e esse repositório foi criado **vazio** no GitHub: ainda não houve nenhum push (decida antes o que fazer com o histórico antigo, que tem o e-mail pessoal do autor).
- **Publicação**: `npm pack --dry-run` para conferir os arquivos, 2FA na conta npm e `npm publish --provenance` (a proveniência só funciona a partir de um CI suportado, como o GitHub Actions); veja `SECURITY.md`.
- **Nome do pacote** no npm: `ai-usage-metrics` estava livre em 2026-11-15 (confira de novo ao publicar). Remover `"private": true` do `package.json` só por último.
- Idioma da documentação: só em português do Brasil por enquanto.
