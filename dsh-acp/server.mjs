#!/usr/bin/env node
/**
 * dsh-acp-mcp — expose DeepSeek Harness agents to Claude Code over MCP,
 * using the official ACP server (`dsh --profile acp`) as the transport.
 *
 * No HTTP, no browser cookie, no token: ACP is local JSON-RPC over stdio.
 * Workspace-write by default (sandboxed to cwd); use mode="read-only" for analysis.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(HERE, ".env");

// Optional local secrets file (mode 600, outside the repo). Never committed.
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || m[1].startsWith("#")) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const OVERLAY = path.join(HERE, "acp-overlay.yml");
const WORKSPACE = path.resolve(
  process.env.DSH_ACP_WORKSPACE || process.cwd(),
);
const DEFAULT_MODEL = "deepseek-v4.1-flash";
const DEFAULT_EFFORT = "max";
const ALLOWED_EFFORTS = new Set(["off", "low", "high", "max"]);
const modelValue = (m) => `["deepseek-official","${m}"]`;
const DEBUG = process.env.DSH_ACP_DEBUG === "1";

// Long-turn behaviour: the MCP call itself is the notification channel. Claude
// Code auto-backgrounds a main-conversation MCP call after ~2 minutes and wakes
// the model when it settles, so the shim blocks instead of asking for polling.
// MAX must stay under the per-server `timeout` in ~/.claude.json.
const DEFAULT_WAIT_SECONDS = 3_600;
const MAX_WAIT_SECONDS = 21_600;
const PROGRESS_INTERVAL_MS = 20_000;
// Close the ACP process after this many idle seconds (0 disables). The session
// is removed from the map, so a follow-up needs a new deepseek_start.
const IDLE_TTL_SECONDS = (() => {
  const n = Number(process.env.DSH_ACP_IDLE_TTL_SECONDS ?? 1800);
  return Number.isFinite(n) && n >= 0 ? n : 1800;
})();

const log = (...a) => {
  if (DEBUG) process.stderr.write("[dsh-acp-mcp] " + a.join(" ") + "\n");
};

/* ------------------------------------------------------------------ */
/* Resolve the dsh binary                                             */
/* ------------------------------------------------------------------ */

function findDsh() {
  const explicit = process.env.DSH_BIN;
  if (explicit && existsSync(explicit)) return { cmd: explicit, prefix: [] };

  const local = path.join(os.homedir(), ".local", "bin", "dsh");
  if (existsSync(local)) return { cmd: local, prefix: [] };

  const npxRoot = path.join(os.homedir(), ".npm", "_npx");
  if (existsSync(npxRoot)) {
    const candidates = [];
    for (const dir of readdirSync(npxRoot)) {
      const p = path.join(npxRoot, dir, "node_modules", ".bin", "dsh");
      if (existsSync(p)) candidates.push(p);
    }
    candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (candidates.length > 0) return { cmd: candidates[0], prefix: [] };
  }

  return { cmd: "npx", prefix: ["-y", "@deepseek-ai/dsh@0.2.1-rc.2"] };
}

/* ------------------------------------------------------------------ */
/* ACP client (JSON lines over stdio)                                 */
/* ------------------------------------------------------------------ */

let nextSession = 1;

