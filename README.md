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
  sessões numa única chamada (até 12); `deepseek_wait_all` / `agy_wait_all`
  esperam todas ao mesmo tempo (tempo = a mais lenta, não a soma).
- **Sem polling:** a chamada de `wait` é o canal de aviso. O Claude Code
  auto-backgrounda após 8s e acorda o modelo quando o turno termina.
- **Espera fora do turno:** o servidor grava estado/output por sessão e os
  comandos `dsh-wait`/`agy-wait` bloqueiam em outro processo, sem segurar o
  turno do Claude. Rode-os com Bash `run_in_background`.
- **Perfil por sessão:** `profile` com `instructions`, `writable_dirs` e
  `forbidden_paths`; o agy aplica em `bwrap`, o DSH aplica no wrapper de
  `host-spawn`/podman.
- **Log de tools:** comando, saída e exit code vão para um JSONL por sessão; o
  resultado devolve só contagem e arquivos mudados.
- **Verificação:** `verify_command`/`*_verify` rodam um teste, devolvem o exit
  code e devolvem o erro ao agente para uma nova tentativa.
- **IDs duráveis:** `deepseek_sessions`/`agy_conversations` listam o que
  sobrevive ao restart; use com `*_resume`.
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
  bin/dsh-wait
  bin/install-dsh.sh
  README.md
  TUTORIAL.md
agy-mcp/     # copie para ~/.local/share/agy-mcp/
  server.mjs
  bin/agy-wait
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
mkdir -p ~/.local/bin
cp dsh-acp/bin/dsh-wait agy-mcp/bin/agy-wait ~/.local/bin/
chmod +x ~/.local/bin/dsh-wait ~/.local/bin/agy-wait

# DSH fora do cache efêmero do npx (npm cache clean apaga o npx):
bash dsh-acp/bin/install-dsh.sh
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
| `deepseek_start_many(tasks[])` | inicia N sessões em paralelo (máx. 12) |
| `deepseek_resume(dsh_session_id, prompt, ...)` | reata a uma sessão persistida após crash/restart e manda um prompt |
| `deepseek_send(session_id, message, ...)` | follow-up na mesma sessão |
| `deepseek_wait(session_id, wait_seconds?)` | bloqueia até uma sessão terminar (default 1h) |
| `deepseek_wait_all(session_ids[], wait_seconds?, full?)` | espera todas em paralelo; compacto por padrão |
| `deepseek_status` / `deepseek_result` | status compacto / output acumulado (inclusive parcial) |
| `deepseek_verify(session_id, command, retries?, ...)` | roda o teste, devolve exit code e reenvia o erro ao agente |
| `deepseek_cancel` / `deepseek_close` | cancela o turno com relatório parcial / encerra e devolve o parcial |
| `deepseek_list` / `deepseek_sessions` | sessões vivas deste processo / sessões persistidas no disco |

### `agy-mcp`

| Tool | O que faz |
|---|---|
| `agy_start(prompt, cwd?, mode?, model?, effort?, wait?, wait_seconds?)` | cria uma sessão e volta rápido |
| `agy_start_many(tasks[])` | inicia N sessões em paralelo (máx. 12) |
| `agy_resume(conversation_id, prompt, ...)` | reata a uma conversa persistida após crash/restart e manda um prompt |
| `agy_send(session_id, message, ...)` | follow-up; respawna se a sessão foi fechada por TTL |
| `agy_wait(session_id, wait_seconds?)` | bloqueia até uma sessão terminar (default 10 min) |
| `agy_wait_all(session_ids[], wait_seconds?, full?)` | espera todas em paralelo; compacto por padrão (`full=true` traz o texto) |
| `agy_status` / `agy_result` | status compacto / output completo |
| `agy_verify(session_id, command, retries?, ...)` | roda o teste, devolve exit code e reenvia o erro ao agente |
| `agy_cancel` / `agy_close` | cancela / encerra e devolve o output parcial |
| `agy_list` / `agy_conversations` | sessões vivas / conversas persistidas no disco |

Modelos do agy: `gemini-4-argon-medium|high` e
`gemini-3.8-flash-medium|high` (default `gemini-3.8-flash-high`). As variantes
`-low` foram removidas: para contagem de imagens o modelo barato divergiu; use
`high` como default. Veja a lista da sua conta com `agy models`.
Esforço: `low|medium|high|xhigh|max` (default `high`).

## Como usar

Um agente:

> Use o `dsh-acp` para ler `README.md` e resumir em 5 linhas. `mode: read-only`.

Vários em paralelo:

> Rode 3 agentes em paralelo com `deepseek_start_many` (tasks A, B, C) e depois
> `deepseek_wait_all`. Não use polling.

Regra de ouro: **não intercale `start` e `wait`**. `start A → wait A → start B`
faz o B só existir depois que o A termina. Inicie todos primeiro (ou use o
batch) e só então espere.

## Espera sem travar o turno

`deepseek_wait`/`agy_wait` continuam existindo, mas o caminho recomendado é
rodar o comando de espera em background:

```bash
dsh-wait <dsh_session_id>
agy-wait <conversation_id>
```

O servidor grava `~/.local/state/dsh-acp-mcp/sessions/<uuid>.json` e `.out.txt`
(e o equivalente em `agy-mcp`) quando o turno muda de estado. `dsh-wait` usa
`fs.watch`, não polling, e imprime o JSON com o resultado quando termina. Rode
com o Bash `run_in_background` para o Claude seguir trabalhando e ser acordado
no fim.

## Perfil e verificação

```json
deepseek_start(
  prompt="...",
  profile={
    "instructions": "Nunca leia o gabarito. Use a porta 9003.",
    "writable_dirs": ["data/saida/minha_trilha"],
    "forbidden_paths": ["data/gold"],
    "silent": true
  },
  verify_command="pytest tests/maos/test_da_tarefa.py -q",
  verify_retries=0
)
```

`silent: true` não revela as listas no prompt, mas a política continua valendo.
Use no `verify_command` só os testes do trabalho delegado; o gate completo do
repositório fica com o coordenador antes do commit.

No agy, `forbidden_paths` viram `--tmpfs` e `writable_dirs` viram `--bind` no
`bwrap`. No DSH, o shim coloca um wrapper de `host-spawn` no PATH que bloqueia
os caminhos proibidos e mounts fora das pastas permitidas; `writable_dirs`
também entram no `sandbox-policy` (`additionalWritableRoots`), então as
ferramentas nativas podem escrever nelas. Se uma tool tentar usar um caminho
proibido, o turno é cancelado e o evento fica no log. O
`verify_command` roda no `cwd` e, se falhar, o erro volta para o agente (até
`verify_retries`).

> Em tarefa delegada, use só os testes do próprio trabalho e mantenha `verify_retries=0`. O gate completo do repositório continua com o coordenador antes do commit.

## Retomar após crash/restart

Os aliases `s1`/`g1` são **só da memória do shim**: depois de reiniciar o Claude
ou o PC, `deepseek_list` volta vazio e `deepseek_send("s1")`/`agy_send("g1")` não
existem mais. O ID durável continua no disco:

- **DSH:** o UUID retornado como `dsh_session_id` → `deepseek_resume(dsh_session_id, prompt, ...)`
- **agy:** o UUID retornado como `conversation_id` → `agy_resume(conversation_id, prompt, ...)`

O histórico e os arquivos da sessão voltam. Processos e jobs em background que
estavam rodando **não** voltam — o agente retoma do último estado gravado e pode
precisar refazer o passo interrompido.

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

