# Assistente de configuração (`setup`)

`ai-usage-metrics setup` guia, num terminal interativo, do zero até o primeiro painel publicado e o agendamento diário. O `init` por flags continua existindo para automação.

```
npx ai-usage-metrics setup [--state-dir <pasta>] [--config <arquivo>] [--home <pasta>]
```

`--home` serve para testes (de onde ler as fontes). Não há opção que pule as confirmações.

## Regras gerais

- Sem terminal ou com `--non-interactive`: não faz nada e orienta o `init`.
- Perguntas com `[s/N]`: Enter vale "não". Menus são numerados; Enter escolhe o padrão mostrado entre colchetes.
- Respostas acima de 200 caracteres são recusadas; três respostas inválidas seguidas encerram o assistente sem gravar nada.
- Ctrl+C ou Ctrl+D encerram com a mensagem "Assistente encerrado". Nada fica pela metade.
- Cores ANSI só em terminal e sem `NO_COLOR`.

## O fluxo

1. **Boas-vindas**: o que é publicado, o que o assistente vai pedir e que dá para refazer.
2. **Fontes**: a mesma detecção do `sources`, com a contagem de sessões. Sem nenhuma fonte, pergunta se quer continuar.
3. **Identidade no GitHub**
   - com consentimento, `gh api user` (login e ID); o assistente nunca lê token;
   - senão pergunta o usuário e, com consentimento, faz um GET em `https://api.github.com/users/<usuário>` para obter o ID;
   - se recusar, peça o ID à mão (inteiro) ou siga sem ID, com o aviso de que em contas novas o noreply sem ID pode não vincular os commits ao perfil.
   - Resultado: `commitName = usuário` e `commitEmail = ID+usuário@users.noreply.github.com`. Outro e-mail **não é gravado**: edite `commitEmail` à mão (o `publish` avisa e exige confirmação extra).
4. **Repositório de dados** (padrão `ai-metrics`): verifica se existe (`gh repo view` ou GET `/repos/<usuário>/<repo>`, cada um com consentimento). Público: ok. Privado: avisa que a imagem não aparecerá no README para os outros. Inexistente: com `gh` oferece criá-lo (**público e vazio**; só depois do resumo); sem `gh` mostra o passo manual.
5. **Projetos com nome público**: lista até 15 pastas detectadas (nomes reais, só no terminal), pergunta quais podem aparecer com nome e o alias de cada, com o aviso de que nome público é permanente no histórico do GitHub. Padrão: nenhum.
6. **Modelo e cores**: descreve os 3 modelos, gera prévias dos SVGs com os seus dados em `<state-dir>/out/preview/` (no Windows oferece abri-las no navegador) e repete até você aprovar. Paletas prontas (GitHub padrão, Dracula, Nord, Solarized) ou personalizar destaque e fundos em hexadecimal. Depois: idioma, tema e título. O `model-2` pede `width="420"` no README do perfil.
7. **Histórico (computador novo)**: se o repositório já existe (ou é um remoto próprio da configuração), pergunta se este é um computador novo e oferece o `restore` (rede, git; executado depois do resumo). É o `restore` que **mescla pelo máximo**: com um `history.json` local já existente ele nunca o reduz, mostra a comparação local/restaurado/resultado e só então grava.
8. **Agendamento**: horário (padrão 12:00) e `autoPublish`. No Windows cria a tarefa `ai-usage-metrics` pelo `schtasks` (com consentimento); se já existir, pergunta se substitui e reconfirma antes de agir. Em Linux/macOS só **imprime** a linha de `cron`, que o autor não validou.
9. **Resumo**: mostra tudo (sem segredos) e pede confirmação. Só então grava o `config.json` (atômico, com cópia `.bak` se já existia) e executa as ações marcadas, nesta ordem: criar repositório, restore, instalar a cópia fixa, criar a tarefa.
10. **Primeira publicação**: `export`, `render` e o dry-run real do `publish`; o `publish` manual pergunta `[s/N]`. A **guarda de regressão de histórico** do `publish` vale integralmente: se o dry-run mostrar `ATENÇÃO: PERDA DE HISTÓRICO`, o fluxo normal pede a frase exata `publicar com perda de histórico`; o assistente nunca passa `--yes` nem `--accept-history-loss` e nunca digita a frase por você (sem a frase, nada é enviado). Com "s" envia e registra a aprovação do envio automático (estamos num terminal interativo). Com "n" explica como aprovar depois (`publish` num terminal).
11. **Fim**: URLs dos 4 SVGs, trecho de Markdown pronto para o perfil, como refazer, como mudar cores/modelo à mão e como remover a tarefa.

