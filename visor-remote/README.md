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

## Uso

1. Habilite **Tailscale Serve** no tailnet (aprovação no admin do Tailscale).
2. No host: `tailscale serve --bg http://192.168.2.164:3080`.
3. No browser da LAN: <http://192.168.2.164:3080/api/remote-url>.
4. Copie o link e abra no celular com Tailscale ligado.

A página não é cacheada, não usa CDN e não registra o token. Ela é
autenticada por `ctx.connection.requestRejection`; sem o cookie do browser ela
responde 401. O link contém um token de processo: não compartilhe; se o
`dsh web` reiniciar, gere outro.

## Teste

```bash
cd /var/home/gabriel/Projects/dsh-acp-claude-code/visor-remote
node --test test/*.test.mjs
```

O teste usa um `ctx` falso e um token fictício; não toca no Tailscale real.
