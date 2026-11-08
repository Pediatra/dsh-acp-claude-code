# visor-control — canal local de cancel/resume do visor

Plugin Host do **profile `web`** que dá ao [visor-dsh](../visor-dsh/README.md)
os botões **Cancelar turno** e **Retomar** sem falar ACP diretamente. Ele usa o
socket local publicado pelo shim `dsh-acp`, que por sua vez chama as funções do
projeto:

- `cancel` → a lógica de `deepseek_cancel` (`session/cancel`, saída parcial).
- `resume` → `deepseek_send` se a sessão estiver viva e idle, ou
  `deepseek_resume` (novo processo ACP) se estiver fechada.

O plugin do visor continua read-only; este é o único componente que pode pedir
uma ação de escrita/controle, e só pelo socket `0600` do shim.

## Rotas

| Rota | Uso |
|---|---|
| `GET /api/visor/control` | `{available, shims, live}`; shims vivos e sessões controláveis |
| `POST /api/visor/control` | `cancel` ou `resume`; exige `content-type: application/json` e `x-visor-control: 1` |

As rotas usam `ctx.connection.requestRejection(req)` (cookie de browser/API e
fence de Host/Origin), não têm CORS e respondem `no-store`.

## Descoberta e spawn

Cada shim `dsh-acp` grava, sob `~/.local/state/dsh-acp-mcp/control/`:

```text
shim-<pid>.json   # {pid, socket, workspace, started_at}
shim-<pid>.sock   # socket Unix 0600
```

O control manager:

1. descobre os shims vivos pelo diretório de controle;
2. fala JSONL no socket (`{id, action, ...}` → `{id, ok, result|error}`);
3. para uma sessão fechada, inicia um shim filho do `dsh web` com
   `DSH_ACP_WORKSPACE` = cwd da sessão, espera o registro e chama `resume`;
4. encerra os shims que ele mesmo iniciou no unload do plugin. O shim também
   tem um watchdog de 5 s do processo pai.

O shim `dsh-acp` precisa estar com o código deste repositório sincronizado em
`~/.local/share/dsh-acp-mcp/server.mjs`. O arquivo de instalação é copiado por
`cp`; o pacote do controle não instala nem reinicia o shim.

## Testes

```bash
cd /var/home/gabriel/Projects/dsh-acp-claude-code/visor-control
node --test test/*.test.mjs
```

Os testes sobem um shim real em workspace temporário, falam o socket e testam as
rotas com um `ctx` falso. Eles não chamam a API do modelo e não tocam em
`~/.dsh/sessions/`.

## Limites

- Uma sessão viva em um shim antigo (sem o socket) não é controlável; reinicie
  o shim/Claude Code para carregar o canal.
- Retomar uma sessão fechada exige o `cwd` original e sobe um processo ACP; isso
  toma o lock da sessão, como o `deepseek_resume` do projeto.
- O socket é local do usuário; não é HTTP e não deve ser exposto.
