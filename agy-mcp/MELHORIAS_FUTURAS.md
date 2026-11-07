# Melhorias futuras — bridge `agy` / DSH

**Status:** planejamento. Nada deste documento foi implementado.
**Data:** 2026-11-06.
**Alvos:** `agy-mcp/server.mjs` (fonte) e `~/.local/share/dsh-acp-mcp/server.mjs` (bridge do DSH).
**Origem:** análise do [`opencode-model-router`](https://github.com/marco-jardim/opencode-model-router) v2.9.1, confrontada com o comportamento real dos nossos bridges.

Este documento existe para ser lido **antes** de mexer no código. Ele registra o que vale a pena trazer do router, o que não vale, os números do baseline e os testes de aceite que já podem ser rodados sem implementar nada.

---

## 0. Resumo executivo

| # | Melhoria | O que resolve | Impacto | Esforço | Risco | Estado |
|---|---|---|---|---|---|---|
| 0 | Mosaicos no prompt | 207–231 leituras de imagem por passada | alto | baixo | baixo | só prompt/dados |
| 1 | Telemetria de leitura | não saber quantas leituras nem quanto tempo | alto | médio | baixo | observar |
| 1b | Estado vivo do DSH | `elapsed_seconds` congelado em 0 durante o turno | médio | baixo | baixo | paridade com o `agy` |
| 1c | Congelar `elapsed` no fim | tempo continua crescendo depois do turno | médio | baixo | baixo | correção pequena |
| 2 | Catálogo de modelos | ID sumido só falha no meio do turno | médio | baixo | baixo | cache + aviso |
| 3 | Placar por modelo | decidir sem número se o principal vale a pena | médio | baixo | baixo | metadados |
| 4 | Orçamento de leitura (aviso) | exploração longa sem limite visível | médio | médio | baixo | opt-in |
| 5 | Orçamento de leitura (parada) | loop de leitura descontrolado | médio | médio | médio | opt-in, desligado |

**Conclusão principal:** o `opencode-model-router` **não substitui** o bridge. Ele é um plugin que roteia subagentes dentro do OpenCode; o nosso bridge fala com um CLI externo (`agy`) via MCP. O que se aproveita são ideias de observabilidade e guardrails — não o produto.

**Segunda conclusão:** a maior melhoria não é código. O `capo_0265` já tem **19 mosaicos** que cobrem os 57 vídeos; usar os mosaicos para triar e abrir o quadro individual só quando necessário reduz a leitura em ~4–12×. O orçamento de leitura é genérico e útil, mas não substitui essa mudança de prompt.

---

## 1. Contexto

### 1.1 O que o bridge faz hoje

O `agy-mcp` é um servidor MCP stdio. Ele:

1. abre um processo `agy` com `--input-format stream-json --output-format stream-json`;
2. lê eventos `init`, `step_update` e `result`;
3. expõe ferramentas `agy_start`, `agy_start_many`, `agy_send`, `agy_wait`, `agy_status`, `agy_result`, `agy_cancel`, `agy_close`, `agy_resume`, `agy_conversations`;
4. grava estado e log de ferramentas em `~/.local/state/agy-mcp/sessions/`;
5. em `read-only`, roda dentro de `bwrap` com `/` somente leitura;
6. no modo `auto`, começa no modelo principal e só troca para o fallback quando detecta crédito esgotado;
7. normaliza a família para níveis fixos (principal em `medium`, Gemini em `high`), independentemente do pedido.

O DSH é o mesmo desenho, com ACP em vez de stream-json, e modelo fixo em `deepseek-v4.1-flash`.

### 1.2 O que o `opencode-model-router` é — e por que não substitui

O router é um plugin do OpenCode que injeta um protocolo de delegação no system prompt e cria subagentes `@fast` / `@medium` / `@heavy`. Ele decide **quem faz cada tarefa** por tipo, custo e resultado de verificação.

O que ele **não** faz:

- não enxerga um CLI externo como o `agy`;
- não detecta `INSUFFICIENT_G1_CREDITS_BALANCE` nem crédito esgotado de um processo filho;
- não reinicia sessão nem repete o prompt em outro modelo;
- o “fallback entre providers” é uma **linha de instrução no prompt** (`Err→retry-alt-tier→fail→direct`), não uma troca automática em código. O próprio comentário em `src/index.ts` diz: *“Provider-failover is advisory only … no provider swap.”*;
- o tratamento de quota do executor (`src/executor/capacity.ts`) apenas **pausa o provider até o reset** e cria um item de inbox; não migra de modelo.

Ou seja: o router resolve **roteamento por custo dentro do OpenCode**. Nosso problema é **failover por crédito de um CLI externo**. São camadas diferentes.

### 1.3 Restrições de projeto

Estas restrições valem para qualquer implementação futura:

- **Sem polling e sem vigia.** Nada de processo separado, cron ou loop de leitura de estado. Tudo orientado a evento.
- **Roteamento discreto.** Prompts e documentos não citam o modelo principal; usam `PRIMARY_MODEL` / “modelo principal”. Estado interno e logs podem ter o ID.
- **Níveis fixos.** Principal sempre `medium`; Gemini Argon/Flash sempre `high`; nada de effort bump.
- **DSH fixo** em `deepseek-v4.1-flash`; nada de auto roteamento no DSH.
- **`agy` read-only via `bwrap`**; nenhuma melhoria pode afrouxar o sandbox.
- **Um arquivo por vez.** Este documento é o único artefato desta tarefa; nenhum bridge foi alterado.

---

## 2. Baseline real (2026-11-06)

### 2.1 As três passadas do `capo_0265`

Fonte: `~/.local/state/agy-mcp/sessions/*.tools.jsonl` e os estados das sessões `gtooe-*`. A “janela de ferramentas” vai do primeiro ao último evento; a “duração do turno” inclui o tempo até a primeira ferramenta e o resultado.

| Sessão | Modelo | `read_file` | Caminhos distintos | Repetidos | `run_command` | Duração do turno | Janela de ferramentas | `output_chars` |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `gtooe-4` | `gemini-3.8-flash-high` | 231 | 230 | 1 | 14 | 29m52s | 29m08s | 3.963 |
| `gtooe-5` | `gemini-3.8-flash-high` | 224 | 222 | 2 | 24 | 23m44s | 23m04s | 5.233 |
| `gtooe-6` | `gemini-3.8-flash-high` | 207 | 206 | 1 | 25 | 22m19s | 21m42s | 4.376 |

O consenso das três passadas foi **57 de 57 unânimes**: 3 com capo (por texto na tela), 50 sem capo e 4 não visíveis. O problema não foi qualidade; foi custo e tempo.

**Leitura dos números:**

- o volume é o problema: 207–231 leituras, quase todas imagens;
- redundância é desprezível: 1–2 repetições por passada. Um detector de “leitura repetida” quase nunca dispararia;
- a mediana de `output_chars` de um `read_file` de imagem é **0** — o modelo recebe a imagem, não texto; contar por nome de ferramenta e caminho é mais confiável que medir saída;
- o estado final (`elapsed_seconds` 3592/3224/3139) inclui o tempo ocioso até o `close`; não serve como duração do turno.

### 2.2 Mosaicos

`data/saida/maos/capo_0265/mosaicos/` tem **19 arquivos**, `m00.jpg` a `m18.jpg`.

Cada mosaico é uma folha de **3 vídeos × 4 quadros** (3s, 8s, 30s e 60s), com o número do vídeo e o instante impressos no quadro. Geometria: **1920×810**, cada quadro 480×270; total de **5,4 MB**.

- 57 vídeos ÷ 3 por folha = 19 folhas.
- 57 vídeos × 4 instantes = 228 quadros — exatamente o que as passadas leram um a um.
- O `indice.json` mapeia `m00` → vídeos 0,1,2; `m01` → 3,4,5; …; `m18` → 54,55,56.

### 2.3 Catálogo de modelos

`agy models` respondeu em **2,17 s** com **13 modelos** (Argon, Flash, Opus, principal e GPT-OSS). O comando imprime “Fetching available models...” antes da lista, então não é instantâneo; validar no boot sem cache atrasaria o MCP.

### 2.4 Eventos disponíveis

Exemplo real de um `step_update` de leitura:

```json
{
  "event": "step_update",
  "step_update": {
    "step_index": 2,
    "step_type": "tool",
    "tool_name": "read_file",
    "state": "ACTIVE",
    "tool_info": { "parameters": { "Path": "…/pedido.md" } }
  }
}
```

O bridge já extrai `tool_name`, `state`, `paths`, `parameters`, `output_chars` e `exit_code`. Portanto a telemetria de leitura **não precisa de parser novo**: basta classificar e agregar o que já chega em `AgySession.onMessage`.

### 2.5 DSH: o estado congela

Inspeção do `~/.local/share/dsh-acp-mcp/server.mjs`:

- `writeState()` é chamado no `init`, no começo do `prompt`, no fim do `prompt` e no `close`;
- **não existe** `scheduleStateWrite()` nem timer de estado;
- `elapsedSeconds()` usa `turnStartedAt`, que é definido no `prompt` e não é atualizado depois.

Resultado: durante um turno longo, o JSON de estado fica em `running / elapsed 0` até terminar. O `agy` já foi corrigido com `scheduleStateWrite()` (throttle de 2 s); falta a paridade no DSH.

### 2.6 Replay do orçamento de leitura

Replay do `gtooe-4` simulando um teto de leitura por contagem:

| Teto | Quando dispara | Desde a 1ª leitura | Antes do fim real | Economia de janela |
|---:|---|---:|---:|---:|
| 20 | 17:31:01 | 1m22s | 27m20s | 95% |
| 30 | 17:31:22 | 1m43s | 26m59s | 94% |
| 40 | 17:31:22 | 1m43s | 26m59s | 94% |
| 50 | 17:31:48 | 2m09s | 26m34s | 92% |
| 60 | 17:32:19 | 2m40s | 26m02s | 91% |

**Conclusão importante:** um teto de 40 leituras dispara em ~1m43s e “economiza” 94% do tempo, mas deixaria **17 dos 57 vídeos sem leitura**. Numa tarefa de enumeração completa, isso produz uma passada incompleta. O teto serve como guarda de runaway, **não** como substituto da leitura completa.

Além disso, as leituras são feitas em lote: a 30ª e a 40ª caíram com **76 ms** de diferença. Um `stop` ingênuo cortaria o lote no meio. Se um dia houver `enforce`, ele precisa parar no fim do lote (mudança de `step_index` ou próximo evento não-leitura), não no meio.

### 2.7 Descobertas colaterais

1. **`elapsed_seconds` não congela no fim do turno.** `turnStartedAt` não é zerado em `finishTurn()`; `elapsedSeconds()` continua contando enquanto a sessão está ociosa. Exemplo: `gtooe-4` terminou o turno em ~29m52s, mas o estado final mostra 3592 s (~59m52s) porque ficou 30 min ocioso até o `close`. Isso vale para `agy` e DSH. Para placar, é preciso gravar `turn_elapsed_seconds` no `finishTurn()`, não ler `elapsed_seconds` depois.
2. **README do `agy-mcp` desatualizado.** Ele diz “Modelo padrão: Gemini 3.8 Flash (High)”, mas o código usa `auto` com modelo principal + fallback. Atualizar depois, sem citar o modelo principal.
3. **O estado do `agy` já atualiza durante o turno** (throttle de 2 s), mas o do DSH não. São correções separadas.

---

## 3. Melhoria 0 — mosaicos primeiro (prompt, não código)

### 3.1 Por quê

19 imagens cobrem os 57 vídeos; as passadas leram 207–231. É a maior redução possível e não exige mudar o bridge, o sandbox ou o modelo.

### 3.2 O que mudar

No prompt que gera as passadas do `capo_0265` (e em prompts futuros do mesmo tipo):

1. ler `indice.json` para saber qual vídeo é qual;
2. ler os **19 mosaicos** em ordem (`m00` a `m18`);
3. classificar cada vídeo pelo mosaico: `capo`, `sem_capo` ou `nao_visivel`;
4. abrir os quadros individuais **somente** quando:
   - o mosaico for ambíguo;
   - a classificação for `capo` (confirmar a casa);
   - a classificação for `nao_visivel` (confirmar que o braço/nut está fora do quadro);
5. registrar no output se a decisão veio do mosaico ou do quadro individual (coluna `fonte`, por exemplo).

O prompt deve dizer explicitamente: **“Não leia os 228 quadros individuais. Use os mosaicos para triar.”** Sem essa frase, o modelo volta ao comportamento antigo.

### 3.3 O que não mudar

- o esquema da passada (`n | classe | casa | texto | arquivo | motivo`);
- o consenso de 3 passadas;
- o `LEIAME.json` e o `consenso.json`;
- nenhum arquivo de dados.

### 3.4 Aceite

| Critério | Baseline | Meta conservadora | Meta esticada |
|---|---:|---:|---:|
| `read_file` por passada | 207–231 | ≤70 | ≤40 |
| Tempo do turno | 22–30 min | ≤10 min | ≤7 min |
| Consenso | 57/57 | 57/57 | 57/57 |
| Quadros individuais | ~228 | só ambíguos/capo/não visível | idem |
| Esquema de saída | — | inalterado | inalterado |

A meta conservadora assume 19 mosaicos + 4 quadros para cada um dos ~12 vídeos ambíguos = 67 leituras. A esticada assume que só os 3 capo e os 4 não visíveis precisam de quadros = 47. O número exato só sai com um teste cego em 5 vídeos ambíguos.

### 3.5 Como testar

1. rodar uma passada com o prompt novo;
2. contar `read_file` no `.tools.jsonl`;
3. comparar a saída com `consenso.json` (57/57);
4. comparar o tempo com a janela de ferramentas;
5. se a qualidade cair, voltar ao prompt antigo — é só prompt.

---

## 4. Melhoria 1 — telemetria de leitura (shadow)

### 4.1 Objetivo

Medir sem mudar comportamento. É o “shadow” do router: primeiro observar, depois avisar, só então impor.

### 4.2 Dados

Derivar de `this.toolCalls` (concluídas) + `this.activeTools` (em andamento), sem novo parser:

```json
"read_stats": {
  "read_only_calls": 231,
  "distinct_paths": 230,
  "repeated_reads": 1,
  "by_tool": { "read_file": 231, "grep_search": 0, "list_directory": 0 },
  "first_read_at": "2026-11-05T17:29:35.195Z",
  "last_read_at": "2026-11-05T17:58:31.000Z",
  "last_path": "…/quadros/056_60.jpg"
}
```

Regras:

- classificar como leitura somente ferramentas de inspeção (`read_file`, `grep_search`, `list_directory`, `glob` etc.); descobrir os nomes reais nos logs antes de fixar a lista;
- `run_command` e `write_file` não entram;
- não guardar todos os caminhos no JSON de estado (o `.tools.jsonl` já tem); guardar só agregados e o último caminho;
- expor em `basePayload()` para aparecer em `agy_status` e `agy_result`;
- não alterar o comportamento do turno.

### 4.3 Onde encaixar

- `AgySession.onMessage` (ramos `step_type === "tool"` e `state === "DONE"`);
- um helper `readStats()` ao lado de `toolSummary()`;
- `basePayload()` para publicar;
- nenhuma mudança em `buildSpawn`, `bwrap` ou no prompt.

### 4.4 Aceite

| Critério | Esperado |
|---|---|
| Replay de `gtooe-4` | `231 / 230 / 1` |
| Replay de `gtooe-5` | `224 / 222 / 2` |
| Replay de `gtooe-6` | `207 / 206 / 1` |
| Comportamento do turno | idêntico |
| Estado | `read_stats` presente em `agy_status` e `agy_result` |
| Custo | < 1 ms por evento |

### 4.5 Como testar sem abrir `agy`

Extrair a agregação numa função pura e alimentá-la com os eventos do `.tools.jsonl`:

```python
import json, collections

def read_stats(path):
    reads, times, tools = [], [], collections.Counter()
    for line in open(path):
        d = json.loads(line)
        if d.get("event") == "tool_call":
            tools[d.get("tool_name")] += 1
            if d.get("tool_name") == "read_file":
                reads.extend(d.get("paths") or [])
                times.append(d["time"])
    c = collections.Counter(reads)
    return {
        "read_only_calls": len(reads),
        "distinct_paths": len(c),
        "repeated_reads": sum(n - 1 for n in c.values() if n > 1),
        "by_tool": dict(tools),
        "first_read_at": times[0] if times else None,
        "last_read_at": times[-1] if times else None,
    }
```

O mesmo teste vira unidade em `node --test`, sem processo filho.

---

## 5. Melhoria 1b — estado vivo do DSH

### 5.1 Problema

O estado do DSH fica em `running / elapsed 0` durante o turno; o do `agy` já atualiza a cada 2 s. Isso atrapalha `deepseek_status`, `deepseek_wait` e qualquer decisão do pai.

### 5.2 O que fazer

Copiar o padrão que já funciona no `agy`:

- adicionar `lastStateWriteAt` e `stateWriteTimer` ao `AcpSession`;
- `scheduleStateWrite(minIntervalMs = 2000)` com `setTimeout(...).unref()`;
- chamar em `recordTool()` e nos pontos em que o estado muda (`onMessage`, `prompt`, `finishTurn`);
- limpar o timer em `close()` e `cancel()`;
- não criar intervalo nem processo novo.

### 5.3 Aceite

| Critério | Esperado |
|---|---|
| Turno de 60 s | `elapsed_seconds` cresce ~a cada 2 s |
| `updated_at` | muda durante o turno |
| Frequência | no máximo 1 escrita a cada 2 s |
| `close()` | timer limpo, sem write depois de fechado |
| Custo | desprezível |

### 5.4 Como testar

Com um `dsh` falso (script que emite eventos ACP e dorme), iniciar um turno e ler o JSON duas vezes com 5 s de diferença. Sem a correção, o segundo `elapsed_seconds` é igual ao primeiro; com a correção, é ~5 s maior.

---

## 6. Melhoria 1c — congelar o `elapsed` no fim do turno

### 6.1 Problema

`turnStartedAt` não é zerado em `finishTurn()`; `elapsedSeconds()` continua contando enquanto a sessão está ociosa. O estado final de `gtooe-4` mostra 3592 s, mas o turno durou ~1792 s. Isso distorce status e placar.

### 6.2 O que fazer

- no `finishTurn()`, gravar `turnElapsedSeconds = elapsedSeconds()` e `turnEndedAt = Date.now()`;
- `elapsed_seconds` passa a significar **duração do turno atual ou do último turno** (congelada);
- adicionar `idle_seconds` separado, calculado a partir de `turnEndedAt`;
- no começo de um novo turno, zerar `turnElapsedSeconds` e `turnEndedAt`;
- o mesmo no DSH.

### 6.3 Aceite

| Critério | Esperado |
|---|---|
| Turno de 30 min | `turn_elapsed_seconds` ≈ 1800 |
| 30 min ocioso depois | `turn_elapsed_seconds` continua 1800; `idle_seconds` ≈ 1800 |
| Novo turno | `turn_elapsed_seconds` recomeça em 0 |
| Placar | usa `turn_elapsed_seconds`, não `elapsed_seconds` |

### 6.4 Como testar

Replay dos estados `gtooe-4/5/6`: o turno deve bater com 29m52s / 23m44s / 22m19s, não com 3592/3224/3139 s.

---

## 7. Melhoria 2 — catálogo de modelos

### 7.1 Problema

`PRIMARY_MODEL` e `FALLBACK_MODEL` são IDs fixos. Se o provedor renomear ou remover um deles, a falha só aparece no meio do turno, muitas vezes como erro genérico. O `agy models` lista o catálogo vivo em ~2,2 s.

### 7.2 Desenho

Cache em `~/.local/state/agy-mcp/models.json` (0600):

```json
{
  "checked_at": "2026-11-06T12:00:00.000Z",
  "source": "agy models",
  "ttl_seconds": 86400,
  "models": ["gemini-4-argon-medium", "…", "claude-…"]
}
```

No boot do bridge:

1. ler o cache; se estiver fresco (< 24 h), usar;
2. se estiver velho ou ausente, disparar `agy models` em background, **sem bloquear** o `initialize` do MCP;
3. atualizar o cache quando terminar;
4. comparar `PRIMARY_MODEL` e `FALLBACK_MODEL` com a lista;
5. se faltar, logar aviso e publicar `model_catalog: { checked_at, count, missing: [] }` no status;
6. `AGY_STRICT_MODELS=1` transforma o aviso em falha rápida (opt-in).

### 7.3 Validação por família

Validar o ID exato **e** a família, para sobreviver a uma troca de versão:

```text
^<família>-[0-9][0-9.-]*?-(low|medium|high)$
```

O primeiro teste com `[0-9.]+` falhou porque a versão usa hífen (`5-5`), não ponto. O padrão precisa aceitar `[0-9.-]`. Teste com os 13 IDs reais e com renomeações hipotéticas (`5-6`, `5.6`, `3.9`) antes de fixar.

### 7.4 O que não fazer

- não rodar `agy models` a cada turno;
- não bloquear o boot esperando a rede;
- não colocar ID de modelo em prompt;
- não trocar modelo automaticamente por causa do catálogo; só avisar (ou falhar no modo estrito).

### 7.5 Aceite

| Critério | Esperado |
|---|---|
| Cache fresco | nenhum subprocesso `agy models` |
| Cache velho | 1 atualização em background |
| Modelo ausente | aviso no log e `missing` no status |
| Startup normal | < 50 ms de atraso |
| `AGY_STRICT_MODELS=1` | erro claro no boot |
| Família renomeada | ainda reconhecida pelo padrão |

### 7.6 Como testar

Criar um `agy` falso em `/tmp` que imprime uma lista sem o modelo principal; apontar `AGY_BIN` para ele; iniciar o bridge e conferir o aviso. Rodar duas vezes e conferir que o cache evita o segundo subprocesso.

---

## 8. Melhoria 3 — placar por modelo

### 8.1 Objetivo

Responder com número: o modelo principal vale a latência? O fallback dispara quanto? Qual modelo falha mais?

### 8.2 Formato

Uma linha JSON por turno em `~/.local/state/agy-mcp/stats.jsonl` (0600):

```json
{
  "time": "2026-11-06T12:00:00.000Z",
  "session_id": "gtooe-7",
  "conversation_id": "…",
  "model": "…",
  "model_requested": "auto",
  "used_fallback": false,
  "status": "idle",
  "turn_elapsed_seconds": 1792,
  "output_chars": 3963,
  "tool_calls": 246,
  "credit_error": null
}
```

Regras:

- gravar **uma vez** no `finishTurn()`, com `turn_elapsed_seconds` (congelado), não `elapsed_seconds`;
- nunca gravar prompt, saída ou caminhos;
- chave de idempotência `session_id + turn_seq` para não duplicar em retry/restart;
- rotação simples por tamanho (ex.: 10 MB) ou por data; não é crítico no começo.

### 8.3 Consulta

Começar com `agy_status(stats=true)` ou `agy_stats(last_n)`. Não criar tool nova antes de saber se o pai vai consumir. Agregações:

- turnos, sucessos, erros, cancelados;
- mediana e p95 de `turn_elapsed_seconds`;
- contagem de `used_fallback` e de `credit_error`;
- por modelo.

### 8.4 Aceite

| Critério | Esperado |
|---|---|
| 2 turnos | 2 linhas, sem duplicata |
| Fallback | `used_fallback: true` só quando houve troca |
| Privacidade | nenhum prompt/saída/caminho no arquivo |
| Permissão | 0600 |
| Consulta | totais e mediana corretos |
| Reinício | não duplica turno já gravado |

### 8.5 Como testar

Com um `agy` falso, rodar dois turnos (um sucesso, um erro de crédito) e conferir as duas linhas. Depois, reiniciar o bridge e conferir que o placar continua legível.

---

## 9. Melhoria 4 — orçamento de leitura (aviso)

### 9.1 Objetivo

Dar ao pai (Claude/DSH) um sinal claro de que a sessão está lendo demais, **sem** matar o turno. É o “advise”.

### 9.2 Schema do perfil

```json
"read_budget": {
  "max_reads": 40,
  "max_repeats": 2,
  "action": "warn"
}
```

- `max_reads`: inteiro positivo; ausente = sem teto;
- `max_repeats`: quantas vezes o mesmo caminho pode ser lido; ausente = sem teto;
- `action`: `"warn"` (default quando o bloco existe) ou `"stop"` (seção 10);
- validar e ignorar chaves desconhecidas; não quebrar perfis antigos.

### 9.3 Prompt

Injetar em `applyProfilePrompt()` uma cláusula curta, **sem nome de modelo**:

```text
Leia no máximo {max_reads} arquivos nesta tarefa. Se já tiver o suficiente,
responda com o que tem. Não releia o mesmo caminho.
```

A cláusula é um lembrete; quem conta de verdade é o bridge.

### 9.4 Aviso no estado

Em 80% e 100% do orçamento, publicar:

```json
"read_budget": {
  "used": 32,
  "max": 40,
  "state": "warning"
}
```

e, no `agy_result`, um `hint` textual: “orçamento de leitura em 80%; considere responder ou dividir a tarefa”. Nada é cancelado.

### 9.5 Aceite

| Critério | Esperado |
|---|---|
| Perfil sem `read_budget` | comportamento idêntico ao atual |
| Orçamento 40 | `warning` em 32, `exceeded` em 40 |
| Turno | não é interrompido |
| `read_stats` | consistente com o contador |
| Prompt | cláusula presente, sem nome de modelo |

### 9.6 Como testar

Replay do `gtooe-4` com teto 40: o aviso deve aparecer em 32 e 40; o turno deve terminar normalmente. Testar também um perfil sem o bloco e conferir que nada mudou.

---

## 10. Melhoria 5 — orçamento de leitura (parada, opt-in)

### 10.1 Quando usar

Somente para **runaway**: uma sessão que já deveria ter respondido e continua lendo. **Não** usar em tarefas de enumeração completa (os 57 vídeos), porque o teto de 40 deixaria 17 sem leitura.

### 10.2 Comportamento

Com `action: "stop"`:

1. ao ultrapassar `max_reads`, marcar `stopRequested = true`;
2. cancelar o turno com `stop_reason: "read_budget"` e `partial: true`;
3. opcionalmente, reiniciar **uma vez** com um prompt interno: “Responda agora com o que já tem; não leia mais nada.”;
4. nunca reiniciar mais de uma vez; se o modelo voltar a ler, encerrar com parcial;
5. preservar a saída parcial e o log de ferramentas.

### 10.3 Cuidado com lotes

As leituras vêm em lote (a 30ª e a 40ª com 76 ms de diferença). Duas opções:

- **simples:** cancelar imediatamente ao estourar; o lote em voo se perde. Aceitável para runaway;
- **cuidadosa:** marcar `stopRequested` e cancelar na próxima mudança de `step_index` ou no próximo evento que não seja leitura. Espera o lote fechar, mas pode atrasar alguns segundos.

Começar pela simples; só implementar a cuidadosa se o teste mostrar que o lote perdido importa.

### 10.4 Aceite

| Critério | Esperado |
|---|---|
| Tarefa sintética de 50 leituras | para em N (ou no fim do lote) |
| Resultado | `partial: true`, `stop_reason: "read_budget"` |
| Reinício | no máximo 1 |
| Loop | não existe |
| Default | desligado; só com `action: "stop"` |
| Kill switch | `AGY_READ_BUDGET_ENFORCE=0` |

### 10.5 Como testar

`agy` falso que emite 50 `read_file` e depois um `result`. Rodar com `max_reads=10`; conferir que o resultado é parcial, com motivo, e que não houve segundo reinício. Repetir com um lote de 10 leituras no mesmo `step_index` para validar a opção cuidadosa.

---

## 11. O que não trazer

| Item do router | Por que não |
|---|---|
| Taxonomia `@fast/@medium/@heavy` | Duplica a orquestração do Claude/DSH; o pai já decide |
| Multi-phase decompose | Idem; adiciona prompt e complexidade |
| `/annotate-plan` | O prompt noturno já é estruturado; não precisa de tags |
| Executor, roles, leases | Um produto inteiro; não temos subagentes nativos do OpenCode |
| Enforcement/verification | O bridge já tem `verify_command`; não precisamos do pipeline |
| Effort bump | Conflita com a regra fixa: principal `medium`, Gemini `high` |
| Fallback entre providers | O nosso é melhor: reativo a crédito e em código, não instrução de prompt |
| TUI/cost doctor | Não há UI; o custo real é crédito, não token |
| Copiar código GPL-3.0 | Referência apenas; copiar tem implicação de licença |

---

## 12. Ordem, esforço e portões

| Ordem | Melhoria | Arquivo principal | Esforço | Portão |
|---:|---|---|---|---|
| 0 | Mosaicos no prompt | prompt do `capo_0265` | baixo | 57/57 e ≤70 leituras |
| 1 | Telemetria de leitura | `agy-mcp/server.mjs` | médio | replay 231/230/1 |
| 1b | Estado vivo do DSH | `dsh-acp-mcp/server.mjs` | baixo | `elapsed` cresce em 5 s |
| 1c | Congelar `elapsed` | ambos | baixo | turno congela; `idle` separado |
| 2 | Catálogo | `agy-mcp/server.mjs` | baixo | aviso sem crash |
| 3 | Placar | `agy-mcp/server.mjs` | baixo | 2 linhas, 0600 |
| 4 | Orçamento (aviso) | `agy-mcp/server.mjs` | médio | aviso em 80%/100% |
| 5 | Orçamento (parada) | `agy-mcp/server.mjs` | médio | parcial com motivo |

**Regra de ouro:** não implementar 5 antes de 0 e 1. Sem medir, o teto vira chute; sem os mosaicos, o teto só esconde o problema.

---

## 13. Harness de teste

### 13.1 Replay puro (sem abrir `agy`)

Para cada melhoria de contagem, extrair a lógica numa função pura e alimentá-la com um `.tools.jsonl` existente. O teste roda em milissegundos e não gasta crédito.

Casos de ouro:

| Arquivo | `read_file` | Distintos | Repetidos |
|---|---:|---:|---:|
| `60f4b1fc-…tools.jsonl` (`gtooe-4`) | 231 | 230 | 1 |
| `671d40cb-…tools.jsonl` (`gtooe-5`) | 224 | 222 | 2 |
| `6e28b639-…tools.jsonl` (`gtooe-6`) | 207 | 206 | 1 |

### 13.2 `agy` falso

Um script em `/tmp` (não commitado) que:

- responde a `agy models` com uma lista controlada;
- emite `init`, N `step_update` de `read_file` e um `result` com texto;
- opcionalmente emite um erro de crédito para testar o fallback.

Apontar `AGY_BIN` para ele e dirigir o bridge por JSON-RPC (MCP). Cenários:

1. 50 leituras → testa o teto;
2. lote de 10 leituras no mesmo `step_index` → testa o corte no lote;
3. erro de crédito → testa o fallback e o placar;
4. lista sem o modelo principal → testa o catálogo;
5. turno de 60 s → testa o estado vivo e o congelamento.

### 13.3 Comandos de aceite (para rodar na época)

```bash
# 1. sintaxe
node --check agy-mcp/server.mjs

# 2. baseline de leitura
python3 - <<'PY'
# usar o read_stats acima em cada .tools.jsonl
PY

# 3. catálogo
time agy models

# 4. mosaicos
ls data/saida/maos/capo_0265/mosaicos | wc -l   # 19
file data/saida/maos/capo_0265/mosaicos/m00.jpg # 1920x810

# 5. estado do DSH
# iniciar um turno e ler o JSON duas vezes com 5 s de diferença
```

### 13.4 Critério de não-regressão

Antes de cada merge:

- `node --check` nos dois bridges;
- replay dos três logs com os números da tabela;
- uma passada real do `capo_0265` (ou um lote pequeno) comparada ao `consenso.json`;
- `git status` limpo;
- um commit por melhoria, com o arquivo adicionado por nome.

---

## 14. Perguntas abertas

1. **O pai vai agir sobre o aviso de leitura?** Se o Claude/DSH ignorar o `hint`, o “advise” não resolve; precisa de um teste com o pai real antes de investir no “enforce”.
2. **A resolução do mosaico basta?** Testar 5 vídeos ambíguos (incluindo os 4 `nao_visivel`) e comparar com os quadros individuais. Se não bastar, o alvo conservador de 70 leituras sobe.
3. **`agy_stats` como tool ou status?** Começar no status; só criar tool se o pai precisar consultar.
4. **DSH e `agy` no mesmo commit?** Não. São bridges diferentes; commits separados.
5. **`agy models` é offline-safe?** O cache de 24 h resolve o caso normal; se a rede falhar, manter o cache antigo e avisar, sem bloquear.
6. **Licença:** o router é GPL-3.0. Usar como referência é ok; copiar trechos para o nosso repo merece uma decisão consciente.

---

## Apêndice A — dados brutos

### A.1 Sessões

| Sessão | `conversation_id` | `read_file` | Distintos | Repetidos | Ferramentas | Janela | Estado final |
|---|---|---:|---:|---:|---:|---:|---:|
| `gtooe-4` | `60f4b1fc-8bdb-469d-ad02-b2bf37082253` | 231 | 230 | 1 | 246 | 29m08s | 3592 s |
| `gtooe-5` | `671d40cb-bcd4-496d-a3ad-2fa530461d7c` | 224 | 222 | 2 | 249 | 23m04s | 3224 s |
| `gtooe-6` | `6e28b639-a7ab-4f1b-ac32-2104c0b5040e` | 207 | 206 | 1 | 233 | 21m42s | 3139 s |

### A.2 Mosaicos

- 19 arquivos, `m00.jpg`–`m18.jpg`;
- 1920×810; 3 vídeos × 4 quadros por folha;
- 480×270 por quadro; 5,4 MB no total;
- 57 vídeos, 4 instantes (3, 8, 30, 60 s) = 228 quadros.

### A.3 Catálogo

- `agy models`: 13 IDs, 2,17 s;
- inclui Argon (low/medium/high), Flash (low/medium/high), Opus (low/medium/high), principal (low/medium/high) e GPT-OSS 120B.

---

## Apêndice B — schemas propostos

### B.1 `read_stats`

```json
{
  "read_only_calls": 0,
  "distinct_paths": 0,
  "repeated_reads": 0,
  "by_tool": {},
  "first_read_at": null,
  "last_read_at": null,
  "last_path": null
}
```

### B.2 `model_catalog`

```json
{
  "checked_at": "2026-11-06T12:00:00.000Z",
  "count": 13,
  "missing": [],
  "strict": false
}
```

### B.3 `stats.jsonl`

```json
{
  "time": "2026-11-06T12:00:00.000Z",
  "session_id": "gtooe-7",
  "conversation_id": "…",
  "model": "…",
  "model_requested": "auto",
  "used_fallback": false,
  "status": "idle",
  "turn_elapsed_seconds": 1792,
  "output_chars": 3963,
  "tool_calls": 246,
  "credit_error": null
}
```

### B.4 `read_budget`

```json
{
  "max_reads": 40,
  "max_repeats": 2,
  "action": "warn"
}
```

---

## Apêndice C — mapa de código

Números de linha aproximados, conferidos em 2026-11-06; usar os nomes de função se o arquivo mudar.

### C.1 `agy-mcp/server.mjs`

| Função / bloco | Linha aprox. | Uso futuro |
|---|---:|---|
| `normalizeProfile` | 160 | validar `read_budget` |
| `applyProfilePrompt` | 178 | injetar a cláusula de leitura |
| `buildSpawn` | 222 | não mexer (bwrap) |
| `class AgySession` | 284 | estado e contadores |
| `onMessage` | 389 | contar leituras |
| `tryCreditFallback` | 509 | fallback por crédito |
| `writeState` | 566 | publicar estado |
| `scheduleStateWrite` | 586 | throttle de 2 s |
| `recordTool` | 615 | log de ferramentas |
| `toolSummary` | 630 | modelo para `readStats` |
| `finishTurn` | 657 | congelar `turn_elapsed` e gravar placar |
| `startTurn` | 686 | zerar contadores do turno |
| `basePayload` | 736 | publicar `read_stats` |
| `statusPayload` | 770 | publicar `read_budget` |
| `normalizeModel` | 854 | famílias e níveis fixos |
| `PROFILE_SCHEMA` | 1345 | adicionar `read_budget` |
| `TOOLS` | 1356 | eventual `agy_stats` |

### C.2 `dsh-acp-mcp/server.mjs`

| Função / bloco | Linha aprox. | Uso futuro |
|---|---:|---|
| `class AcpSession` | 319 | estado e contadores |
| `onMessage` | 466 | contar ferramentas |
| `writeState` | 571 | estado |
| `recordTool` | 599 | log + `scheduleStateWrite` |
| `toolSummary` | 614 | modelo para `readStats` |
| `finishTurn` | 664 | congelar `turn_elapsed` |
| `prompt` | 753 | estado vivo |
| `waitForTurn` | 799 | leitura do estado |
| `basePayload` | 818 | publicar `read_stats` |
| `close` | 883 | limpar timer |

---

## Apêndice D — aceites já verificados (2026-11-06)

| # | Teste | Resultado | Observação |
|---:|---|---|---|
| 1 | Contagem de leitura das 3 passadas | ✅ | 231/230/1, 224/222/2, 207/206/1 |
| 2 | Mosaicos | ✅ | 19 arquivos, 1920×810, 5,4 MB |
| 3 | `agy models` | ✅ | 13 IDs, 2,17 s |
| 4 | Campos dos eventos | ✅ | `tool_name`, `state`, `paths`, `parameters`, `output_chars` |
| 5 | Estado do DSH | ✅ (estático) | sem `scheduleStateWrite`; teste ao vivo pendente |
| 6 | `elapsed` após o turno | ✅ (confirmado) | 3592 s vs turno ~1792 s |
| 7 | Regex de família | ✅ (após correção) | `[0-9.]+` falhou em `5-5`; `[0-9][0-9.-]*?` passou |
| 8 | Replay de teto 40 | ✅ (aritmética) | dispara em 1m43s, economiza 94%, mas deixa 17/57 sem leitura |
| 9 | Placar simulado | ✅ (schema) | 6 sessões `gtooe-*`, todas no fallback; mediana de estado 3181,5 s (não usar como turno) |

**O que ainda não foi testado (e só faz sentido depois de implementar):**

- estado vivo do DSH com turno real;
- aviso de orçamento com o pai real;
- parada com resultado parcial;
- cache de catálogo com `agy` falso;
- placar após reinício;
- passada real com mosaicos (o teste que mais importa).

---

## Problema em aberto (não aprovado): opção 3 — sessão única no `dsh web` ou observer upstream

**Registrado em 2026-11-07. Isto é um problema de arquitetura em aberto, não uma
tarefa aprovada; não implementar sem decisão explícita do dono.**

O `dsh web` não é leitor passivo: ao abrir uma sessão ele chama `agents.resume` e
exige o `flock` exclusivo de `session.lock`. O processo ACP segura esse lock
enquanto vive, mesmo idle, então a GUI recebe `session/writer-held` e mostra
`error.sessionInUse`. A alternativa atual é o **visor-dsh** (plugin do profile
`web`): ele lê `session.v4.jsonl.zstd` e mostra os turnos na GUI sem tocar no
lock, mas é um paliativo *downstream* — depende do log persistido e não é o modo
observador de primeira classe que a GUI precisa.

Duas saídas possíveis, ainda não escolhidas:

1. **Rodar as sessões dentro do `dsh web` e o Claude falar por API.** O bridge
   ACP deixaria de ser o dono do processo/sessão; o Claude chamaria a API do DSH
   web. Elimina a disputa de lock, mas muda o modelo de execução, autenticação,
   ciclo de vida e o contrato do bridge.
2. **Modo observer upstream usando `sessionQuery.observeSession`.** Expor na GUI
   uma leitura explícita de sessões possuídas por outro processo, apoiada em
   `sessionQuery.observeSession`/`observeEvent`/`observeProjections` e em um
   contrato de acompanhamento de log entre processos. Precisa definir
   propriedade, latência, autorização, paginação, reconciliação de `seq` e o que
   fazer quando o writer está no meio de um frame.

O visor-dsh atual não decide essa questão: ele é somente leitura, não fala ACP e
não substitui o observer upstream. A decisão de produto/arquitetura continua
aberta.
