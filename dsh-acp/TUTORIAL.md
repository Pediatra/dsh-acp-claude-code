# dsh-acp + Claude Code

Claude Code (Opus) chamando agentes do **DeepSeek Harness** (DSH) por MCP.
Sem HTTP, sem cookie, sem token: o Claude fala MCP stdio com este shim, e o shim
fala ACP com o DSH.

```
Claude Code (Opus)
   └─ MCP stdio ──> dsh-acp-mcp (server.mjs)
                       └─ ACP stdio ──> dsh --profile acp
                                           └─ DeepSeek (OpenCode Go ou API oficial)
```

O trabalho do DeepSeek (ler arquivos, rodar tools, buscar) **não entra** no
contexto do Claude. O Claude só recebe o status e o resultado final.

---

## Pré-requisitos

- **Node 20+** (recomendado 24 LTS). `node -v`
- **Claude Code 2.1+** com MCP. `claude mcp --help`
- **DeepSeek Harness 0.2.x**:
  ```bash
  npm i -g @deepseek-ai/dsh
  dsh --version
  ```
  (ou use `npx @deepseek-ai/dsh`; o shim também acha no cache do npx)
- Um provider configurado:
  - **OpenCode Go**: chave `OPENCODE_GO_API_KEY` e baseURL `https://opencode.ai/zen/go/v1`
  - **DeepSeek oficial**: chave `DEEPSEEK_API_KEY` e baseURL `https://api.deepseek.com/anthropic`
- Opcional, só para `web_search`: uma chave da **platform.deepseek.com**
  (US$ 2 cobrem muita busca). `web_fetch` (abrir DOI/URL) não precisa.
- A pasta `dsh-acp-mcp` (este diretório) com `server.mjs` e `acp-overlay.yml`.
  Não contém segredo nenhum.

---

## 1. Provider do DSH

O perfil `acp` que vem no DSH **não** traz rota de modelo; por isso existe o
`acp-overlay.yml`. Ele precisa combinar com o seu provider.

### OpenCode Go

```yaml
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    apiKeyEnv: OPENCODE_GO_API_KEY
    baseURL: https://opencode.ai/zen/go/v1
    models:
      - id: deepseek-v4.1-flash
        name: DeepSeek V4.1 Flash
        contextWindow: 1000000
        systemPromptUpdate: in-history
        inputModalities: [text, image]
        imagePixelBudget: 640000
        imageMaxBytes: 1048576

- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-official
    model: deepseek-v4.1-flash
    reasoningEffort: max
```

A chave do Go fica em `~/.dsh/.credentials.yaml` (refs), normalmente gravada
pela página Models do `dsh web`. Também pode vir de `OPENCODE_GO_API_KEY` no
ambiente.

### DeepSeek oficial

```yaml
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: https://api.deepseek.com/anthropic
    models:
      - id: deepseek-v4.1-flash   # use o id exato do seu provider
        name: DeepSeek V4.1 Flash
        contextWindow: 1000000

- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-official
    model: deepseek-v4.1-flash
    reasoningEffort: max
```

Para a chave, crie `~/.local/share/dsh-acp-mcp/.env` com modo 600:

```bash
bash -c 'read -rsp "DeepSeek API key: " K; echo; printf "DEEPSEEK_API_KEY=%s\n" "$K" > ~/.local/share/dsh-acp-mcp/.env; chmod 600 ~/.local/share/dsh-acp-mcp/.env; unset K'
```

O shim carrega esse `.env` no startup. **Nunca** coloque a chave no repo.

---

## 2. Instalar o shim

Copie a pasta para um caminho estável:

```bash
mkdir -p ~/.local/share/dsh-acp-mcp
# copie server.mjs, acp-overlay.yml e README.md para cá
```

Se o `dsh` **não** estiver em `~/.local/bin` nem no cache do npx, informe o
caminho no registro do MCP:

```bash
DSH_BIN=/usr/local/bin/dsh
```

O shim também usa o Node que o executa e prepende o diretório dele ao `PATH`
do processo `dsh` — importante em containers sem `node`.

---

## 3. Registrar no Claude Code

Escopo **local** (só neste projeto, sem tocar no repo):

```bash
cd /caminho/do/projeto

claude mcp add dsh-acp --scope local \
  -e DSH_ACP_WORKSPACE=/caminho/do/projeto \
  -- node /home/SEU_USUARIO/.local/share/dsh-acp-mcp/server.mjs
```

Confira:

```bash
claude mcp get dsh-acp
# Status: ✔ Connected
```

No **Claude Desktop (Code tab)**, o mesmo `~/.claude.json` vale. Depois de
registrar, reinicie o app ou abra uma **sessão nova** — o CLI é iniciado por
sessão e só lê o MCP no start. Em sessão já aberta, `/mcp reconnect dsh-acp`.

### Desktop em distrobox/container sem Node

