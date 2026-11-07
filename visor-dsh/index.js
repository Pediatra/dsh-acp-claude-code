/**
 * Metade Host do plugin `@local/dsh-visor`.
 *
 * Registra duas rotas GET autenticadas no servidor web do DSH:
 *   /api/visor/sessions  — catálogo de sessões persistidas.
 *   /api/visor/session   — snapshot/incremento de uma sessão.
 *
 * As rotas apenas leem `session.v4.jsonl.zstd`, metadados de `session.lock` e
 * links de `/proc`. Não falam ACP, não chamam `agents.resume` e não adquirem
 * o lock.
 */
import { createSessionStore, SessionNotFoundError } from "./host/store.mjs";

export const inject = ["webServer", "connection"];

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 */
export function apply(ctx) {
  const store = createSessionStore();
  const log = (...args) => {
    try {
      ctx.logger?.warn?.(...args);
    } catch {
      // logging nunca deve derrubar a rota
    }
  };

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/visor/sessions",
      handler: (req, res) => handle(req, res, ctx, log, async () => {
        const sessions = await store.listSessions();
        return {
          root: store.root,
          hostPid: process.pid,
          now: Date.now(),
          sessions,
        };
      }),
    }),
    "visor-dsh: route /api/visor/sessions",
  );

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/visor/session",
      handler: (req, res) => handle(req, res, ctx, log, async (url) => {
        const id = url.searchParams.get("id") ?? "";
        if (!isPlausibleSessionId(id)) {
          return { status: 404, body: { error: "session/not-found" } };
        }
        const afterRaw = url.searchParams.get("afterSeq");
        const generationRaw = url.searchParams.get("gen");
        const afterSeq = parseInteger(afterRaw);
        const generation = parseInteger(generationRaw);
        try {
          const snapshot = await store.readSession(id, {
            ...(afterSeq === null ? {} : { afterSeq }),
            ...(generation === null ? {} : { generation }),
          });
          return { status: 200, body: snapshot };
        } catch (error) {
          if (error instanceof SessionNotFoundError) {
            return { status: 404, body: { error: "session/not-found" } };
          }
          throw error;
        }
      }),
    }),
    "visor-dsh: route /api/visor/session",
  );
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {(...args: unknown[]) => void} log
 * @param {(url: URL) => Promise<{status: number, body: object}|object>} produce
 */
async function handle(req, res, ctx, log, produce) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, {
      allow: "GET, HEAD",
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end("Method Not Allowed");
    return;
  }

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
    });
    res.end(rejection === 401 ? "Unauthorized" : "Forbidden");
    return;
  }

  try {
    const url = new URL(req.url ?? "/", "http://visor.invalid");
    const produced = await produce(url);
    const status = typeof produced?.status === "number" ? produced.status : 200;
    const body = produced?.body ?? produced ?? {};
    const json = JSON.stringify(body);
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-length": String(Buffer.byteLength(json)),
    };
    res.writeHead(status, headers);
    if (req.method === "HEAD") res.end();
    else res.end(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`visor-dsh: falha na rota ${req.url ?? ""}: ${message.slice(0, 240)}`);
    const json = JSON.stringify({ error: "internal" });
    res.writeHead(500, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": String(Buffer.byteLength(json)),
    });
    res.end(json);
  }
}

/** @param {string|null} value */
function parseInteger(value) {
  if (value === null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/** @param {string} id */
function isPlausibleSessionId(id) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
}
