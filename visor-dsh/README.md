# visor-dsh — visor read-only de sessões do DSH na GUI

Plugin do **profile `web`** do DeepSeek Harness que adiciona uma página de leitura
das sessões persistidas do DSH. Ele existe para acompanhar uma sessão que o
bridge ACP do Claude Code mantém aberta **sem disputar o `session.lock`**.

Não é um processo separado e não é um iframe: a página é React, registrada no
slot `main` com uma entrada em `sidebar.panellist`. O Host do plugin usa o
`webServer` que já está rodando no `dsh web`.

## Como usar

1. Abra/atualize a GUI já existente: <http://192.168.2.164:3080>.
2. Clique no ícone de olho **“Visor de sessões”** na barra lateral esquerda.
3. Escolha uma sessão na lista da esquerda. A lista ordena por mtime do log e
   mostra diretório decodificado, uuid, tamanho, mtime e dono do lock.

A página atualiza sozinha a cada **1 s** enquanto estiver aberta. A lista de
sessões é atualizada a cada **5 s**. Não há processo, timer ou job do agente
rodando fora da aba.

> Se o ícone ainda não aparecer, recarregue a página uma vez (F5). A instalação
> de um bundle novo é aplicada ao profile, mas o módulo Client pode precisar de
> um reload do documento.

## Instalação/manutenção

O bundle é um pacote local deste repositório:

```text
/var/home/gabriel/Projects/dsh-acp-claude-code/visor-dsh
```

Para (re)instalar no profile `web` a partir de uma sessão de agente com
`plugin_manager`:

```text
plugin_manager action=install_bundle target=/var/home/gabriel/Projects/dsh-acp-claude-code/visor-dsh
```

O pacote não tem dependências npm, build script ou pós-instalação. O `client.js`
é JavaScript puro carregado pelo module loader do Harness; React vem do próprio
Host Client.

## O que ele lê

| Caminho | Uso |
|---|---|
| `<DSH_HOME>/sessions/*/*/session.v4.jsonl.zstd` | log append-only, concatenação de frames zstd; lido com `ZSTD_e_flush` para tolerar o último frame em escrita |
| `<sessão>/session.lock` | **somente `stat`** para saber se o arquivo existe; nunca é aberto nem travado |
| `/proc/<pid>/fd/*` | `readlink` para descobrir qual PID tem o lock aberto (dono informativo) |
| `/proc/<pid>/comm` e `/proc/<pid>/cmdline` | rótulo curto do dono (`dsh web`, `dsh acp`, `node`, …); a linha de comando não é exibida |

A reconciliação é feita por `seq`: o leitor guarda o maior `seq` já renderizado e
só transforma eventos novos. O prefixo inteiro é redecodificado quando
tamanho/mtime/inode mudam. Linhas JSON incompletas ou quebradas são ignoradas
até a próxima leitura; um frame truncado devolve o prefixo decodificável.

O `cwd` do cabeçalho `session` é a fonte autoritativa. O nome do diretório de
projeto (`--var-home-...--`) é ambíguo porque todo `-` vira `/`; por isso a lista
mostra o valor decodificado do diretório e, depois que a sessão é lida, o `cwd`
real do cabeçalho substitui o rótulo.

## O que ele **não** faz

- **Não abre, cria, trava ou apaga `session.lock`.** Não há `flock`, `O_EXCL` ou
  qualquer aquisição de lock neste diretório.
- **Não chama ACP**, `agents.resume`, `deepseek_resume`, `session/load` ou
  qualquer operação de retomada. Não conhece o bridge do Claude Code.
- **Não escreve em `~/.dsh/sessions/`** (nem cache, nem índice, nem `.lock`
  próprio). Não há estado persistido do visor; o único cache é em memória do
  processo Host.
- **Não mata** processos, não reinicia o `dsh web` e não interfere na sessão
  observada.
- Não usa dependências externas, CDN, iframe ou segundo servidor.
- Não renderiza o stream de tokens em memória de outro processo: a fonte é o log
  persistido, então a latência é a do flush do writer + até 1 s de poll.

## API interna (mesma origem, autenticada)

As rotas são registradas no `webServer` do Host e passam por
`ctx.connection.requestRejection(req)` (cookie de browser/API e fence de
Host/Origin). Não há CORS e o método é somente `GET`/`HEAD`.

| Rota | Resposta |
|---|---|
| `GET /api/visor/sessions` | catálogo: `root`, `hostPid`, `sessions[]` com `id`, `cwd`, `cwdFromDir`, `hasLog`, `logSize`, `logMtimeMs`, `owner`, `live` |
| `GET /api/visor/session?id=<uuid>` | snapshot completo: `meta`, `items[]`, `reset: true` |
| `GET /api/visor/session?id=<uuid>&afterSeq=<n>&gen=<n>` | apenas itens com `seq > n`; `reset` vira `true` se o arquivo foi substituído, truncado para um estado incompatível ou a `generation` mudou |

Itens renderizáveis: `turn_start`, `user`, `assistant` (texto + raciocínio),
`tool_call`, `tool_result`, `step`, `turn_end` e `title`. `turn/end` leva
`reasonKind` (`completed`, `interrupted`, `aborted`, `error`) e um detalhe legível.

## Testes

```bash
cd /var/home/gabriel/Projects/dsh-acp-claude-code/visor-dsh
node --test test/*.test.mjs
```

Os testes criam cópias sintéticas em `~/.local/state/visor-dsh/teste/` e as
removem no fim; nunca escrevem em `~/.dsh/sessions/`. O teste da sessão real é
opcional e apenas lê o log e os metadados do lock.

## Estrutura

| Arquivo | Papel |
|---|---|
| `index.js` | Host: rotas `/api/visor/*`, autenticação e cache de sessões |
| `host/decode.mjs` | decode zstd tolerante, parse de linhas e descarte de JSON incompleto |
| `host/store.mjs` | descoberta em `<DSH_HOME>/sessions/*/*/`, cache por sessão e reconciliação por `seq` |
| `host/view.mjs` | transforma eventos em itens compactos (textos, ferramentas, turnos) |
| `host/owner.mjs` | scan de `/proc/*/fd` para o dono do lock, sem abrir o lock |
| `client.js` | página React (`main`) e ícone (`sidebar.panellist`), poll de 1 s |
| `locale/en.json`, `locale/pt.json` | títulos/descrições do plugin no Plugin Manager |
| `icon.svg` | ícone do bundle |

## Limites conhecidos

- Linux: a detecção de dono depende de `/proc`; em outros sistemas ela é
  informativa e pode ficar vazia.
- O decode completo é refeito quando o log muda; logs muito grandes podem custar
  alguns milissegundos por poll.
- A lista usa o nome do diretório como `cwd` até a sessão ser lida; caminhos com
  `-` no nome são ambíguos nessa codificação.
- O visor mostra eventos persistidos. Um evento que o writer ainda não
  materializou aparece na próxima leitura, não instantaneamente.
