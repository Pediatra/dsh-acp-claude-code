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

## Cookie de sessão em navegação cross-site

O `dsh web` vê HTTP (o Serve termina TLS) e emite o cookie `dsh-auth-*` com
`SameSite=Strict` e sem `Secure`. Quando o link com `?token=` vem de outro app
(QR/câmera, WhatsApp, Telegram), o Chrome grava o cookie no 303, mas **não o
envia** no redirect para `/` — o dsh web responde o 401 “authentication
required”. Reproduzido em Chrome headless: navegação cross-site com Strict
resulta em 401; o cookie existe, mas é retido.

O proxy reescreve **somente** os cookies `dsh-auth-*` para `SameSite=Lax;
Secure`. O token continua obrigatório para emitir o cookie, e `Lax` ainda
bloqueia POST cross-site. Navegação direta (link colado na barra) continua
funcionando.

Depois use o link gerado por `/api/remote-url` no browser da LAN e abra no
celular com o Tailscale ligado.

## Teste

```bash
cd /var/home/gabriel/Projects/dsh-acp-claude-code/visor-remote-proxy
node --test test/*.test.mjs
```

O teste usa um upstream HTTP falso e verifica Host/Origin reescritos, HTTP,
upgrade WebSocket e a relaxação do cookie de auth.