class AcpSession {
  constructor({ mode, cwd, effort = DEFAULT_EFFORT, resumeSessionId = null }) {
    this.id = "s" + nextSession++;
    this.mode = mode;
    this.cwd = cwd;
    this.model = DEFAULT_MODEL;
    this.effort = effort;
    this.resumeSessionId = resumeSessionId;
    this.status = "starting";
    this.sessionId = null;
    this.proc = null;
    this.buf = "";
    this.pending = new Map();
    this.nextRpc = 1;
    this.output = "";
    this.toolCalls = [];
    this.usage = null;
    this.stopReason = null;
    this.error = null;
    this.turnStartedAt = null;
    this.lastTool = null;
    this.turnDone = null;
    this.turnResolve = null;
    this.promptPending = false;
    this.turnSeq = 0;
    this.cancelRequestedAt = null;
    this.closed = false;
    this.idleTimer = null;

    const { cmd, prefix } = findDsh();
    const args = [...prefix, "--profile", "acp", "--patch", OVERLAY];
    this.proc = spawn(cmd, args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        DSH_PERMISSION_MODE: mode === "workspace-write" ? "workspace-write" : "read-only",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.onData(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => log("acp stderr:", chunk.trim()));
    this.proc.on("error", (err) => this.fail(err));
    this.proc.on("exit", (code, signal) => {
      if (this.closed) return;
      if (this.status !== "idle") this.fail(new Error(`dsh acp exited (code=${code} signal=${signal})`));
    });
  }

  send(obj) {
    if (!this.proc?.stdin?.writable) return false;
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
    return true;
  }

  request(method, params, timeoutMs = 60_000) {
    const id = this.nextRpc++;
    return new Promise((resolve, reject) => {
      let timer = null;
      // timeoutMs <= 0 means "no client-side deadline": use it for the prompt
      // request, whose duration is unbounded. deepseek_wait owns the deadline.
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        method,
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
      if (!this.send({ jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new Error(`ACP ${method}: transport stdin is not writable`));
      }
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { log("bad acp line:", line.slice(0, 200)); continue; }
      this.onMessage(msg);
    }
  }

  onMessage(msg) {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
      return;
    }

    if (msg.method === "session/update") {
      const u = msg.params?.update;
      if (!u) return;
      if (u.sessionUpdate === "agent_message_chunk") {
        const t = u.content?.text;
        if (typeof t === "string") this.output += t;
      } else if (u.sessionUpdate === "tool_call") {
        this.lastTool = { title: u.title || u.kind || "tool", status: u.status || "pending" };
        this.toolCalls.push({ ...this.lastTool });
      } else if (u.sessionUpdate === "tool_call_update") {
        const last = this.toolCalls[this.toolCalls.length - 1];
        if (last && u.status) {
          last.status = u.status;
          this.lastTool = { ...last };
        }
      } else if (u.sessionUpdate === "usage_update") {
        this.usage = { used: u.used, size: u.size };
      }
      return;
    }

    if (msg.method === "session/request_permission") {
      const options = msg.params?.options || [];
      const wanted = this.mode === "read-only" ? /reject/i : /allow/i;
      const chosen = options.find((o) => wanted.test(o.optionId)) || options[0];
      this.send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { outcome: { outcome: "selected", optionId: chosen?.optionId } },
      });
      return;
    }

    if (msg.method === "session/update" || msg.method === "$/cancel_request") return;
    log("unhandled acp message:", JSON.stringify(msg).slice(0, 300));
  }

