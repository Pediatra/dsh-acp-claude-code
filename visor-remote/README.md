# visor-remote — link autenticado para o celular

Plugin Host do **profile `web`** que serve uma página autenticada em
`/api/remote-url`. Ela descobre o nome DNS do Tailscale (`tailscale status
--json`) e usa `ctx.connection.authenticatedUrl` para gerar
`https://<host>.ts.net/?token=...` com o token de launch **deste processo** do
`dsh web`.

O token fica na memória do processo; sem esta rota não há como recuperá-lo para
um segundo dispositivo sem reiniciar o web. A página é acessada no browser da
LAN (já autenticado) e o link é copiado para o celular, que precisa estar com o
Tailscale ligado.

O Serve **não** aponta direto para 3080: o `dsh web` valida Host/Origin contra
`--trusted-host` e rejeitaria o hostname do tailnet. O plugin
[`visor-remote-proxy`](../visor-remote-proxy/README.md) escuta só em
`127.0.0.1:3081`, reescreve Host/Origin/Referer para `192.168.2.164:3080` e
encaminha HTTP e WebSocket.

## Uso

1. Habilite **Tailscale Serve** no tailnet (aprovação no admin do Tailscale).
2. Instale o plugin `@local/dsh-visor-remote-proxy` (proxy loopback
   `127.0.0.1:3081`) no profile `web`; ele reescreve Host/Origin para a
   autoridade LAN confiável.
3. No host: `tailscale serve --bg http://127.0.0.1:3081`.
4. No browser da LAN: <http://192.168.2.164:3080/api/remote-url>.
5. Escaneie o QR com a câmera do celular (abre o link autenticado direto no
   navegador) ou copie o link para o Chrome/Samsung Internet. O celular precisa
   estar com o Tailscale ligado.

A página não é cacheada, não usa CDN e não registra o token. O QR é gerado no
Host (`qrcode-generator`) e embutido como SVG inline; nada é enviado a
terceiros. Ela é autenticada por `ctx.connection.requestRejection`; sem o
cookie do browser ela responde 401. O botão de copiar tem fallback para
`document.execCommand("copy")`, porque a Clipboard API não existe em HTTP na
LAN. O link contém um token de processo: não compartilhe; se o `dsh web`
reiniciar, gere outro.

## Teste

```bash
cd /var/home/gabriel/Projects/dsh-acp-claude-code/visor-remote
node --test test/*.test.mjs
```

O teste usa um `ctx` falso e um token fictício; não toca no Tailscale real.
