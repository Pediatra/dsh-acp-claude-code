/**
 * Metade Host do plugin `@local/dsh-visor-remote`.
 *
 * Serve uma página autenticada que gera um link com o token de launch deste
 * processo do dsh web para o endereço Tailscale Serve. O token fica na memória
 * do processo; esta rota é o único jeito de obtê-lo sem reiniciar o web.
 *
 * A página é servida na LAN (já autenticada pelo cookie do browser) e o link
 * gerado é aberto no celular com o Tailscale ligado. Nada é exposto na
 * internet.
 */
import { execFileSync } from "node:child_process";

export const inject = ["webServer", "connection"];

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/remote-url",
      handler: (req, res) => handle(req, res, ctx),
    }),
    "visor-remote: route /api/remote-url",
  );
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {import("@deepseek-ai/cordis").Context} ctx
 */
async function handle(req, res, ctx) {
  let rejection;
  try {
    rejection = ctx.connection.requestRejection(req);
  } catch {
    rejection = 403;
  }
  if (rejection !== undefined) {
    res.writeHead(rejection, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "content-length": String(Buffer.byteLength("Unauthorized")),
    });
    res.end("Unauthorized");
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end("Method Not Allowed");
    return;
  }

  try {
    const requestUrl = new URL(req.url ?? "/api/remote-url", "http://dsh.invalid");
    const base = requestUrl.searchParams.get("base") || discoverBase();
    const safeBase = validateBase(base);
    const authenticated = ctx.connection.authenticatedUrl(safeBase);
    const html = renderPage(safeBase, authenticated);
    const body = Buffer.from(html, "utf8");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      "content-length": String(body.byteLength),
    });
    if (req.method === "HEAD") res.end();
    else res.end(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = Number.isInteger(error?.status) ? error.status : 500;
    const body = Buffer.from(`Não foi possível gerar o link: ${message}\n`, "utf8");
    res.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "content-length": String(body.byteLength),
    });
    res.end(body);
  }
}

/** @returns {string} base HTTPS do Tailscale Serve para este host. */
function discoverBase() {
  let output;
  try {
    output = execFileSync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      timeout: 4_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error("Tailscale indisponível; passe ?base=https://seu-host.ts.net/");
  }
  const status = JSON.parse(output);
  const dnsName = status?.Self?.DNSName;
  if (typeof dnsName !== "string" || dnsName.length === 0) {
    throw new Error("DNSName do Tailscale não encontrado; passe ?base=https://seu-host.ts.net/");
  }
  return `https://${dnsName.replace(/\.$/u, "")}/`;
}

/**
 * @param {string} raw
 * @returns {string}
 */
function validateBase(raw) {
  const url = new URL(raw);
  const reject = (message) => {
    const error = new Error(message);
    error.status = 400;
    throw error;
  };
  if (url.protocol !== "https:") reject("a base precisa ser https://");
  if (url.username || url.password) reject("a base não pode ter credenciais");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    reject("a base precisa ser a raiz, sem query/hash");
  }
  if (!url.hostname.includes(".")) reject("hostname inválido");
  return url.href;
}

/**
 * @param {string} base
 * @param {string} authenticated
 * @returns {string}
 */
function renderPage(base, authenticated) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Abrir a GUI no celular</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { max-width: 44rem; margin: 0 auto; padding: 2rem 1.2rem 3rem; line-height: 1.5; }
  h1 { font-size: 1.35rem; margin: 0 0 .4rem; }
  p { margin: .7rem 0; }
  .muted { opacity: .72; font-size: .9rem; }
  .warn { border-left: 3px solid #b45309; padding: .5rem .8rem; background: color-mix(in srgb, #b45309 10%, transparent); }
  textarea { box-sizing: border-box; width: 100%; min-height: 7.5rem; margin-top: .4rem; padding: .7rem; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
  a { overflow-wrap: anywhere; }
  button { margin-top: .5rem; padding: .45rem .8rem; font: inherit; cursor: pointer; border-radius: 8px; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); background: transparent; color: inherit; }
  button:active { transform: translateY(1px); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
</style>
</head>
<body>
<h1>Abrir a GUI no celular</h1>
<p class="muted">Base Tailscale: <code>${escapeHtml(base)}</code></p>
<p>1. Ligue o <strong>Tailscale</strong> no celular.<br>
2. Abra este link no navegador do celular:</p>
<p><a id="link" href="${escapeAttribute(authenticated)}">${escapeHtml(authenticated)}</a></p>
<p class="muted">Ou copie o link:</p>
<textarea id="url" readonly>${escapeHtml(authenticated)}</textarea>
<button id="copy" type="button">Copiar link</button>
<p class="warn">O link contém o token de launch deste processo do <code>dsh web</code>. Não compartilhe.
Se o <code>dsh web</code> for reiniciado, o token muda: abra esta página de novo para gerar outro link.</p>
<script>
  const copy = document.getElementById("copy");
  const field = document.getElementById("url");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(field.value);
      copy.textContent = "Copiado";
      setTimeout(() => { copy.textContent = "Copiar link"; }, 1500);
    } catch {
      field.focus();
      field.select();
    }
  });
</script>
</body>
</html>`;
}

/** @param {string} value */
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** @param {string} value */
function escapeAttribute(value) {
  return escapeHtml(value);
}
