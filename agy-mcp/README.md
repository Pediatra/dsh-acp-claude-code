# agy-mcp

Ponte MCP entre o **Claude Code** e o **Antigravity CLI** (`agy`), nos mesmos
moldes do `dsh-acp`: `agy_start` / `agy_send` / `agy_status` / `agy_result` /
`agy_cancel` / `agy_list`.

Modelo padrão: **Gemini 3.8 Flash (High)**. Sem API key: usa o login do `agy`.

## Requisitos

- Node 20+ (no Desktop sem Node, use o Node estático do `dsh-acp-mcp`).
- `agy` 1.4.x (`~/.local/bin/agy` ou `AGY_BIN`).
- `bwrap` (bubblewrap) em `/usr/bin/bwrap` — obrigatório para `read-only`.
- `AGY_WORKSPACE` apontando para a raiz permitida.

## Registrar

```bash
cd /caminho/do/projeto

claude mcp add agy-gemini --scope local \
  -e AGY_WORKSPACE=/caminho/do/projeto \
  -- /var/home/USER/.local/share/dsh-acp-mcp/node/bin/node \
     /var/home/USER/.local/share/agy-mcp/server.mjs

claude mcp get agy-gemini   # Connected
```

No Desktop, reinicie o app ou abra uma sessão nova; em sessão aberta:
`/mcp reconnect agy-gemini`.

## Tools

| Tool | O que faz |
|---|---|
| `agy_start(prompt, cwd?, mode?, model?, effort?, profile?, verify_command?, wait?, wait_seconds?)` | abre **uma** sessão e volta rápido com `session_id` |
| `agy_start_many(tasks[])` | abre **N sessões em paralelo** numa chamada (máx. 12), cada task pode ter `profile` |
| `agy_resume(conversation_id, prompt, ...)` | reata a uma conversa persistida por UUID após restart/crash |
| `agy_send(session_id, message, wait?, wait_seconds?)` | follow-up; respawna a sessão se ela foi fechada por TTL |
| `agy_wait(session_id, wait_seconds?)` | bloqueia até o turno terminar (default 10 min, máx. 1h) |
| `agy_wait_all(session_ids[], wait_seconds?, full?)` | espera todas em paralelo; compacto por padrão (`full=true` traz o texto) |
| `agy_status(session_id, wait_seconds?)` | compacto: estado, tempo, última tool, usage, denied; preview de 400 chars |
| `agy_result(session_id, max_chars?)` | output completo do último turno, uma vez |
| `agy_verify(session_id, command, retries?, ...)` | roda o teste, devolve o exit code e reenvia o erro ao agente |
| `agy_cancel(session_id)` | mata o processo e devolve o output parcial; a conversa continua resumível |
| `agy_close(session_id)` | encerra, devolve o output parcial e esquece a sessão (libera RAM na hora) |
| `agy_list()` | sessões vivas **deste processo** |
| `agy_conversations(cwd?, limit?)` | conversas persistidas no disco (sobrevivem ao restart) |

## Paralelismo e TTL

- Para vários agentes: `agy_start_many` → `agy_wait_all`. **Não intercale**
  `start`/`wait`; esperar o primeiro antes de iniciar o segundo serializa tudo.
- Cada sessão é um processo `bwrap + agy` (~100–400 MB). Sessão ociosa fecha
  sozinha após **30 min** (`AGY_IDLE_TTL_SECONDS`, default `1800`; `0` desliga).
  Um `agy_send` depois respawna com `--conversation` e mantém o contexto.
- `agy_close` encerra e **esquece** a sessão; para continuar, abra outra.

## Espera, perfil, log e verificação

Para não segurar o turno do Claude, rode a espera em background:

```bash
agy-wait <conversation_id> [<outro-id> ...] --timeout 21600
```

O shim grava `~/.local/state/agy-mcp/sessions/<uuid>.json` e `.out.txt`; o
`agy-wait` usa `fs.watch` e imprime o resultado no fim.