Use um Node estático só para o shim e registre o caminho absoluto:

```bash
# exemplo: Node 24 linux-x64
mkdir -p ~/.local/share/dsh-acp-mcp/node
curl -fsSL https://nodejs.org/dist/latest-v24.x/node-v24.22.1-linux-x64.tar.xz \
  | tar -xJ -C ~/.local/share/dsh-acp-mcp/node --strip-components=1
```

```bash
claude mcp add dsh-acp --scope local \
  -e DSH_ACP_WORKSPACE=/caminho/do/projeto \
  -- /home/SEU_USUARIO/.local/share/dsh-acp-mcp/node/bin/node \
     /home/SEU_USUARIO/.local/share/dsh-acp-mcp/server.mjs
```

---

## 4. Usar

| Tool | O que faz |
|---|---|
| `deepseek_start(prompt, cwd?, mode?, reasoning_effort?, wait?, wait_seconds?)` | cria **uma** sessão e volta em ~3s com `session_id` (`status: running`) |
| `deepseek_start_many(tasks[])` | cria **N sessões em paralelo** numa única chamada (máx. 8) e devolve os `session_ids` |
| `deepseek_send(session_id, message, wait?, wait_seconds?)` | dispara follow-up e volta; retorna `busy` se o turno anterior ainda roda |
| `deepseek_wait(session_id, wait_seconds?)` | **bloqueia até uma sessão terminar** (default 1h, máx. 6h) e devolve o resultado |
| `deepseek_wait_all(session_ids[], wait_seconds?)` | espera **todas** em paralelo; tempo total = o da mais lenta, não a soma |
| `deepseek_status(session_id, wait_seconds?)` | **compacto**: estado, tempo, última tool, usage + preview de 400 chars (default sem espera, inclusive parcial) |
| `deepseek_result(session_id, max_chars?)` | output acumulado, uma vez — inclusive parcial durante o turno ou após erro |
| `deepseek_cancel(session_id, wait_seconds?)` | interrompe o turno em voo (mesmo com espera estourada), aguarda até 30s e devolve o output parcial |
| `deepseek_close(session_id)` | encerra o processo e esquece a sessão; devolve o output parcial e libera RAM na hora |
| `deepseek_list()` | lista as sessões abertas |

**Modos:**

- `mode: "workspace-write"` (default): pode escrever, mas o sandbox do DSH
  limita ao `cwd`.
- `mode: "read-only"`: só leitura; qualquer permissão de escrita é rejeitada.

**Modelo:** fixo `deepseek-v4.1-flash`.
**Esforço:** `off` / `low` / `high` / `max` (default `max`).

### Subagentes Gemini (agy) dentro do DSH

O DSH também pode delegar para o **Antigravity CLI** (`agy`, Gemini 3.8 Flash):
o overlay registra o `agy-mcp` como MCP server do DSH, e as tools aparecem para
o DeepSeek como `mcp__agy__agy_start`, `mcp__agy__agy_send`,
`mcp__agy__agy_status`, `mcp__agy__agy_result`, `mcp__agy__agy_cancel`,
`mcp__agy__agy_list`.

Assim a corrente fica: **Claude Code → dsh-acp → DeepSeek → agy (Gemini)**.

> Use o `dsh-acp` para pedir ao DeepSeek que chame o `mcp__agy__agy_start`
> em `read-only` e resuma o resultado. `wait: true`.

Detalhes:

- O `AGY_WORKSPACE` acompanha o `DSH_ACP_WORKSPACE` (ou o projeto padrão).
- Em sessão `read-only` do DSH, o `agy` roda **sempre** read-only: o shim recebe
  `AGY_ALLOW_WRITE=0` e rebaixa qualquer pedido de `workspace-write`
  (o payload volta com `mode: "read-only"` e `mode_note`). Não há como o
  DeepSeek escapar do confinamento delegando a escrita.
- Em `workspace-write`, o `agy` roda confinado por `bwrap` ao workspace.
- A UI web do DSH **não** recebeu essa rota: o modo por sessão da web não é
  exportado para o processo filho, então não daria para garantir o read-only.

### Exemplos de pedido ao Claude

Tarefa curta:

> Use o `dsh-acp` para ler `docs/arquitetura.md` e resumir em 5 linhas.
> `mode: read-only`; `deepseek_start` e `deepseek_wait` no mesmo turno.

Tarefa longa:

> Use o `dsh-acp` para analisar o arquivo X: `deepseek_start` e, no mesmo turno,
> `deepseek_wait`. Não faça polling nem vigia.

**Como o fim da sessão chega ao Claude:** em duas fases.

1. `deepseek_start` volta em ~3s com `session_id` (e o campo `next`).
2. `deepseek_wait` é a chamada que bloqueia até o turno acabar (default 1h,
   máx. 6h) e manda `notifications/progress` a cada ~20s.

