# Modelos de SVG e cores

A ferramenta gera **3 modelos** de SVG a partir do mesmo JSON agregado. Todos são autocontidos (sem script, fonte, imagem nem link externo), têm tamanho fixo declarado em `width`/`height`/`viewBox`, escapam todo texto e seguem o tema (`auto`, `light` ou `dark`), o idioma (`en` ou `pt-BR`) e o título da configuração. Nada disso passa por servidor: os arquivos são gerados na sua máquina e enviados ao seu repositório de dados.

| Modelo | Tamanho | O que mostra |
|---|---|---|
| `model-1` (padrão) | 840 x 440 | cartões (sessões, mensagens, tokens, dias ativos), sessões por mês (últimos 6) por ferramenta e ranking de projetos |
| `model-2` | 420 x ~400 | cartão estreito: os 4 números, uma barra horizontal empilhada de sessões por ferramenta e a legenda com contagem e porcentagem |
| `model-3` | 807 x 262 | calendário de atividade (mapa de calor, estilo contribuições do GitHub) das últimas 53 semanas |

A altura do `model-2` depende só de quantas ferramentas têm sessões (até 8 linhas de legenda); é a mesma para os mesmos dados.

## Quais arquivos existem

O `publish` (e o `run`) envia, como arquivos planos na raiz do repositório de dados:

- `metrics.json`
- `metrics.svg`: o modelo escolhido em `model` na configuração (padrão `model-1`)
- `metrics.model-1.svg`, `metrics.model-2.svg`, `metrics.model-3.svg`: os três modelos, com as mesmas cores

Assim você escolhe o modelo só pela URL, sem rodar de novo:

```
https://raw.githubusercontent.com/<usuario>/ai-metrics/main/metrics.model-1.svg
https://raw.githubusercontent.com/<usuario>/ai-metrics/main/metrics.model-2.svg
https://raw.githubusercontent.com/<usuario>/ai-metrics/main/metrics.model-3.svg
```

Todos os SVGs são regerados a partir do JSON validado no momento do `publish` e passam pela barreira de privacidade antes de ir para o clone ou para a rede. Um SVG que esteja no disco nunca é enviado como está.

### Comando `render`

- `render` (sem `--out`): grava `metrics.svg` (modelo da configuração, ou `--model`) e os três `metrics.model-N.svg` em `<state-dir>/out`.
- `render --out arquivo.svg`: grava **só** aquele arquivo (um modelo). É o comportamento antigo e continua igual; serve, por exemplo, ao workflow opcional do GitHub Actions.
- `render --out-dir pasta`: grava o conjunto completo (`metrics.svg` e os três `metrics.model-N.svg`) nessa pasta.
- `--out` e `--out-dir` juntos são recusados.

## model-3: como o calendário é calculado

- Métrica: **`sessions`** da série diária (`timeline.points[].sessions`, dias em UTC). É o número de sessões com atividade naquele dia.
- Janela: 53 colunas (semanas, de domingo a sábado) que terminam na semana do **fim do período**: a data de geração (`generatedAt`, UTC) ou o último dia com dados, o que for mais recente. Linhas = dias da semana, domingo primeiro (rótulos em segunda, quarta e sexta). Dias depois do fim não são desenhados. Dados mais antigos que a janela não entram no desenho nem nos totais do cabeçalho.
- O cabeçalho mostra o total de sessões e de dias ativos **da janela**.
- **Níveis**: nível 0 = sem atividade. Os níveis 1 a 4 vêm dos quantis (posto mais próximo) das sessões dos **dias ativos** da janela: até o quartil 25% = nível 1; até a mediana = 2; até o quartil 75% = 3; acima disso = 4. Com valores repetidos alguns níveis podem não aparecer. Se todos os dias ativos têm o mesmo valor (ou há um dia só), todos ficam no nível 4. Série vazia: tudo nível 0.
- Período menor que 53 semanas: as colunas antes do primeiro dia com dados continuam no desenho, no nível 0.
- Cada célula tem um `<title>` com a data (`AAAA-MM-DD`) e a contagem (`3 sessions`), que o navegador mostra ao passar o mouse quando o SVG é aberto diretamente (o GitHub não mostra dicas dentro de `<img>`).
- As datas e contagens diárias já são públicas no `metrics.json`; o calendário não acrescenta informação nenhuma.