Os passos pulados na reexecução rápida não deixam buracos na numeração mostrada na tela.

## Reexecução

Se já existe `config.json`, o assistente mostra a configuração atual e oferece: rever tudo (cada pergunta usa o valor atual como padrão), só mudar modelo e cores, ou sair. Chaves que ele não pergunta (`history`, `branch`, `remoteUrl`) são preservadas (a tela diz, em uma frase, que o histórico é preservado e que `ai-usage-metrics history reset` recomeça do zero por conta própria; o assistente não automatiza isso); um `commitEmail` que não seja noreply também. A configuração anterior vira `config.json.bak`.

## Decisões

- **Instalação instável (`npx`).** O assistente considera instável um caminho de pacote que contenha uma pasta `_npx`, `dlx`, `.bun`/`.bunx` ou `bunx-*`, ou que esteja dentro da pasta temporária do sistema (a comparação usa também o `realpath` nativo dos dois lados, o que cobre nomes 8.3 como `RUNNER~1`). Uma tarefa apontando para lá quebraria quando o cache fosse limpo. Nesse caso (Windows) oferece `npm install --prefix ~/.ai-usage-metrics-runtime ai-usage-metrics@<versão atual> --registry https://registry.npmjs.org/ --ignore-scripts` (rede) e agenda a partir de `~/.ai-usage-metrics-runtime/node_modules/ai-usage-metrics/bin/ai-usage-metrics.mjs`. **A confirmação explica:** esse código será executado todo dia pelo Agendador, com os seus privilégios; o npm filho lê o seu `~/.npmrc` (as credenciais de lá), mesmo que `NPM_TOKEN` não seja repassado; não há integridade fixada além do registro e do publicador; e a pasta da cópia é código alterável por qualquer processo do seu usuário. Sem a cópia fixa, a tarefa não é criada. O `npm` é executado como `node <npm-cli.js do próprio Node>`, sem shell. Também há um **aviso** quando o Node em uso parece vir de um gerenciador de versões (nvm, fnm, volta, asdf, pasta de versão): o `schtasks` grava o caminho do Node.
- **Criação da tarefa.** O comando é o mesmo que o `init` imprime (`run --non-interactive`, argumentos entre aspas, validação que recusa `"` e `& | < > ^ % !`), enviado ao `schtasks /Create /SC DAILY /ST HH:MM /TN ai-usage-metrics /TR <comando>` por `execFile` (e `/F` só quando você aceitou substituir). `--state-dir`, `--config` e `--home` informados ao `setup` vão para o comando da tarefa. **O `schtasks` limita o `/TR` a 261 caracteres** (descoberto no teste real): acima disso o assistente recusa e orienta a usar caminhos mais curtos.
- **Consentimento da rede.** Cada consulta externa tem a sua pergunta própria; recusar não bloqueia nada, apenas leva ao caminho manual equivalente. O `gh` é opcional. A consulta à API pública deixa o seu IP visível ao GitHub (a pergunta diz isso); ela usa o ambiente do próprio Node (proxy só com `NODE_USE_ENV_PROXY=1`) e tem prazo total de 15 s. `NODE_EXTRA_CA_CERTS` está na allowlist dos processos filhos e vale para a API e para o registro do npm (quem controla essa CA consegue interceptar o tráfego); `NODE_OPTIONS` e `NPM_CONFIG_*` não passam.
- **Ctrl+C durante uma ação externa** (`npm install`, `gh repo create`, `schtasks`) aborta o processo filho, não executa as ações seguintes e diz o que já foi feito e o que não foi. O `git` do `restore` não é abortável no meio: o cancelamento vale quando ele termina.
- **Substituir uma tarefa existente:** a tela mostra o que ela executa hoje (`schtasks /Query /FO LIST /V`, sanitizado) e a reconfirmação acontece **antes** de a pasta de estado ser travada, para o `run` agendado não falhar esperando uma resposta.
- **Cópias da configuração:** `config.json.bak`, `.bak.1`, `.bak.2`... (nunca sobrescreve; ficam as 5 mais recentes); destinos que sejam links simbólicos são recusados, nas cópias e nas prévias.
- **Prévias com dados reais, só locais.** São geradas sem a mescla do histórico e nunca saem da pasta `out/preview/`.
- **Sem token.** O `gh` usa o login dele; `GH_TOKEN`/`GITHUB_TOKEN` não são repassados ao processo.

Modelo de segurança completo: [`SECURITY.md`](../SECURITY.md).