  fail(err) {
    if (this.status === "error") return;
    this.status = "error";
    this.error = err.message || String(err);
    // A dead transport never answers its pending requests: reject them now so
    // no detached prompt promise stays pending forever.
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new Error(this.error));
    }
    this.promptPending = false;
    this.finishTurn();
  }

  /** True while an ACP prompt request is still in flight, regardless of status. */
  get busy() {
    return this.promptPending || this.status === "running";
  }

  finishTurn() {
    if (this.turnResolve) {
      const r = this.turnResolve;
      this.turnResolve = null;
      this.turnDone = null;
      r();
    }
    this.scheduleIdleClose();
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Free the ACP process after an idle window; the session is then forgotten. */
  scheduleIdleClose() {
    this.clearIdleTimer();
    if (this.closed || IDLE_TTL_SECONDS <= 0 || this.busy) return;
    this.idleTimer = setTimeout(() => {
      if (this.busy) return;
      log(`idle TTL (${IDLE_TTL_SECONDS}s): closing ${this.id}`);
      this.close().catch(() => {});
      sessions.delete(this.id);
    }, IDLE_TTL_SECONDS * 1000);
    this.idleTimer.unref?.();
  }

  async init({ configure = true } = {}) {
    await this.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, 30_000);
    let state;
    if (this.resumeSessionId) {
      state = await this.request(
        "session/resume",
        { sessionId: this.resumeSessionId, cwd: this.cwd, mcpServers: [] },
        60_000,
      );
      this.sessionId = this.resumeSessionId;
    } else {
      state = await this.request("session/new", { cwd: this.cwd, mcpServers: [] }, 30_000);
      this.sessionId = state.sessionId;
    }
    let options = state.configOptions || [];

    // A fresh session gets the shim's fixed model/effort. A resume keeps the
    // stored configuration; we only read it back so status stays accurate.
    if (configure) {
      const modelOption = options.find((o) => o.id === "model");
      const value = modelValue(this.model);
      const hasModel = modelOption?.options?.some((group) =>
        (group.options || []).some((o) => o.value === value),
      );
      if (hasModel || !modelOption) {
        const res = await this.request(
          "session/set_config_option",
          { sessionId: this.sessionId, configId: "model", value },
          15_000,
        ).catch((e) => { log("model set failed:", e.message); return null; });
        if (res?.configOptions) options = res.configOptions;
      }
    }
    const currentModel = options.find((o) => o.id === "model")?.currentValue;
    if (typeof currentModel === "string") {
      try {
        const parsed = JSON.parse(currentModel);
        if (Array.isArray(parsed) && typeof parsed[1] === "string") this.model = parsed[1];
      } catch {}
    }

    if (configure) {
      const effortOption = options.find((o) => o.id === "reasoning_effort");
      if ((effortOption?.options || []).some((o) => o.value === this.effort)) {
        const res = await this.request(
          "session/set_config_option",
          { sessionId: this.sessionId, configId: "reasoning_effort", value: this.effort },
          15_000,
        ).catch((e) => { log("effort set failed:", e.message); return null; });
        if (res?.configOptions) options = res.configOptions;
      }
    }
    const currentEffort = options.find((o) => o.id === "reasoning_effort")?.currentValue;
    if (typeof currentEffort === "string") this.effort = currentEffort;

    this.status = "idle";
  }

  prompt(text) {
    if (this.busy) {
      throw new Error("session is busy; call deepseek_wait to keep waiting, or deepseek_cancel to interrupt the current turn");
    }
    this.clearIdleTimer();
    this.output = "";
    this.toolCalls = [];
    this.stopReason = null;
    this.error = null;
    this.lastTool = null;
    this.cancelRequestedAt = null;
    this.turnStartedAt = Date.now();
    this.status = "running";
    this.promptPending = true;
    const turn = ++this.turnSeq;
    this.turnDone = new Promise((resolve) => { this.turnResolve = resolve; });
    // No client-side timeout: a slow turn must not turn into a fake transport
    // error. The ACP response still owns the turn's real end, even if every
    // deepseek_wait window expired meanwhile.
    this.request(
      "session/prompt",
      { sessionId: this.sessionId, prompt: [{ type: "text", text }] },
      0,
    )
      .then((r) => {
        if (this.closed || this.turnSeq !== turn) return;
        this.stopReason = r?.stopReason ?? "end_turn";
        this.status = "idle";
      })
      .catch((e) => {
        if (this.closed || this.turnSeq !== turn) return;
        this.error = e.message || String(e);
        this.status = "error";
      })
      .finally(() => {
        if (this.closed || this.turnSeq !== turn) return;
        this.promptPending = false;
        this.cancelRequestedAt = null;
        this.finishTurn();
      });
  }

  async waitForTurn(seconds, onTick) {
    if (!this.turnDone || seconds <= 0) return;
    const deadline = Date.now() + seconds * 1000;
    while (this.turnDone) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await Promise.race([
        this.turnDone,
        new Promise((r) => setTimeout(r, Math.min(remaining, PROGRESS_INTERVAL_MS))),
      ]);
      if (!this.turnDone || Date.now() >= deadline) return;
      onTick?.(this);
    }
  }

  elapsedSeconds() {
    return this.turnStartedAt ? Math.max(0, Math.round((Date.now() - this.turnStartedAt) / 1000)) : 0;
  }

  basePayload() {
    return {
      session_id: this.id,
      dsh_session_id: this.sessionId,
      status: this.status,
      mode: this.mode,
      cwd: this.cwd,
      model: this.model,
      reasoning_effort: this.effort,
      elapsed_seconds: this.elapsedSeconds(),
      stop_reason: this.stopReason,
      last_tool: this.lastTool,
      output_chars: this.output.length,
      usage: this.usage,
      error: this.error,
    };
  }

  /** Compact: a short preview only; full text comes from deepseek_result. */
  statusPayload() {
    const p = this.basePayload();
    p.has_result = this.output.length > 0;
    p.partial = this.busy;
    if (this.output.length > 0) {
      const max = 400;
      p.output_preview = this.output.length > max ? this.output.slice(0, max) : this.output;
      if (this.output.length > max) p.output_preview_truncated = true;
      if (this.busy) p.output_preview_partial = true;
    }
    if (this.cancelRequestedAt) {
      p.cancel_requested = true;
      p.hint = "cancellation requested; the agent has not acknowledged it yet";
      p.next = `deepseek_cancel(session_id="${this.id}") or deepseek_wait(session_id="${this.id}")`;
    } else if (this.busy) {
      p.hint = `still running; call deepseek_wait with wait_seconds (up to ${MAX_WAIT_SECONDS}) instead of tight polling`;
      p.next = `deepseek_wait(session_id="${this.id}", wait_seconds=${DEFAULT_WAIT_SECONDS})`;
    } else if (this.status === "error") {
      p.hint = "turn failed; deepseek_result still returns the partial output produced before the failure";
      p.next = `deepseek_result(session_id="${this.id}")`;
    }
    return p;
  }

  /** Full output, for a single explicit retrieval. */
  resultPayload(maxChars = 20_000) {
    const p = this.basePayload();
    p.output = this.output.length > maxChars ? this.output.slice(0, maxChars) : this.output;
    p.truncated = this.output.length > maxChars;
    p.tool_calls = this.toolCalls;
    p.has_result = this.output.length > 0;
    return p;
  }

  async close() {
    this.closed = true;
    this.clearIdleTimer();
    // Invalidate the detached prompt callbacks before killing the process.
    this.turnSeq++;
    this.promptPending = false;
    // Resolve any pending deepseek_wait/status immediately: killing the process
    // otherwise leaves the wait pending until its own timeout.
    this.status = "closed";
    this.stopReason = "closed";
    this.finishTurn();
    try {
      if (this.sessionId) {
        await this.request("session/close", { sessionId: this.sessionId }, 5_000).catch(() => {});
      }
    } finally {
      try { this.proc?.kill("SIGKILL"); } catch {}
      this.proc = null;
      this.buf = "";
      this.pending.clear();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Tool implementations                                               */
/* ------------------------------------------------------------------ */

const sessions = new Map();

function resolveCwd(raw) {
  const requested = raw ? path.resolve(raw) : WORKSPACE;
  let real;
  try { real = realpathSync(requested); }
  catch { throw new Error(`cwd does not exist: ${requested}`); }
  const root = realpathSync(WORKSPACE);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`cwd must be inside ${root}`);
  }
  return real;
}