`profile` aceita `instructions`, `writable_dirs`, `forbidden_paths` e `silent`.
No agy, pastas graváveis viram `--bind` e caminhos proibidos viram `--tmpfs`
(ficam ocultos). `silent: true` não revela as listas no prompt, mas o `bwrap`
continua aplicando. O log de tools fica em `<uuid>.tools.jsonl` com comando,
saída e exit code; o resultado devolve só contagem e arquivos mudados.

`verify_command` roda no `cwd` no fim do turno; se falhar, o erro volta ao
agente e ele tenta de novo até `verify_retries`. `agy_verify` faz o mesmo sob
demanda. Se o resultado vier `SUCCESS` com texto vazio e ação negada, o shim
marca erro e reenvia uma vez pedindo a resposta sem comandos.

> Em tarefa delegada, use só os testes do próprio trabalho e mantenha `verify_retries=0`. O gate completo do repositório continua com o coordenador antes do commit.

## Retomar após restart/crash

`session_id` (`gN`) é só um alias em memória. O UUID `conversation_id` é
durável e sobrevive ao restart do shim/PC:

```json
agy_resume(conversation_id="<uuid>", prompt="Continue de onde parou")
```

O agy é reiniciado com `--conversation`, restaurando o histórico. Comandos e
tools que estavam rodando **não** voltam; o agente pode precisar refazer o passo
interrompido. Se a conversa usava Gemini 4 Argon, passe `model` explicitamente
no resume.

## Modos

- **`read-only`** (recomendado para análise): `bwrap` com `/` read-only,
  workspace **read-only**; só `~/.gemini`, `~/.cache` e `/tmp` graváveis.
  Comandos (`run_command`) são auto-negados no headless.
- **`workspace-write`** (default): `bwrap` com o workspace gravável,
  `--dangerously-skip-permissions` para rodar comandos; o resto do FS continua
  read-only. Ainda assim, aponte `AGY_WORKSPACE` só para o projeto.

Modelos: `gemini-4-argon-high`, `gemini-3.8-flash-high` e a família
`gemini-4-hydrogen-*` (default `gemini-3.8-flash-high`).
Em **Argon e Flash** o nível é fixo: as variantes `-low`/`-medium` foram
removidas porque, para contagem de imagens, o modelo barato divergiu. O
**Hydrogen é a exceção**: aceita `low|medium|high|xhigh` explícito
(`gemini-4-hydrogen-xhigh`), o `effort` acompanha o sufixo, e o id sem sufixo
cai em `high`. Liste os disponíveis com `agy models`.
Esforço: `low|medium|high|xhigh|max` (default `high`).

**Trava de escrita para orquestradores:** `AGY_ALLOW_WRITE=0` rebaixa todo
`workspace-write` para `read-only`. O resultado volta com `mode_requested` e
`mode_note` para deixar claro que houve o rebaixamento.

## Como subagente do DSH

O `dsh-acp` registra este servidor no DeepSeek Harness via
`@deepseek-ai/dsh-mcp-client` (entrada `mcp-agy` no `acp-overlay.yml`). O
DeepSeek passa a ver `mcp__agy__agy_start` etc. e a corrente fica:

**Claude Code → dsh-acp → DeepSeek v4.1-flash → agy / Gemini 3.8 Flash**

O overlay define `AGY_WORKSPACE` a partir de `DSH_ACP_WORKSPACE` e
`AGY_ALLOW_WRITE` a partir de `DSH_PERMISSION_MODE`, então sessões `read-only`
do DSH não conseguem escrever através do agy.

## Exemplos

Análise:

> Use o `agy-gemini` em `read-only`, `wait: true`: leia `<arquivo>` e resuma em 5 linhas.

Implementação:

> Use o `agy-gemini` (`workspace-write`) para implementar X, rodar os testes e trazer o diff.

Longo:

> `agy_start`; se ainda estiver rodando, `agy_status(wait_seconds: 30)` no máximo 3x; no fim `agy_result`.

## Notas

- É um adaptador local não oficial (MIT); o `agy` é o produto do Google.
- O trabalho do Gemini não entra no contexto do Claude; `status` é compacto e
  `result` puxa o texto uma vez.
- Se `agy` atualizar, o protocolo stream-json pode mudar; teste após updates.