No Claude Code, a partir de **8s** (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` em
`~/.claude/settings.json`) uma chamada pendente vira **background task**: o
Claude recebe o id, segue trabalhando e é acordado com o resultado quando ela
termina. A conversa não fica presa e não é preciso `deepseek_status` em loop
nem vigia em arquivo.

Se a chamada for interrompida (mensagem nova, Esc, `/tasks`), o turno do
DeepSeek **não** é cancelado: a sessão continua. Recupere com `deepseek_list`
e `deepseek_wait` — o `session_id` já foi entregue pelo `start`.

Se a janela de espera estourar (`status: "running"`), o turno **continua vivo**:
chame `deepseek_wait` **uma vez** com `wait_seconds` grande (ex.: 3600), nunca
de 30 em 30 segundos. A espera estourada não é erro, não fecha a sessão e não
libera a sessão para um novo prompt.

### Cancelar sem perder o relatório

`deepseek_cancel` manda o `session/cancel` do ACP para o turno que está
realmente em voo — inclusive depois de uma espera estourada. Ele aguarda o
agente parar (default 30s) e devolve o output acumulado até ali, marcado com
`cancelled`/`stop_reason: "cancelled"`. Se ainda vier `cancel_requested: true`,
não mande prompt novo: espere ou cancele de novo. Para ler o parcial a qualquer
momento, use `deepseek_result`; ele funciona com o turno em andamento.

### Vários agentes em paralelo

**Não intercale `start` e `wait`.** `start A → wait A → start B` faz o B só
existir depois que o A termina. Para rodar N agentes ao mesmo tempo:

1. `deepseek_start_many` com todas as tasks numa única chamada (máx. 8);
2. `deepseek_wait_all` com os `session_ids` retornados.

O tempo total é o da tarefa mais lenta, não a soma. Medido aqui: 3 agentes de
15/20/25s começaram em 3,8s e terminaram todos em 29,3s.

> Rode em paralelo 3 agentes: `deepseek_start_many` com as tasks X, Y e Z e
> depois `deepseek_wait_all`. Não use `deepseek_status` em loop.

Se preferir chamadas separadas, inicie **todos** primeiro e só então faça os
`wait` — mas o batch é o caminho garantido.

### Fechar sessões (memória)

Cada sessão é um processo DSH próprio (~100–250 MB). Use `deepseek_close`
quando terminar; sem isso, o shim fecha sozinho após **30 min ocioso**
(`DSH_ACP_IDLE_TTL_SECONDS`, default `1800`; `0` desliga). A sessão fechada é
esquecida — para continuar depois, abra uma nova com contexto novo.

Implementação:

> Use o `dsh-acp` (`workspace-write`) para implementar Y neste projeto,
> rodar os testes e me trazer o diff e o resumo.

### Economia de tokens do Claude

- Passe **caminhos**, não o conteúdo dos arquivos.
- `deepseek_status` é compacto; não devolve o output inteiro.
- `deepseek_result` puxa o texto completo **uma vez**.
- `deepseek_start` + `deepseek_wait` já devolvem o resultado do turno.
- Tarefa longa: o Claude Code faz background + notificação sozinho; não gaste
  turnos com polling.
- O trabalho do DeepSeek é gasto do Go/DeepSeek, não do Claude.

---

## 5. Troubleshooting

| Sintoma | Causa / solução |
|---|---|
| `ENOENT: node` | container sem Node → Node estático + caminho absoluto |
| `dsh: command not found` | instale global ou defina `DSH_BIN` no MCP |
| `no API key for provider route "deepseek-official"` | overlay com `apiKeyEnv` errado, ou chave fora do `.env`/credentials |
| `web_search` falha / sem chave | `DEEPSEEK_API_KEY` no `.env` (plataforma, não a do Go) |
| Tool não aparece em sessão antiga | feche/reabra a sessão; `/mcp reconnect dsh-acp` |
| `mcp__agy__*` não aparece no DSH | overlay sem a entrada `insert`/`mcp-agy`; confira com `--dump-config` e reinicie a sessão |
| `dsh acp exited` / métodos estranhos | DSH mudou de versão; o shim é acoplado à 0.2.x |
| Resultado vazio | veja `deepseek_status`; se `error`, leia a mensagem |

**Segurança:** o agente delegado tem as ferramentas do DSH. Em `read-only`,
toda permissão é rejeitada. Em `workspace-write`, o sandbox limita ao `cwd`,
mas ainda pode rodar Bash lá dentro. Aponte `DSH_ACP_WORKSPACE` só para o
projeto que você quer expor.

---

## 6. Notas

- O **ACP** é oficial do DeepSeek Harness; este shim MCP é um adaptador local
  não oficial (MIT), sem afiliação com Anthropic ou DeepSeek.
- DSH está em **developer preview**: breaking changes são esperados. O shim é
  acoplado à linha 0.2.x.
- Nada de chave/token no repo. O `.env` fica no diretório do shim, modo 600.
