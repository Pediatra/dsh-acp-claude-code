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
| `agy_start(prompt, cwd?, mode?, model?, effort?, wait?, wait_seconds?)` | abre **uma** sessão e volta rápido com `session_id` |
| `agy_start_many(tasks[])` | abre **N sessões em paralelo** numa chamada (máx. 8) |
| `agy_resume(conversation_id, prompt, ...)` | reata a uma conversa persistida por UUID após restart/crash |
| `agy_send(session_id, message, wait?, wait_seconds?)` | follow-up; respawna a sessão se ela foi fechada por TTL |
| `agy_wait(session_id, wait_seconds?)` | bloqueia até o turno terminar (default 10 min, máx. 1h) |
| `agy_wait_all(session_ids[], wait_seconds?)` | espera todas em paralelo (tempo = a mais lenta) |
| `agy_status(session_id, wait_seconds?)` | compacto: estado, tempo, última tool, usage, denied; preview de 400 chars |
| `agy_result(session_id, max_chars?)` | output completo do último turno, uma vez |
| `agy_cancel(session_id)` | mata o processo; a conversa continua resumível |
| `agy_close(session_id)` | encerra e esquece a sessão (libera RAM na hora) |
| `agy_list()` | sessões abertas |

## Paralelismo e TTL

- Para vários agentes: `agy_start_many` → `agy_wait_all`. **Não intercale**
  `start`/`wait`; esperar o primeiro antes de iniciar o segundo serializa tudo.
- Cada sessão é um processo `bwrap + agy` (~100–400 MB). Sessão ociosa fecha
  sozinha após **30 min** (`AGY_IDLE_TTL_SECONDS`, default `1800`; `0` desliga).
  Um `agy_send` depois respawna com `--conversation` e mantém o contexto.
- `agy_close` encerra e **esquece** a sessão; para continuar, abra outra.

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

Modelos: `gemini-4-argon-low|medium|high` e
`gemini-3.8-flash-low|medium|high` (default `gemini-3.8-flash-high`).
Liste os disponíveis na sua conta com `agy models`.
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
