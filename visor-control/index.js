/**
 * Metade Host do plugin `@local/dsh-visor-control`.
 *
 * Expõe ao viewer (mesma origem/autenticação) um canal local para:
 *   GET  /api/visor/control  — shims dsh-acp vivos e sessões controláveis.
 *   POST /api/visor/control  — action=cancel | resume.
 *
 * O trabalho real é feito pelo shim `dsh-acp/server.mjs` via o socket 0600;
 * este plugin não fala ACP, não abre `session.lock` e não escreve em
 * `~/.dsh/sessions/`.
 */
import { createControlManager } from "./lib/control.mjs";

export const inject = ["webServer", "connection"];

const MAX_BODY = 16 * 1024;

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 */
export function apply(ctx) {
  const manager = createControlManager();
  ctx.effect(() => () => manager.shutdown(), "visor-control: shutdown spawned shims");

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/visor/control",
      handler: (req, res) => handle(req, res, ctx, manager),
    }),
    "visor-control: route /api/visor/control",
  );
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {ReturnType<typeof createControlManager>} manager
 */
async function handle(req, res, ctx, manager) {
  let rejection;
  try {
    rejection = ctx.connection.requestRejection(req);
  } catch {
    rejection = 403;
  }
  if (rejection !== undefined) {
    sendText(res, rejection, rejection === 401 ? "Unauthorized" : "Forbidden");
    return;
  }

  try {
    if (req.method === "GET" || req.method === "HEAD") {
      const status = await manager.status();
      sendJson(req, res, 200, {
        available: true,
        hostPid: process.pid,
        ...status,
      });
      return;
    }

    if (req.method !== "POST") {
      res.setHeader("allow", "GET, HEAD, POST");
      sendText(res, 405, "Method Not Allowed");
      return;
    }

    const type = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!type.includes("application/json")) {
      sendJson(req, res, 415, { ok: false, error: "content-type application/json é obrigatório" });
      return;
    }
    if (String(req.headers["x-visor-control"] ?? "") !== "1") {
      sendJson(req, res, 400, { ok: false, error: "cabeçalho x-visor-control ausente" });
      return;
    }

    const body = await readBody(req);
    let request;
    try {
      request = JSON.parse(body);
    } catch {
      sendJson(req, res, 400, { ok: false, error: "json inválido" });
      return;
    }
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      sendJson(req, res, 400, { ok: false, error: "corpo deve ser um objeto" });
      return;
    }

    const action = String(request.action ?? "");
    if (action === "cancel") {
      const dshSessionId = String(request.dsh_session_id ?? "").trim();
      if (!dshSessionId) {
        sendJson(req, res, 400, { ok: false, error: "dsh_session_id é obrigatório" });
        return;
      }
      const result = await manager.cancelSession(dshSessionId, request.wait_seconds);
      sendJson(req, res, 200, { action, ...result });
      return;
    }

    if (action === "resume") {
      const dshSessionId = String(request.dsh_session_id ?? "").trim();
      const cwd = String(request.cwd ?? "").trim();
      const prompt = String(request.prompt ?? "").trim();
      if (!dshSessionId || !cwd || !prompt) {
        sendJson(req, res, 400, {
          ok: false,
          error: "dsh_session_id, cwd e prompt são obrigatórios",
        });
        return;
      }
      const result = await manager.resumeSession({
        dshSessionId,
        cwd,
        prompt,
        ...(typeof request.mode === "string" ? { mode: request.mode } : {}),
      });
      sendJson(req, res, 200, { action, ...result });
      return;
    }

    sendJson(req, res, 400, { ok: false, error: `ação desconhecida: ${action}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      ctx.logger?.warn?.(`visor-control: ${message.slice(0, 300)}`);
    } catch {
      // logging nunca derruba a rota
    }
    if (!res.headersSent) sendJson(req, res, 200, { ok: false, error: message.slice(0, 600) });
    else res.destroy();
  }
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (settled) return;
      body += chunk;
      if (body.length > MAX_BODY) {
        settled = true;
        reject(new Error("corpo grande demais"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(body);
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {object} value
 */
function sendJson(req, res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-length": String(Buffer.byteLength(body)),
  });
  if (req.method === "HEAD") res.end();
  else res.end(body);
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {string} body
 */
function sendText(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}
