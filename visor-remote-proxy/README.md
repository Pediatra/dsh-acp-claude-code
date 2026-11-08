# visor-remote-proxy — Host/Origin do Tailscale Serve para o dsh web

O `dsh web` valida `Host` e `Origin` contra `--trusted-host`. O Tailscale Serve
termina TLS no hostname do tailnet e encaminha para o backend; se o `Host`/`Origin`
chegarem como `https://<host>.ts.net`, o web responde 403.

Este plugin Host sobe um proxy **somente em `127.0.0.1:3081`** que:

1. recebe do Tailscale Serve;
2. reescreve `Host`, `Origin`, `Referer` e `Sec-Fetch-Site` para
   `192.168.2.164:3080` (a autoridade LAN confiável);
3. encaminha HTTP e WebSocket para `192.168.2.164:3080`.

O cookie/token do DSH continua sendo exigido; o proxy não adiciona autenticação
e não abre porta na LAN. O Tailscale Serve deve apontar para
`http://127.0.0.1:3081` (e não diretamente para 3080):

```bash
tailscale serve --bg http://127.0.0.1:3081
```

Depois use o link gerado por `/api/remote-url` no browser da LAN e abra no
celular com o Tailscale ligado.

## Teste

```bash
cd /var/home/gabriel/Projects/dsh-acp-claude-code/visor-remote-proxy
node --test test/*.test.mjs
```

O teste usa um upstream HTTP falso e verifica Host/Origin reescritos, HTTP e
upgrade WebSocket.