function clampWait(explicit, fallback, max) {
  const n = Number(explicit ?? fallback);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(n, max));
}

/**
 * start/send dispatch and return at once, so the session id always reaches the
 * caller before any long wait. deepseek_wait is the blocking call: Claude Code
 * auto-backgrounds it after a few seconds and notifies the model on completion.
 * `wait_seconds` on start/send keeps single-call behaviour when explicitly set.
 */
function resolveWait(args) {
  if (args.wait_seconds !== undefined) {
    return clampWait(args.wait_seconds, 0, MAX_WAIT_SECONDS);
  }
  if (args.wait === true) return DEFAULT_WAIT_SECONDS;
  return 0;
}

/** Keep the stdio call alive and show progress in Claude Code's /tasks view. */
function sendProgress(progressToken, session, label) {
  if (progressToken === undefined || progressToken === null) return;
  const elapsed = session.elapsedSeconds();
  const last = session.lastTool?.title ? ` last_tool=${session.lastTool.title}` : "";
  mcpSend({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: {
      progressToken,
      progress: elapsed,
      message: `${label}: session ${session.id} running ${elapsed}s${last}`,
    },
  });
}

async function createSession(args, { resumeSessionId = null } = {}) {
  const mode = args.mode === "read-only" ? "read-only" : "workspace-write";
  const cwd = resolveCwd(args.cwd);
  const effort = ALLOWED_EFFORTS.has(args.reasoning_effort) ? args.reasoning_effort : DEFAULT_EFFORT;
  if (resumeSessionId) {
    for (const s of sessions.values()) {
      if (s.sessionId === resumeSessionId) {
        throw new Error(`session ${resumeSessionId} is already open as ${s.id}; use that session or close it first`);
      }
    }
  }
  const session = new AcpSession({ mode, cwd, effort, resumeSessionId });
  sessions.set(session.id, session);
  try {
    await session.init({ configure: !resumeSessionId });
    session.prompt(String(args.prompt));
    return session;
  } catch (err) {
    sessions.delete(session.id);
    await session.close();
    throw err;
  }
}

