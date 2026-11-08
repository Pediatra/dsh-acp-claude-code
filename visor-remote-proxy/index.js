/**
 * Proxy loopback entre o Tailscale Serve e o dsh web.
 *
 * Motivo: o `dsh web` valida Host e Origin contra `--trusted-host`. O Serve
 * termina TLS com o hostname do tailnet, então o Origin do browser é
 * `https://<host>.ts.net`, enquanto o Host pode chegar como o hostname do
 * tailnet. Este proxy escuta apenas em 127.0.0.1 e reescreve Host/Origin/
 * Referer/Sec-Fetch-Site para a autoridade LAN confiável antes de encaminhar
 * para 192.168.2.164:3080.
 *
 * Não expõe porta na LAN/internet e não adiciona autenticação própria: o
 * cookie/token do dsh web continuam valendo.
 */
import http from "node:http";
import net from "node:net";

const DEFAULT_UPSTREAM_HOST = "192.168.2.164";
const DEFAULT_UPSTREAM_PORT = 3080;
const DEFAULT_LISTEN_PORT = 3081;

/**
 * @param {{
 *   upstreamHost?: string,
 *   upstreamPort?: number,
 *   upstreamAuthority?: string,
 *   upstreamOrigin?: string,
 *   logger?: {warn?: (...args: unknown[]) => void},
 * }} [options]
 * @returns {import("node:http").Server}
 */
export function createProxyServer(options = {}) {
  const upstreamHost = options.upstreamHost ?? DEFAULT_UPSTREAM_HOST;
  const upstreamPort = options.upstreamPort ?? DEFAULT_UPSTREAM_PORT;
  const upstreamAuthority = options.upstreamAuthority ?? `${upstreamHost}:${upstreamPort}`;
  const upstreamOrigin = options.upstreamOrigin ?? `http://${upstreamAuthority}`;

  const server = http.createServer((req, res) => {
    const headers = rewriteHeaders(req.headers, upstreamAuthority, upstreamOrigin);
    const upstream = http.request({
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on("error", (error) => {
      options.logger?.warn?.(`visor-remote-proxy: upstream ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("upstream error");
    });
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(upstreamPort, upstreamHost, () => {
      const headers = rewriteHeaders(req.headers, upstreamAuthority, upstreamOrigin);
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${name}: ${item}`);
        } else {
          lines.push(`${name}: ${value}`);
        }
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  server.on("connect", (_req, socket) => {
    socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
  });

  return server;
}

/**
 * @param {import("node:http").IncomingHttpHeaders} raw
 * @param {string} authority
 * @param {string} origin
 * @returns {import("node:http").OutgoingHttpHeaders}
 */
function rewriteHeaders(raw, authority, origin) {
  const headers = { ...raw };
  headers.host = authority;
  if (headers.origin !== undefined) headers.origin = origin;
  if (headers.referer !== undefined) {
    try {
      const parsed = new URL(String(headers.referer));
      headers.referer = origin + parsed.pathname + parsed.search;
    } catch {
      headers.referer = origin + "/";
    }
  }
  if (headers["sec-fetch-site"] !== undefined) headers["sec-fetch-site"] = "same-origin";
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-proto"];
  return headers;
}

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 */
export function apply(ctx) {
  ctx.effect(() => {
    const server = createProxyServer({
      logger: {
        warn: (...args) => {
          try { ctx.logger?.warn?.(...args); } catch {}
        },
      },
    });
    server.on("error", (error) => {
      try { ctx.logger?.warn?.(`visor-remote-proxy: ${error.message}`); } catch {}
    });
    server.listen(DEFAULT_LISTEN_PORT, "127.0.0.1");
    return () => {
      try { server.close(); } catch {}
    };
  }, "visor-remote-proxy: loopback listener");
}
