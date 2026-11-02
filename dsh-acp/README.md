# dsh-acp-mcp

Ponte MCP entre Claude Code e o **DeepSeek Harness** oficial, usando o ACP
(`dsh --profile acp`) — sem HTTP, sem cookie, sem token.

## Tools

| Tool | O que faz |
|---|---|
| `deepseek_start(prompt, cwd?, mode?, reasoning_effort?, wait?, wait_seconds?)` | cria **uma** sessão e volta em ~3s com `session_id` (`status: running`) |
| `deepseek_start_many(tasks[])` | cria **N sessões em paralelo** numa chamada (máx. 8) e devolve os `session_ids` |
| `deepseek_resume(dsh_session_id, prompt, cwd?, ...)` | reata a uma sessão persistida por UUID após restart/crash e manda um prompt |
| `deepseek_send(session_id, message, wait?, wait_seconds?)` | dispara follow-up e volta; retorna `busy` se o turno anterior ainda roda |
| `deepseek_wait(session_id, wait_seconds?)` | **bloqueia até uma sessão terminar** (default 1h, máx. 6h) e devolve o resultado |
| `deepseek_wait_all(session_ids[], wait_seconds?)` | espera **todas** em paralelo; tempo = o da mais lenta, não a soma |
| `deepseek_status(session_id, wait_seconds?)` | **compacto**: estado, tempo, última tool, usage e preview de ~400 chars (inclusive parcial) |
| `deepseek_result(session_id, max_chars?)` | puxa o output acumulado **uma vez** (default 20k chars), inclusive parcial durante o turno ou após erro |
| `deepseek_cancel(session_id, wait_seconds?)` | interrompe o turno em voo (mesmo com a espera estourada) e devolve o output parcial; default aguarda 30s |
| `deepseek_close(session_id)` | encerra o processo e esquece a sessão; devolve o output parcial e libera RAM |
| `deepseek_list()` | lista as sessões abertas |

## Custo no Claude

- O trabalho do DeepSeek (ler arquivos, rodar tools, pensar) **não** entra no contexto do Claude.
- `deepseek_status` é compacto: enquanto roda não devolve output; ao terminar, só ~400 chars de preview.
- `deepseek_result` puxa o texto completo **uma vez**.
- Fluxo normal: `deepseek_start` (rápido, devolve `session_id`) + `deepseek_wait` (bloqueia). A partir de 8s o Claude Code põe a espera em background e notifica o Claude no fim — sem polling nem vigia.
- Vários agentes: `deepseek_start_many` + `deepseek_wait_all`. **Nunca intercale** `start`/`wait` — esperar o A antes de iniciar o B serializa tudo.
- Chamada interrompida **não** cancela o turno do DeepSeek: recupere com `deepseek_list` + `deepseek_wait`.
- Se `deepseek_wait` devolver `status: "running"` (espera estourada), o turno **continua vivo**: chame de novo uma vez com `wait_seconds` grande. Isso não é erro e não libera a sessão para um novo prompt.
- `deepseek_cancel` interrompe o turno de verdade, espera o agente parar e devolve o relatório parcial; use-o antes de desistir de uma tarefa longa.

## Retomar após restart/crash

`session_id` (`sN`) é um alias em memória. O UUID `dsh_session_id` é durável e
sobrevive ao restart do shim/PC:

```json
deepseek_resume(dsh_session_id="<uuid>", prompt="Continue de onde parou", cwd="<cwd original>")
```

O `cwd` precisa ser o mesmo da sessão original. O histórico e os arquivos
voltam; jobs e tool calls que estavam em voo não voltam — o agente pode precisar
refazer o passo interrompido. Depois de retomar, use `deepseek_wait` normalmente.

## Modos

- `workspace-write` (default): processo ACP com `DSH_PERMISSION_MODE=workspace-write`;
  o sandbox do DSH limita escritas ao `cwd` (raiz do projeto) e o shim aceita `allow-once`.
- `read-only`: só quando pedido explicitamente em `deepseek_start`;
  **toda** permissão é rejeitada. Leitura funciona; Write/Edit/Bash que muta é negado.

## Modelo / provider

`acp-overlay.yml` replica a rota do perfil `headless`: provider
`deepseek-official`, `baseURL https://opencode.ai/zen/go/v1` (OpenCode **Go**),
`apiKeyEnv OPENCODE_GO_API_KEY` — a chave vem de `~/.dsh/.credentials.yaml`,
nunca deste diretório. Modelo **fixo**: `deepseek-v4.1-flash` (não há v4-pro).
`reasoning_effort`: `off` / `low` / `high` / `max` (default).

## Claude Code Desktop (Code tab)

O container `claude` não tem `node`; por isso o shim pode trazer um **Node 24
estático** em `node/` e o registro MCP usa o caminho absoluto desse binário.
O shim también prepende esse bin ao `PATH` do filho `dsh` (o shebang `env node`
funciona). Se o seu container já tem Node 22+, use o `node` do sistema.

O Code tab lê o mesmo `~/.claude.json` do CLI (home compartilhado), então a
entrada `local` do projeto vale para os dois. Basta abrir uma **sessão nova** no
projeto; se não aparecer, reinicie o app. O chat do Desktop é outro mecanismo
(`claude_desktop_config.json`/connectors) e não recebe estas tools.

## Chave DeepSeek (web_search)

O `web_search` do agente usa `DEEPSEEK_API_KEY` — chave da **plataforma
DeepSeek** (platform.deepseek.com), separada da `OPENCODE_GO_API_KEY`. O
`web_fetch` (URLs/DOIs) funciona sem ela.

Crie `~/.local/share/dsh-acp-mcp/.env` (modo 600, fora do repo):

```
DEEPSEEK_API_KEY=sk-...
```

O shim carrega esse arquivo no startup; depois reinicie a sessão ou rode
`/mcp reconnect dsh-acp`.

## Config

- `DSH_ACP_WORKSPACE`: raiz permitida (default: `~/Projects/chorinho-dataset`).
- `DSH_BIN`: caminho do binário `dsh` (senão procura em `~/.local/bin` e no
  cache do `npx`; último recurso `npx -y @deepseek-ai/dsh@0.2.1-rc.2`).
- `DSH_ACP_DEBUG=1`: log em stderr.

Registrado no Claude Code com escopo `local` (só neste projeto, em
`~/.claude.json`; nada no repo):

```bash
claude mcp get dsh-acp
claude mcp remove dsh-acp -s local
```