async function toolStart(args, progressToken) {
  const session = await createSession(args);
  const wait = resolveWait(args);
  if (wait > 0) await session.waitForTurn(wait, (s) => sendProgress(progressToken, s, "deepseek_start"));
  if (!session.busy) return session.resultPayload();
  return session.statusPayload();
}

/**
 * Reattach to a persisted DSH session and send the first prompt of the new
 * process. This is the crash/restart path: the local sN aliases are in-memory,
 * but the DSH UUID and its history survive on disk.
 */
async function toolResume(args, progressToken) {
  const dshSessionId = String(args.dsh_session_id || "").trim();
  if (!dshSessionId) throw new Error("dsh_session_id is required");
  if (!args.prompt || !String(args.prompt).trim()) throw new Error("prompt is required");
  const session = await createSession(args, { resumeSessionId: dshSessionId });
  const wait = resolveWait(args);
  if (wait > 0) await session.waitForTurn(wait, (s) => sendProgress(progressToken, s, "deepseek_resume"));
  if (!session.busy) return session.resultPayload();
  return session.statusPayload();
}

/**
 * Starts every task concurrently, in one tool call. This is the only way to
 * guarantee parallel agents: interleaving start/wait in separate calls makes
 * each wait block the next start.
 */
async function toolStartMany(args) {
  const tasks = Array.isArray(args.tasks) ? args.tasks : [];
  if (tasks.length === 0) throw new Error("tasks must be a non-empty array");
  if (tasks.length > 8) throw new Error("at most 8 tasks per call (each one is a DSH process)");
  for (const [i, task] of tasks.entries()) {
    if (!task || typeof task.prompt !== "string" || !task.prompt.trim()) {
      throw new Error(`tasks[${i}].prompt is required`);
    }
  }
  const started = await Promise.all(tasks.map(async (task, index) => {
    try {
      const s = await createSession(task);
      return { index, ok: true, ...s.statusPayload() };
    } catch (err) {
      return { index, ok: false, error: err?.message || String(err) };
    }
  }));
  const ids = started.filter((x) => x.ok).map((x) => x.session_id);
  if (ids.length === 0) {
    return { sessions: started, started: 0, error: "no session could be started" };
  }
  return {
    sessions: started,
    started: ids.length,
    session_ids: ids,
    next: `deepseek_wait_all(session_ids=${JSON.stringify(ids)}, wait_seconds=${DEFAULT_WAIT_SECONDS})`,
  };
}

