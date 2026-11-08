# visor-dsh — visor e controle local de sessões do DSH na GUI

Plugins do **profile `web`** do DeepSeek Harness para acompanhar sessões
persistidas do DSH dentro da GUI. O visor é read-only; o controle
(cancelar/retomar) é um plugin companheiro que fala com o shim do `dsh-acp`
por um socket local. Nada disso disputa o `session.lock` diretamente.

Não é um processo separado e não é um iframe: a página é React, registrada no
slot `main` com uma entrada em `sidebar.panellist`. Os plugins usam os serviços
do `webServer`/`connection` que já estão no `dsh web`.

## Como usar

1. Abra/atualize a GUI já existente: <http://192.168.2.164:3080>.
2. Clique no ícone de olho **“Visor de sessões”** na barra lateral esquerda.
3. O filtro **“Só dono externo: dsh acp”** vem marcado: a lista mostra apenas
   sessões cujo lock está com um processo `dsh acp` (externo a este `dsh web`).
   Desmarque para ver todas as sessões persistidas.
4. Escolha uma sessão. O cabeçalho mostra `Ao vivo`/`Parado` e o dono
   (`Dono externo: dsh acp (PID ...)` ou `Dono: este dsh web`).
5. Na sessão selecionada aparecem os controles **Cancelar turno** e
   **Retomar** (veja abaixo).

A página atualiza sozinha a cada **1 s**; a lista, a cada **5 s**. Não há timer
fora da aba.

> Se o ícone/controles ainda não aparecerem, recarregue a página uma vez (F5).
> A instalação de um bundle novo é aplicada ao profile, mas o módulo Client pode
> precisar de um reload do documento.

## Instalação/manutenção

Dois bundles locais deste repositório:

```text
/var/home/gabriel/Projects/dsh-acp-claude-code/visor-dsh
/var/home/gabriel/Projects/dsh-acp-claude-code/visor-control
```

Para (re)instalar no profile `web` com `plugin_manager`:

```text
plugin_manager action=install_bundle target=/var/home/gabriel/Projects/dsh-acp-claude-code/visor-dsh
plugin_manager action=install_bundle target=/var/home/gabriel/Projects/dsh-acp-claude-code/visor-control
```

Os pacotes não têm dependências npm, build script ou pós-instalação. O
`client.js` é JavaScript puro carregado pelo module loader do Harness; React vem
do próprio Host Client.

## Filtro “Só dono externo: dsh acp”

O campo `owner` vem do scan de `/proc/*/fd` do Host. O filtro exige um dono com
`label === "dsh acp"` e `pid !== hostPid` (o PID do `dsh web`), ou seja, o ACP
está segurando o lock, não o próprio web. Sessões já fechadas, sem dono, não
aparecem com o filtro marcado — desmarque para selecioná-las e usar **Retomar**.

## Controle (cancel/retomar)

O plugin `@local/dsh-visor-control` é opcional e separado do visor. Ele expõe
duas rotas locais autenticadas:

| Rota | Uso |
|---|---|
| `GET /api/visor/control` | shims `dsh-acp` vivos, sessões controláveis e disponibilidade |
| `POST /api/visor/control` | `{action:"cancel", dsh_session_id}` ou `{action:"resume", dsh_session_id, cwd, prompt, mode?}` |

O caminho real é:

1. Cada shim `dsh-acp` (o do Claude Code ou um iniciado pelo viewer) publica um
   Unix socket `0600` em `~/.local/state/dsh-acp-mcp/control/shim-<pid>.sock` e
   um registro `shim-<pid>.json`.
2. O plugin de controle descobre os shims, fala JSONL no socket e chama as
   **funções do próprio `dsh-acp`**:
   - `cancel` → a mesma lógica de `deepseek_cancel`: notifica ACP
     `session/cancel`, espera o agente parar e devolve a saída parcial.
   - `resume` → se a sessão está viva e idle, manda a mensagem (equivalente a
     `deepseek_send`); se está fechada, sobe um shim para o `cwd` da sessão e usa
     a lógica de `deepseek_resume`.
3. Se não existe shim para o `cwd`, o plugin de controle inicia um shim filho do
   processo do `dsh web` com `DSH_ACP_WORKSPACE` igual ao diretório da sessão.
   O shim monitora o processo pai e se encerra se o `dsh web` morrer, para não
   deixar ACP/lock órfãos.

