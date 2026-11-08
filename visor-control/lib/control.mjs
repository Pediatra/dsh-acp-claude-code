/**
 * Cliente local do canal de controle do shim dsh-acp.
 *
 * O shim `dsh-acp/server.mjs` expõe um Unix socket 0600 em
 * `<DSH_ACP_STATE_DIR>/control/shim-<pid>.sock`. Este módulo descobre os shims
 * vivos, fala o protocolo JSONL e inicia um shim por demanda para retomar uma
 * sessão que não tem dono.
 *
 * Não fala ACP diretamente e não abre `session.lock`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_STATE_DIR = path.join(os.homedir(), ".local", "state", "dsh-acp-mcp");
const DEFAULT_SERVER = path.join(os.homedir(), ".local", "share", "dsh-acp-mcp", "server.mjs");
const REPO_SERVER = fileURLToPath(new URL("../../dsh-acp/server.mjs", import.meta.url));

/** @param {string} [base] */
export function stateDir(base) {
  return path.resolve(base ?? process.env.DSH_ACP_STATE_DIR ?? DEFAULT_STATE_DIR);
}

/** @param {string} [base] */
export function controlDir(base) {
  return path.join(stateDir(base), "control");
}

/** @param {string} [explicit] */
export function serverPath(explicit) {
  const candidates = [explicit, process.env.DSH_ACP_SERVER, DEFAULT_SERVER, REPO_SERVER];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0 && existsSync(candidate)) return candidate;
  }
  return DEFAULT_SERVER;
}

/**
 * @typedef {{pid: number, socket: string, workspace: string, started_at?: string}} Shim
 */

/**
 * @param {string} [base]
 * @returns {Promise<Shim[]>}
 */
export async function listShims(base) {
  const dir = controlDir(base);
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const rows = [];
  for (const name of names) {
    if (!/^shim-\d+\.json$/.test(name)) continue;
    try {
      const data = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
      if (!Number.isInteger(data?.pid) || typeof data.socket !== "string" || typeof data.workspace !== "string") continue;
      if (path.dirname(path.resolve(data.socket)) !== path.resolve(dir)) continue;
      await fs.access(data.socket);
      try {
        process.kill(data.pid, 0);
      } catch {
        continue;
      }
      rows.push(data);
    } catch {
      // registro stale ou ilegível: ignora
    }
  }
  rows.sort((left, right) => left.pid - right.pid);
  return rows;
}

/**
 * Fala uma linha JSON com um shim e devolve a linha de resposta.
 * @param {Shim} shim
 * @param {object} request
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<object>}
 */
export function callShim(shim, request, options = {}) {
  const timeoutMs = options.timeoutMs ?? 35_000;
  return new Promise((resolve, reject) => {
    const socket = net.connect(shim.socket);
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => finish(new Error(`timeout de ${timeoutMs} ms falando com o shim ${shim.pid}`)));
    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        finish(new Error(`resposta inválida do shim ${shim.pid}`));
        return;
      }
      finish(null, value);
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      if (!settled) finish(new Error(`shim ${shim.pid} fechou a conexão sem resposta`));
    });
  });
}

/**
 * @param {Shim} shim
 * @param {object} request
 * @param {number} [timeoutMs]
 */
async function call(shim, request, timeoutMs) {
  const response = await callShim(shim, request, { timeoutMs });
  if (response?.ok === false) {
    const error = new Error(response.error || response.code || "falha no shim");
    error.code = response.code;
    error.response = response;
    throw error;
  }
  return response;
}

/**
 * @param {string} dshSessionId
 * @param {string} [base]
 * @returns {Promise<{shim: Shim, session: object}|null>}
 */
export async function findLiveSession(dshSessionId, base) {
  const shims = await listShims(base);
  for (const shim of shims) {
    let response;
    try {
      response = await call(shim, { id: `list-${Date.now()}`, action: "list" }, 5_000);
    } catch {
      continue;
    }
    const sessions = Array.isArray(response?.result?.sessions) ? response.result.sessions : [];
    const session = sessions.find((item) => item?.dsh_session_id === dshSessionId);
    if (session) return { shim, session };
  }
  return null;
}

/**
 * @param {string} [base]
 */
export async function status(base) {
  const shims = await listShims(base);
  const live = [];
  for (const shim of shims) {
    try {
      const response = await call(shim, { id: `list-${Date.now()}`, action: "list" }, 5_000);
      for (const session of response?.result?.sessions ?? []) {
        live.push({ shim_pid: shim.pid, workspace: shim.workspace, ...session });
      }
    } catch {
      // shim ocupado/registro stale: status continua com os demais
    }
  }
  return { shims, live };
}

/**
 * @param {string} message
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Garante um shim vivo para um workspace. Se já houver um, reutiliza.
 * @param {string} cwd
 * @param {{base?: string, server?: string, spawnTimeoutMs?: number}} [options]
 * @returns {Promise<Shim>}
 */