/** Waits on every session concurrently, so N agents finish in max(time), not sum(time). */
async function toolWaitAll(args, progressToken) {
  const ids = Array.isArray(args.session_ids) ? args.session_ids.map(String) : [];
  if (ids.length === 0) throw new Error("session_ids must be a non-empty array");
  const wait = clampWait(args.wait_seconds, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
  const out = await Promise.all(ids.map(async (id) => {
    let s;
    try {
      s = needSession(id);
    } catch (err) {
      return { session_id: id, status: "unknown", error: err.message || String(err) };
    }
    if (wait > 0) await s.waitForTurn(wait, (x) => sendProgress(progressToken, x, "deepseek_wait_all"));
    return s.busy ? s.statusPayload() : s.resultPayload();
  }));
  const done = out.filter((x) => x.status === "idle").length;
  const running = out.filter((x) => x.status === "running").length;
  const failed = out.filter((x) => ["error", "closed", "unknown"].includes(x.status)).length;
  const res = {
    sessions: out,
    done,
    failed,
    running,
    all_done: done + failed === out.length,
  };
  if (running > 0) {
    const still = out.filter((x) => x.status === "running").map((x) => x.session_id);
    res.hint = "some sessions are still running; call deepseek_wait_all again with the remaining ids";
    res.remaining = still;
  }
  return res;
}

function needSession(id) {
  const s = sessions.get(String(id));
  if (!s) throw new Error(`unknown session_id: ${id}`);
  return s;
}

async function toolSend(args, progressToken) {
  const s = needSession(args.session_id);
  if (s.busy) {
    return {
      ...s.statusPayload(),
      busy: true,
      note: "a turn is still in flight; this message was NOT queued. Wait with deepseek_wait or interrupt with deepseek_cancel first.",
    };
  }
  s.prompt(String(args.message));
  const wait = resolveWait(args);
  if (wait > 0) await s.waitForTurn(wait, (x) => sendProgress(progressToken, x, "deepseek_send"));
  if (!s.busy) return s.resultPayload();
  return s.statusPayload();
}

async function toolWait(args, progressToken) {
  const s = needSession(args.session_id);
  const wait = clampWait(args.wait_seconds, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
  if (wait > 0) await s.waitForTurn(wait, (x) => sendProgress(progressToken, x, "deepseek_wait"));
  if (!s.busy) return s.resultPayload();
  return s.statusPayload();
}

async function toolStatus(args, progressToken) {
  const s = needSession(args.session_id);
  const wait = clampWait(args.wait_seconds, 0, MAX_WAIT_SECONDS);
  await s.waitForTurn(wait, (x) => sendProgress(progressToken, x, "deepseek_status"));
  return s.statusPayload();
}

async function toolResult(args) {
  const s = needSession(args.session_id);
  const max = clampWait(args.max_chars, 20_000, 50_000) || 20_000;
  const payload = s.resultPayload(max);
  payload.partial = s.busy;
  if (s.busy) {
    payload.note = "turn still running: this is the output produced so far. Call deepseek_wait to block; never send a new prompt before this turn ends.";
  }
  return payload;
}

async function toolCancel(args, progressToken) {
  const s = needSession(args.session_id);
  if (!s.busy) {
    return {
      ...s.resultPayload(),
      cancel_requested: false,
      note: "no turn in flight; nothing to cancel",
    };
  }
  s.cancelRequestedAt = Date.now();
  s.notify("session/cancel", { sessionId: s.sessionId });
  const wait = clampWait(args.wait_seconds, 30, 300);
  if (wait > 0) await s.waitForTurn(wait, (x) => sendProgress(progressToken, x, "deepseek_cancel"));
  if (!s.busy) {
    const payload = s.resultPayload();
    payload.cancel_requested = true;
    payload.cancelled = s.stopReason === "cancelled";
    return payload;
  }
  const payload = s.statusPayload();
  payload.cancel_requested = true;
  payload.cancelled = false;
  payload.note = "cancel delivered, but the agent has not stopped yet. Do not send a new prompt; call deepseek_cancel again or keep waiting.";
  return payload;
}

async function toolClose(args) {
  const s = needSession(args.session_id);
  // Capture the report before killing the process: close is often the last
  // resort after a cancel, and the partial output must not disappear with it.
  const final = s.resultPayload(20_000);
  final.partial = s.busy;
  if (s.busy) {
    s.notify("session/cancel", { sessionId: s.sessionId });
  }
  await s.close();
  sessions.delete(s.id);
  return {
    ...final,
    status: "closed",
    closed: true,
    note: "process terminated and session forgotten; start a new session for more work",
  };
}

async function toolList() {
  return { sessions: [...sessions.values()].map((s) => s.statusPayload()) };
}

/* ------------------------------------------------------------------ */
/* MCP stdio server                                                   */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: "deepseek_start",
    description:
      "Start ONE DeepSeek Harness agent session through the official ACP server. Returns in a few seconds (~3s) with " +
      "session_id and status=running. Call deepseek_wait(session_id) after it to get the result. The returned " +
      "dsh_session_id is durable: deepseek_resume can reattach after a restart/crash. " +
      "PARALLELISM: for several independent agents use deepseek_start_many (single call starts them all). If you " +
      "insist on separate calls, start EVERY agent first and only then call deepseek_wait — a wait on A before " +
      "starting B serializes the work (B does not exist until A finishes). Never poll and never create file " +
      "watchers. If a call gets interrupted, the DeepSeek session keeps running: find it with deepseek_list and " +
      "resume with deepseek_wait. Model is fixed to deepseek-v4.1-flash; reasoning_effort selects off/low/high/max " +
      "(default max). Workspace-write by default (DSH sandbox limits writes to cwd). Use mode='read-only' for analysis.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Self-contained task. Name files by path; the agent can read them itself." },
        cwd: { type: "string", description: "Working directory inside the project (default: project root)." },
        mode: { type: "string", enum: ["read-only", "workspace-write"], description: "workspace-write (default) or read-only" },
        reasoning_effort: { type: "string", enum: ["off", "low", "high", "max"], description: "default max" },
        wait: { type: "boolean", description: "false (default) = return immediately with session_id; true = block here instead of using deepseek_wait." },
        wait_seconds: { type: "number", description: "0-21600; explicit blocking wait (overrides wait)." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "deepseek_start_many",
    description:
      "Start N DeepSeek agent sessions CONCURRENTLY in one call and return their session_ids in a few seconds. " +
      "Use this whenever a task splits into parallel agents: it is the only way to guarantee they run at the same " +
      "time. Follow with ONE deepseek_wait_all(session_ids). Each task is a full DSH process; max 8 per call.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          description: "One object per agent. Each becomes its own DSH session/process.",
          items: {
            type: "object",
            properties: {
              prompt: { type: "string", description: "Self-contained task for this agent." },
              cwd: { type: "string", description: "Working directory inside the project (default: project root)." },
              mode: { type: "string", enum: ["read-only", "workspace-write"], description: "workspace-write (default) or read-only" },
              reasoning_effort: { type: "string", enum: ["off", "low", "high", "max"], description: "default max" },
            },
            required: ["prompt"],
          },
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "deepseek_resume",
    description:
      "Resume a persisted DeepSeek session by its durable dsh_session_id (the UUID returned by deepseek_start, " +
      "not the local sN alias) and send a prompt — use this after a Claude/DSH restart or crash, or after " +
      "deepseek_close. The session keeps its history and files; cwd must match the original session. Running " +
      "background jobs and in-flight tool calls are gone: the agent may need to redo the interrupted step. " +
      "Follow with deepseek_wait.",
    inputSchema: {
      type: "object",
      properties: {
        dsh_session_id: { type: "string", description: "UUID of the persisted DSH session (dsh_session_id)" },
        prompt: { type: "string", description: "Message to send on resume, e.g. 'Continue de onde parou'" },
        cwd: { type: "string", description: "Must match the session's original cwd (default: project root)" },
        mode: { type: "string", enum: ["read-only", "workspace-write"], description: "workspace-write (default) or read-only" },
        wait: { type: "boolean", description: "false (default) = return immediately; true = block here." },
        wait_seconds: { type: "number", description: "0-21600; explicit blocking wait." },
      },
      required: ["dsh_session_id", "prompt"],
    },
  },
  {
    name: "deepseek_wait_all",
    description:
      "Block until ALL given sessions finish (default 1h, max 6h) and return each result. The waits run " +
      "concurrently, so N agents take max(time), not sum(time). Use right after deepseek_start_many; Claude Code " +
      "auto-backgrounds this call and notifies you on completion. If it returns running sessions, call it again " +
      "with the remaining ids — never loop with short waits.",
    inputSchema: {
      type: "object",
      properties: {
        session_ids: { type: "array", minItems: 1, maxItems: 16, items: { type: "string" } },
        wait_seconds: { type: "number", description: "0-21600; default 3600" },
      },
      required: ["session_ids"],
    },
  },
  {
    name: "deepseek_send",
    description:
      "Dispatch a follow-up message to an existing DeepSeek session and return immediately. Follow with " +
      "deepseek_wait(session_id). Returns busy without queuing the message if a turn is still running — " +
      "an expired wait window does NOT free the session; wait again or call deepseek_cancel first.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        message: { type: "string" },
        wait: { type: "boolean", description: "false (default) = return immediately; true = block here." },
        wait_seconds: { type: "number", description: "0-21600; explicit blocking wait." },
      },
      required: ["session_id", "message"],
    },
  },
  {
    name: "deepseek_wait",
    description:
      "Block until ONE session's current turn finishes (default 1h, max 6h) and return the full result. " +
      "For several sessions use deepseek_wait_all (it waits on all of them concurrently). Claude Code moves a call " +
      "still running after a few seconds to a background task and wakes you with the result when it settles, so " +
      "this is the notification mechanism. If it returns status=running (wait window expired), the turn is still " +
      "alive: call deepseek_wait again once with a large wait_seconds; never send a new prompt or loop with short waits.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        wait_seconds: { type: "number", description: "0-21600; default 3600" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "deepseek_status",
    description:
      "Quick, compact status: state, elapsed time, last tool and usage, with a ~400-char preview when done. " +
      "Use deepseek_wait (not status) to wait for completion; use deepseek_result for the full text.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        wait_seconds: { type: "number", description: "0-21600; default 0" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "deepseek_result",
    description:
      "Return the output accumulated so far (up to max_chars), including partial output while a turn is still " +
      "running or after a turn failed. Use deepseek_status for cheap polling; use deepseek_wait to block.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        max_chars: { type: "number", description: "default 20000, max 50000" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "deepseek_cancel",
    description:
      "Interrupt the turn that is actually in flight, including one whose wait window expired. Sends ACP " +
      "session/cancel and waits up to wait_seconds (default 30s) for the agent to stop; returns the partial output " +
      "so the final report is not lost. If it still says cancel_requested, do not send a new prompt — wait or cancel again.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        wait_seconds: { type: "number", description: "0-300; how long to wait for the agent to stop (default 30)" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "deepseek_close",
    description:
      "Close a finished session now: cancel the turn if running, terminate its ACP process and forget the session. " +
      "Returns the output accumulated so far (partial if the turn was interrupted) so the report is not lost. " +
      "Use it when done with an agent to free memory/processes. Sessions are also auto-closed after an idle TTL " +
      "(DSH_ACP_IDLE_TTL_SECONDS, default 1800s; 0 disables).",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "deepseek_list",
    description: "List DeepSeek sessions started by this MCP server.",
    inputSchema: { type: "object", properties: {} },
  },
];

function textResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], isError };
}

async function callTool(name, args, progressToken) {
  switch (name) {
    case "deepseek_start": return textResult(await toolStart(args, progressToken));
    case "deepseek_start_many": return textResult(await toolStartMany(args));
    case "deepseek_resume": return textResult(await toolResume(args, progressToken));
    case "deepseek_send": return textResult(await toolSend(args, progressToken));
    case "deepseek_wait": return textResult(await toolWait(args, progressToken));
    case "deepseek_wait_all": return textResult(await toolWaitAll(args, progressToken));
    case "deepseek_status": return textResult(await toolStatus(args, progressToken));
    case "deepseek_result": return textResult(await toolResult(args));
    case "deepseek_cancel": return textResult(await toolCancel(args));
    case "deepseek_close": return textResult(await toolClose(args));
    case "deepseek_list": return textResult(await toolList());
    default: return textResult(`unknown tool: ${name}`, true);
  }
}

/* MCP framing: newline-delimited JSON (MCP stdio transport) */

function mcpSend(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let mcpBuf = "";
process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk) => {
  mcpBuf += chunk;
  let i;
  while ((i = mcpBuf.indexOf("\n")) >= 0) {
    const line = mcpBuf.slice(0, i).trim();
    mcpBuf = mcpBuf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handleMcp(msg);
  }
});

