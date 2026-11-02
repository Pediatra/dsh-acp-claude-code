# dsh-acp-claude-code

Dois bridges MCP para o **Claude Code** orquestrar agentes externos:

```
Claude Code ──MCP──> dsh-acp ──ACP──> DeepSeek Harness (deepseek-v4.1-flash)
     │
     └────MCP──> agy-mcp ──stream-json──> agy / Gemini 3.8 Flash
```

- **`dsh-acp`** — expõe sessões do [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) via ACP oficial (`dsh --profile acp`), com sandbox de escrita do DSH.
- **`agy-mcp`** — expõe o [Antigravity CLI](https://antigravity.google/) (`agy`), com confinamento real por `bubblewrap`.

Os dois foram feitos para o mesmo padrão: o Claude dispara agentes, recebe
`session_id`, espera o resultado numa chamada longa (que o Claude Code põe em
background e notifica no fim) e fecha a sessão quando termina.

> Projeto independente, não oficial. `dsh-acp` é um adaptador local do ACP do
> DeepSeek; `agy-mcp` é um adaptador local do CLI do Google. Nenhum é afiliado à
> Anthropic, DeepSeek ou Google.

## Recursos

- **Paralelo de verdade:** `deepseek_start_many` / `agy_start_many` iniciam N
  sessões numa única chamada (até 8); `deepseek_wait_all` / `agy_wait_all`
  esperam todas ao mesmo tempo (tempo = a mais lenta, não a soma).
- **Sem polling:** a chamada de `wait` é o canal de aviso. O Claude Code
  auto-backgrounda após 8s e acorda o modelo quando o turno termina.
- **Turno longo não vira erro:** o `session/prompt` não tem timeout no cliente;
  a janela é só do `wait`. Estourou, a sessão continua `running` e o resultado
  atrasado ainda é capturado.
- **Interrupção não mata a sessão:** cancelar a tool call não cancela o turno
  do agente; dá para retomar com `list` + `wait`.
- **Cancelamento real:** `*_cancel` interrompe o turno em voo, espera o agente
  parar e devolve o output parcial, sem perder o relatório.
- **Read-only real:** `bwrap` monta `/` read-only e o workspace read-only; no
  DSH, toda permissão é rejeitada.
- **Limpeza:** `*_close` encerra na hora; TTL ocioso fecha sozinho após 30 min.

## Estrutura

```
dsh-acp/     # copie para ~/.local/share/dsh-acp-mcp/
  server.mjs
  acp-overlay.yml
  README.md
  TUTORIAL.md
agy-mcp/     # copie para ~/.local/share/agy-mcp/
  server.mjs
  README.md
```

## Requisitos

- Node.js **22.19+** (ou 24+) — no container sem Node, use um Node estático e
  aponte o registro do MCP para ele.
- `bubblewrap` (`/usr/bin/bwrap`) — obrigatório para o `read-only` do agy.
- **DSH 0.2.x** (`npm i -g @deepseek-ai/dsh@0.2.1-rc.5` ou via `npx`) para o `dsh-acp`.
- **agy 1.4.x** (`~/.local/bin/agy`) autenticado para o `agy-mcp`.
- Claude Code 2.1.2xx+ (Desktop Code tab ou CLI).

## Instalação

```bash
git clone git@github.com:Pediatra/dsh-acp-claude-code.git
cd dsh-acp-claude-code

mkdir -p ~/.local/share/dsh-acp-mcp ~/.local/share/agy-mcp
cp -r dsh-acp/* ~/.local/share/dsh-acp-mcp/
cp -r agy-mcp/* ~/.local/share/agy-mcp/
```

### Registrar no Claude Code

```bash
cd /caminho/do/projeto

claude mcp add dsh-acp --scope local \
  -e DSH_ACP_WORKSPACE="$PWD" \
  -- node "$HOME/.local/share/dsh-acp-mcp/server.mjs"

claude mcp add agy-gemini --scope local \
  -e AGY_WORKSPACE="$PWD" \
  -- node "$HOME/.local/share/agy-mcp/server.mjs"

claude mcp list   # os dois devem aparecer "Connected"
```

No **Claude Desktop (Code tab)**, abra uma sessão nova (ou reinicie o app). Em
sessão aberta, `/mcp reconnect <nome>`; no Desktop o reconnect pode estar
desabilitado — nesse caso, só sessão nova.

### Timeouts e background

No `~/.claude.json`, dentro da entrada de cada servidor:

```json
"dsh-acp":    { "...": "...", "timeout": 22200000 },
"agy-gemini": { "...": "...", "timeout": 3660000 }
```

E em `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS": "8000" } }
```

Sem isso, a espera longa pode ser cortada pelo timeout padrão do servidor ou
segurar a conversa por mais tempo.

### Segredos

- `dsh-acp/.env` (opcional, modo 600) só para `DEEPSEEK_API_KEY` do
  `web_search` da plataforma DeepSeek. **Não** é a chave do provider.
- A chave do provider (OpenCode Go ou DeepSeek oficial) fica em
  `~/.dsh/.credentials.yaml` ou no ambiente (`OPENCODE_GO_API_KEY`).
- O repositório **não** inclui `.env`, `node/` nem credenciais.

## Tools

### `dsh-acp`

| Tool | O que faz |
|---|---|
| `deepseek_start(prompt, cwd?, mode?, reasoning_effort?, wait?, wait_seconds?)` | cria uma sessão e volta em ~3s com `session_id` |
| `deepseek_start_many(tasks[])` | inicia N sessões em paralelo (máx. 8) |
| `deepseek_send(session_id, message, ...)` | follow-up na mesma sessão |
| `deepseek_wait(session_id, wait_seconds?)` | bloqueia até uma sessão terminar (default 1h) |
| `deepseek_wait_all(session_ids[], wait_seconds?)` | espera todas em paralelo |
| `deepseek_status` / `deepseek_result` | status compacto / output acumulado (inclusive parcial) |
| `deepseek_cancel` / `deepseek_close` | cancela o turno com relatório parcial / encerra e devolve o parcial |
| `deepseek_list` | sessões abertas |

### `agy-mcp`

| Tool | O que faz |
|---|---|
| `agy_start(prompt, cwd?, mode?, model?, effort?, wait?, wait_seconds?)` | cria uma sessão e volta rápido |
| `agy_start_many(tasks[])` | inicia N sessões em paralelo (máx. 8) |
| `agy_send(session_id, message, ...)` | follow-up; respawna se a sessão foi fechada por TTL |
| `agy_wait(session_id, wait_seconds?)` | bloqueia até uma sessão terminar (default 10 min) |
| `agy_wait_all(session_ids[], wait_seconds?)` | espera todas em paralelo |
| `agy_status` / `agy_result` | status compacto / output completo |
| `agy_cancel` / `agy_close` | cancela / encerra e esquece |
| `agy_list` | sessões abertas |

Modelos do agy: `gemini-4-argon-low|medium|high` e
`gemini-3.8-flash-low|medium|high` (default `gemini-3.8-flash-high`);
esforço `low|medium|high|xhigh|max` (default `high`). Veja a lista da sua conta
com `agy models`.

## Como usar

Um agente:

> Use o `dsh-acp` para ler `README.md` e resumir em 5 linhas. `mode: read-only`.

Vários em paralelo:

> Rode 3 agentes em paralelo com `deepseek_start_many` (tasks A, B, C) e depois
> `deepseek_wait_all`. Não use polling.

Regra de ouro: **não intercale `start` e `wait`**. `start A → wait A → start B`
faz o B só existir depois que o A termina. Inicie todos primeiro (ou use o
batch) e só então espere.

## Modos e segurança

- **DSH `read-only`:** o processo ACP roda com `DSH_PERMISSION_MODE=read-only` e
  rejeita toda permissão. **`workspace-write`:** o sandbox do DSH limita
  escritas ao `cwd`; Bash roda dentro do projeto.
- **agy `read-only`:** `bwrap` com `/` read-only, workspace read-only e só
  `~/.gemini`, `~/.cache` e `/tmp` graváveis. **`workspace-write`:** workspace
  gravável + `--dangerously-skip-permissions`; o resto do FS continua read-only.
- Em sessão `read-only` do DSH, o `AGY_ALLOW_WRITE=0` impede o DeepSeek de
  escapar delegando escrita ao agy.
- Isto é um harness de agente: ele executa comandos como o seu usuário. Aponte
  `DSH_ACP_WORKSPACE` / `AGY_WORKSPACE` só para o projeto e revise permissões.

## Limitações

- DSH está em **developer preview**: mudanças que quebram compatibilidade são
  esperadas. `dsh-acp` é acoplado à linha 0.2.x e ao ACP oficial.
- O `agy` é um CLI em evolução; o protocolo `stream-json` pode mudar.
- Não há autenticação própria: os shims usam o login/CLI já configurado na
  máquina.

## Licença

MIT — veja [LICENSE](LICENSE).
