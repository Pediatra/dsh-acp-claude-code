#!/usr/bin/env bash
# Instala o DSH num prefixo estável (não no cache efêmero do npx) e publica
# ~/.local/bin/dsh. O shim procura esse caminho primeiro.
set -euo pipefail

VERSION="${1:-0.2.2-alpha.3}"
PREFIX="${DSH_STABLE_PREFIX:-$HOME/.local/share/dsh-stable}"
NPM="${DSH_NPM:-$HOME/.local/share/dsh-acp-mcp/node/bin/npm}"
if [[ ! -x "$NPM" ]]; then
  NPM="npm"
fi

mkdir -p "$PREFIX" "$HOME/.local/bin"
"$NPM" install --prefix "$PREFIX" --no-audit --no-fund "@deepseek-ai/dsh@$VERSION"
ln -sf "$PREFIX/node_modules/.bin/dsh" "$HOME/.local/bin/dsh"
"$HOME/.local/bin/dsh" --version