function handleMcp(msg) {
  const { id, method } = msg;
  if (method === "initialize") {
    mcpSend({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: msg.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "dsh-acp-mcp", version: "0.1.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "notifications/cancelled") {
    // Claude Code cancelled the tool call (interrupt / new message). Do NOT
    // cancel the DeepSeek turn: the session keeps running and stays reachable
    // through deepseek_list + deepseek_wait.
    log("client cancelled a call; DeepSeek session left running:", JSON.stringify(msg.params));
    return;
  }
  if (method === "ping") { mcpSend({ jsonrpc: "2.0", id, result: {} }); return; }
  if (method === "tools/list") { mcpSend({ jsonrpc: "2.0", id, result: { tools: TOOLS } }); return; }
  if (method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments || {};
    const progressToken = msg.params?._meta?.progressToken;
    if (DEBUG && progressToken !== undefined) log("progressToken:", String(progressToken));
    callTool(name, args, progressToken)
      .then((result) => mcpSend({ jsonrpc: "2.0", id, result }))
      .catch((err) => mcpSend({
        jsonrpc: "2.0",
        id,
        result: textResult(`error: ${err.message || String(err)}`, true),
      }));
    return;
  }
  if (method === "shutdown") {
    Promise.allSettled([...sessions.values()].map((s) => s.close())).finally(() => {
      mcpSend({ jsonrpc: "2.0", id, result: {} });
      process.exit(0);
    });
    return;
  }
  if (method === "exit") {
    process.exit(0);
  }
  if (id !== undefined) {
    mcpSend({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

process.on("SIGTERM", async () => {
  await Promise.allSettled([...sessions.values()].map((s) => s.close()));
  process.exit(0);
});

// Claude Code sends SIGINT first when it disconnects a stdio server, then
// SIGTERM ~100ms later. Ignoring SIGINT keeps an accidental interrupt from
// killing live DeepSeek sessions; SIGTERM above still closes them on real exit.
process.on("SIGINT", () => {
  log("SIGINT ignored; live sessions stay up until SIGTERM");
});

log("ready; workspace=" + WORKSPACE);