**Cancelar** só fica habilitado quando o shim de controle reporta a sessão como
`busy` (um turno em voo). **Retomar** fica habilitado quando a sessão está idle
ou fechada; se o ACP já estiver dono por uma ponte antiga/sem canal, a ação
devolve o erro de lock e nada é forçado.

Um cancelamento do ACP grava `turn/end` com `reason.kind = "aborted"` e
`reason.reason.kind = "user"`; a UI mostra **“abortado (user)”**. Se o turno foi
encerrado antes de o `user/message`/`assistant/message` ser gravado, ele fica
vazio no log; a timeline omite esses turnos vazios e mostra uma nota. Nada foi
apagado pelo visor.

### Estado nesta máquina

O shim ACP anterior (sessão `576232c7…`, `acp_pid=122217`, `shim_pid=8620`)
fechou naturalmente em **2026-11-08 13:14**, antes do restart. Não havia ACP vivo
para interromper. O servidor `dsh-acp` instalado já tem o canal de controle; o
próximo shim que o Claude Code iniciar também o publica. Para retomar aquela
sessão fechada agora, desmarque o filtro, selecione `576232c7…`, escreva um
prompt e clique em **Retomar**: o viewer sobe um shim de controle para
`/var/home/gabriel/Projects/chorinho-dataset`.

O canal é local, `0600`, sob diretório `0700`; não é HTTP, não é exposto na rede
e não usa token. As rotas do plugin passam por
`ctx.connection.requestRejection(req)` (cookie de browser/API e fence de
Host/Origin) e exigem o cabeçalho `x-visor-control: 1` + JSON no POST. O visor
não chama `agents.resume` nem fala ACP diretamente: quem faz isso é o shim do
`dsh-acp`, via `deepseek_resume`/`deepseek_cancel`.

## O que o visor lê

| Caminho | Uso |
|---|---|
| `<DSH_HOME>/sessions/*/*/session.v4.jsonl.zstd` | log append-only, concatenação de frames zstd; lido com `ZSTD_e_flush` para tolerar o último frame em escrita |
| `<sessão>/session.lock` | **somente `stat`** para saber se o arquivo existe; nunca é aberto nem travado |
| `/proc/<pid>/fd/*` | `readlink` para descobrir qual PID tem o lock aberto (dono informativo) |
| `/proc/<pid>/comm` e `/proc/<pid>/cmdline` | rótulo curto do dono (`dsh web`, `dsh acp`, `node`, …); a linha de comando não é exibida |

O plugin de controle lê apenas `~/.local/state/dsh-acp-mcp/control/*.json` e o
Unix socket do shim; ele não lê o lock.

A reconciliação é feita por `seq`: o leitor guarda o maior `seq` já renderizado e
só transforma eventos novos. O prefixo inteiro é redecodificado quando
tamanho/mtime/inode mudam. Linhas JSON incompletas ou quebradas são ignoradas
até a próxima leitura; um frame truncado devolve o prefixo decodificável.

O `cwd` do cabeçalho `session` é a fonte autoritativa. O nome do diretório de
projeto (`--var-home-...--`) é ambíguo porque todo `-` vira `/`; por isso a lista
mostra o valor decodificado do diretório e, depois que a sessão é lida, o `cwd`
real do cabeçalho substitui o rótulo.

## O que ele **não** faz

- O visor (página `main`) **não abre, cria, trava ou apaga `session.lock`** e
  **não fala ACP**. O plugin de controle também não abre o lock diretamente: ele
  pede ao shim `dsh-acp`, que já é o dono legítimo do lock.
- **Não chama `agents.resume` nem `session/load` do Harness web.** O caminho de
  retomada é o `deepseek_resume` do projeto `dsh-acp`, que sobe um processo ACP.
- **Não escreve em `~/.dsh/sessions/`** (nem cache, nem índice, nem `.lock`
  próprio) e não cria um lock de controle. O estado de controle é o socket/
  registro em `~/.local/state/dsh-acp-mcp/`.
- **Não mata** o `dsh web` nem reinicia o servidor web; o shim de controle só
  encerra o próprio filho ACP quando o plugin/processo pai termina.
- Não usa dependências externas, CDN, iframe ou segundo servidor HTTP.
- Não renderiza o stream de tokens em memória de outro processo: a fonte é o log
  persistido, então a latência é a do flush do writer + até 1 s de poll.

## API interna (mesma origem, autenticada)

As rotas são registradas no `webServer` do Host e passam por
`ctx.connection.requestRejection(req)` (cookie de browser/API e fence de
Host/Origin). Não há CORS.