## Cores

Personalize **somente cores** (nada de fonte, tamanho, raio ou layout) na configuração `config.json`.

| Chave | O que pinta | Padrão claro | Padrão escuro |
|---|---|---|---|
| `background` | fundo do painel | `#ffffff` | `#0d1117` |
| `card` | fundo dos cartões de números | `#f6f8fa` | `#161b22` |
| `border` | bordas e linhas | `#d0d7de` | `#30363d` |
| `text` | título e números | `#1f2328` | `#e6edf3` |
| `muted` | textos secundários, rótulos | `#656d76` | `#8b949e` |
| `track` | fundo das barras (ranking e barra do model-2) | `#e6eaee` | `#21262d` |
| `accent` | barras do ranking de projetos (model-1) e base da escala de calor (model-3) | `#d97757` | `#d97757` |
| `tools` | mapa `idDaFerramenta -> cor` (gráfico mensal, barra e legendas). O id tem de existir (`claude-code`, `cline`, `chatgpt`) | laranja, verde e âmbar | idem |

A escala de calor do `model-3` **não tem chave própria**: os 5 níveis são derivados de `accent` e `background` (mistura de 10%, 32%, 55%, 78% e 100% do `accent` sobre o `background`, calculada na geração e sempre escrita em hexadecimal).

### Como `colors`, `colorsDark` e `theme` interagem

- `colors`: vale para o tema claro e, se `theme` for `auto` e **não** houver `colorsDark`, também para o escuro.
- `colorsDark`: mesmas chaves, vale só para o escuro (`prefers-color-scheme: dark` no `auto`, ou `theme: dark`).
- `theme: "light"`: só `colors` é usado (`colorsDark` é ignorado).
- `theme: "dark"`: usa `colorsDark`; se ele não existir, usa `colors`.
- Chaves não informadas ficam com o padrão do tema correspondente (as de `colors` nunca "vazam" para o conjunto escuro quando `colorsDark` existe).

### Validação (estrita)

Cada valor tem de ser **somente `#rgb` ou `#rrggbb`** (hexadecimal, maiúsculas ou minúsculas). Nomes de cor, `rgb()`, `hsl()`, `var()`, `url()`, `;`, `}`, `<`, comentários CSS, espaços, `!important`, valores vazios e tipos errados são **recusados** com mensagem clara. Chaves desconhecidas e ids de ferramenta inexistentes também. O valor é normalizado (`#ABC` vira `#aabbcc`) e só então entra no SVG. A validação roda na carga da configuração e **de novo** no renderizador.

### Legibilidade

Não há ajuste automático de contraste: **você é responsável por escolher cores legíveis** (texto contra fundo, barras contra a trilha, e os níveis do calendário entre si). Confira o resultado abrindo o SVG nos dois temas.

### Exemplos

Tema escuro personalizado (fundo roxo, destaque verde), válido para o `auto` e o `dark`:

```json
{
  "model": "model-3",
  "colors": { "accent": "#16a34a" },
  "colorsDark": {
    "background": "#1a1033",
    "card": "#241747",
    "border": "#3b2a6b",
    "text": "#f3e8ff",
    "muted": "#b9a7e0",
    "track": "#2e1f5c",
    "accent": "#22c55e",
    "tools": { "claude-code": "#a78bfa", "cline": "#22c55e", "chatgpt": "#f472b6" }
  }
}
```

Tema claro fixo, só com o destaque trocado:

```json
{ "theme": "light", "colors": { "accent": "#2563eb", "background": "#f8fafc" } }
```

Pela linha de comando, no `init`: `--model model-2 --colors '{"accent":"#22c55e"}' --colors-dark '{"background":"#1a1033"}'` (as cores só são gravadas se você as passar).

Para ver a aparência: `npm run exemplo` gera, em `examples/`, os três modelos nos dois temas com dados sintéticos (`metrics.example.model-N.<tema>.svg`).