export async function ensureShim(cwd, options = {}) {
  const base = stateDir(options.base);
  const existing = (await listShims(base)).find((shim) => shim.workspace === cwd);
  if (existing) return existing;

  const server = serverPath(options.server);
  if (!existsSync(server)) throw new Error(`servidor dsh-acp não encontrado: ${server}`);
  const child = spawn(process.execPath, [server], {
    cwd,
    env: {
      ...process.env,
      DSH_ACP_WORKSPACE: cwd,
      DSH_ACP_STATE_DIR: base,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4_000);
  });

  const timeoutMs = options.spawnTimeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const shim = (await listShims(base)).find((item) => item.pid === child.pid);
    if (shim) return shim;
    if (child.exitCode !== null) {
      throw new Error(`shim dsh-acp saiu ao iniciar (código ${child.exitCode}): ${stderr.slice(-500)}`);
    }
    await sleep(120);
  }
  try { child.kill("SIGTERM"); } catch {}
  throw new Error(`shim dsh-acp não abriu o canal de controle em ${timeoutMs} ms: ${stderr.slice(-500)}`);
}

/**
 * @param {{dshSessionId: string, waitSeconds?: number, base?: string}} request
 */
export async function cancelSession(request) {
  const found = await findLiveSession(request.dshSessionId, request.base);
  if (found === null) {
    return {
      ok: false,
      code: "not-live",
      error: "esta sessão não está viva em um shim dsh-acp controlado; cancele só turnos de uma ponte ativa",
    };
  }
  const response = await call(found.shim, {
    id: `cancel-${Date.now()}`,
    action: "cancel",
    dsh_session_id: request.dshSessionId,
    wait_seconds: Math.max(0, Math.min(Number(request.waitSeconds ?? 30), 300)),
  }, 35_000);
  return { ok: true, shim_pid: found.shim.pid, ...response };
}

/**
 * Retoma/continua uma sessão. Se ela estiver viva e idle, manda a mensagem;
 * se estiver fechada, sobe um shim para o cwd e usa `deepseek_resume`.
 * @param {{dshSessionId: string, cwd: string, prompt: string, mode?: string, base?: string}} request
 */
export async function resumeSession(request) {
  const dshSessionId = String(request.dshSessionId || "").trim();
  const cwd = path.resolve(request.cwd || "");
  const prompt = String(request.prompt || "").trim();
  if (!dshSessionId) return { ok: false, code: "bad-request", error: "dsh_session_id é obrigatório" };
  if (!prompt) return { ok: false, code: "bad-request", error: "prompt é obrigatório" };
  if (!request.cwd) return { ok: false, code: "bad-request", error: "cwd é obrigatório" };
  if (!existsSync(cwd)) return { ok: false, code: "bad-request", error: `cwd não existe: ${cwd}` };

  const found = await findLiveSession(dshSessionId, request.base);
  if (found !== null) {
    const response = await call(found.shim, {
      id: `resume-${Date.now()}`,
      action: "resume",
      dsh_session_id: dshSessionId,
      prompt,
      cwd,
      mode: request.mode,
    }, 130_000);
    return { ok: true, shim_pid: found.shim.pid, ...response };
  }

  const shim = await ensureShim(cwd, { base: request.base });
  const response = await call(shim, {
    id: `resume-${Date.now()}`,
    action: "resume",
    dsh_session_id: dshSessionId,
    prompt,
    cwd,
    mode: request.mode,
  }, 130_000);
  return { ok: true, shim_pid: shim.pid, ...response };
}

/**
 * Cria um manager com estado isolável (útil em testes).
 * @param {{base?: string, server?: string}} [options]
 */
export function createControlManager(options = {}) {
  const base = options.base;
  const server = options.server;
  const spawned = new Set();
  return {
    base,
    async status() {
      return status(base);
    },
    async listShims() {
      return listShims(base);
    },
    async findLiveSession(dshSessionId) {
      return findLiveSession(dshSessionId, base);
    },
    async ensureShim(cwd) {
      const before = new Set((await listShims(base)).map((shim) => shim.pid));
      const shim = await ensureShim(cwd, { base, server });
      if (!before.has(shim.pid)) spawned.add(shim.pid);
      return shim;
    },
    async cancelSession(dshSessionId, waitSeconds) {
      return cancelSession({ dshSessionId, waitSeconds, base });
    },
    async resumeSession(request) {
      const before = new Set((await listShims(base)).map((shim) => shim.pid));
      const result = await resumeSession({ ...request, base });
      for (const shim of await listShims(base)) {
        if (!before.has(shim.pid)) spawned.add(shim.pid);
      }
      return result;
    },
    shutdown() {
      for (const pid of spawned) {
        try { process.kill(pid, "SIGTERM"); } catch {}
      }
      spawned.clear();
    },
  };
}