| Rota | Resposta |
|---|---|
| `GET /api/visor/sessions` | catálogo: `root`, `hostPid`, `sessions[]` com `id`, `cwd`, `cwdFromDir`, `hasLog`, `logSize`, `logMtimeMs`, `owner`, `live` |
| `GET /api/visor/session?id=<uuid>` | snapshot completo: `meta`, `items[]`, `reset: true` |
| `GET /api/visor/session?id=<uuid>&afterSeq=<n>&gen=<n>` | apenas itens com `seq > n`; `reset` vira `true` se o arquivo foi substituído, truncado para um estado incompatível ou a `generation` mudou |
| `GET /api/visor/control` | disponibilidade, shims e sessões controláveis |
| `POST /api/visor/control` | `cancel`/`resume`; exige `content-type: application/json` e `x-visor-control: 1` |

Itens renderizáveis: `turn_start`, `user`, `assistant` (texto + raciocínio),
`tool_call`, `tool_result`, `step`, `turn_end` e `title`. `turn/end` leva
`reasonKind` (`completed`, `interrupted`, `aborted`, `error`) e um detalhe legível.

## Testes

```bash
cd /var/home/gabriel/Projects/dsh-acp-claude-code/visor-dsh
node --test test/*.test.mjs

cd /var/home/gabriel/Projects/dsh-acp-claude-code/visor-control
node --test test/*.test.mjs
```

Os testes criam diretórios/cópias sintéticas em
`~/.local/state/visor-dsh/teste/` e os removem no fim; nunca escrevem em
`~/.dsh/sessions/`. O teste da sessão real é opcional e apenas lê o log e os
metadados do lock. O teste do controle sobe um shim real em workspace
temporário, mas não chama a API do modelo.

## Estrutura

| Arquivo | Papel |
|---|---|
| `visor-dsh/index.js` | Host do visor: rotas `/api/visor/*`, autenticação e cache de sessões |
| `visor-dsh/host/decode.mjs` | decode zstd tolerante, parse de linhas e descarte de JSON incompleto |
| `visor-dsh/host/store.mjs` | descoberta em `<DSH_HOME>/sessions/*/*/`, cache por sessão e reconciliação por `seq` |
| `visor-dsh/host/view.mjs` | transforma eventos em itens compactos (textos, ferramentas, turnos) |
| `visor-dsh/host/owner.mjs` | scan de `/proc/*/fd` para o dono do lock, sem abrir o lock |
| `visor-dsh/client.js` | página React (`main`), filtro ACP, controles e ícone (`sidebar.panellist`), poll de 1 s |
| `visor-control/index.js` | Host do controle: rotas `/api/visor/control` |
| `visor-control/lib/control.mjs` | descoberta de shims, socket JSONL e `cancel`/`resume` via `dsh-acp` |
| `dsh-acp/server.mjs` | shim ACP com o socket local de controle (lado que executa cancel/resume) |
| `locale/en.json`, `locale/pt.json` | títulos/descrições dos plugins no Plugin Manager |
| `icon.svg` | ícones dos bundles |

## Limites conhecidos

- Linux: a detecção de dono depende de `/proc`; em outros sistemas ela é
  informativa e pode ficar vazia.
- O decode completo é refeito quando o log muda; logs muito grandes podem custar
  alguns milissegundos por poll.
- A lista usa o nome do diretório como `cwd` até a sessão ser lida; caminhos com
  `-` no nome são ambíguos nessa codificação.
- O visor mostra eventos persistidos. Um evento que o writer ainda não
  materializou aparece na próxima leitura, não instantaneamente.
- Turnos encerrados sem nenhuma mensagem registrada (por exemplo, cancelados
  antes do `user/message`) são omitidos da timeline e resumidos numa nota no
  topo/rodapé. O log continua completo; turnos com `interrupted` ou `error` são
  sempre exibidos.
- O controle só alcança um shim `dsh-acp` que tenha o socket (versão sincronizada
  deste repo). Uma sessão viva em um shim antigo, sem socket, não é cancelável
  pelo viewer; o shim precisa ser reiniciado/reconectado para carregar o canal.
- Se o `dsh web` for encerrado à força, o shim de controle filho tem um watchdog
  de 5 s para fechar as sessões que ele mesmo abriu. Ainda assim, o normal é
  desligar/reiniciar o plugin pelo Plugin Manager.
