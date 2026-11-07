# AGENTS.md — dsh-acp-claude-code

## Escopo deste agente

Este repositório é a fonte das ferramentas que conectam o **Claude Code Desktop** ao
**DeepSeek** e ao **Antigravity (agy)**. Quem trabalha aqui é responsável por:

1. **`dsh-acp`** — bridge MCP (stdio) que abre e retoma sessões do DeepSeek Harness via ACP.
2. **`agy-mcp`** — bridge MCP do Antigravity/Gemini, read-only via `bwrap`.
3. **Instalação e manutenção do Claude Code Desktop** — apenas quando o dono pedir.

Nada além disso. Em especial: **não** trabalhar no `~/Projects/chorinho-dataset`; aquele
projeto tem o seu próprio agente.

## Nada de tarefa de fundo

- **Não há tarefa de fundo.** Ninguém acompanha, retoma ou "vigia" sessão por conta própria.
- Sem polling, sem vigia, sem laço de espera. Esperar só quando o dono pedir para esperar.
- Sessões que o Claude Code abre (por exemplo a tarefa do `chorinho-dataset`) são de outro
  agente: não retomar, não relatar, não editar os arquivos dela.
- Não implementar o que está em `agy-mcp/MELHORIAS_FUTURAS.md` sem pedido explícito.

## Onde as coisas vivem

| Caminho | O que é |
|---|---|
| `dsh-acp/server.mjs` | fonte do bridge DeepSeek (ACP) |
| `agy-mcp/server.mjs` | fonte do bridge Antigravity |
| `~/.local/share/dsh-acp-mcp/` | cópia instalada do bridge DeepSeek + `acp-overlay.yml` |
| `~/.local/share/agy-mcp/` | cópia instalada do bridge Antigravity |
| `~/.dsh/profiles/acp/` | profile do DSH usado pelo ACP |

Ao mudar um `server.mjs` do repo, a cópia instalada precisa ser sincronizada — os dois
caminhos são independentes.

## Idioma e segredos

- Responder em **português**.
- **Nunca** expor chaves, tokens ou credenciais, nem em logs nem em arquivos.

## Commits

- **Sempre faça commits** das alterações: um commit por tarefa, adicionando os
  arquivos por nome (nunca `git add -A`).
- Não deixe `git status` sujo ao terminar um trabalho.
- Se o repositório tiver remoto configurado, faça `push` depois dos commits.
