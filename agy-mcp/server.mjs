#!/usr/bin/env node
/**
 * agy-mcp — expose the Antigravity CLI (`agy`) to Claude Code over MCP.
 *
 * Transport: `agy --print= --input-format stream-json --output-format stream-json`
 * (newline-delimited JSON, multiple turns per process).
 *
 * Read-only uses bubblewrap with `/` read-only and only ~/.gemini + ~/.cache
 * writable (plus /tmp). Workspace-write makes the workspace writable and adds
 * --dangerously-skip-permissions so commands can run; everything else stays
 * read-only.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const WORKSPACE = path.resolve(process.env.AGY_WORKSPACE || process.cwd());
const BWRAP = process.env.AGY_BWRAP || "/usr/bin/bwrap";
const DEFAULT_MODEL = process.env.AGY_MODEL || "gemini-3.8-flash-high";
const DEFAULT_EFFORT = process.env.AGY_EFFORT || "high";
const MODELS = [
  "gemini-4-argon-low",
  "gemini-4-argon-medium",
  "gemini-4-argon-high",
  "gemini-3.8-flash-low",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-high",
];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const DEBUG = process.env.AGY_DEBUG === "1";
// Hard gate used by orchestrators (e.g. DSH in read-only mode): when set to
// "0", every workspace-write request is downgraded to read-only, so a parent
// agent cannot escape its own sandbox by delegating to agy.
const ALLOW_WRITE = process.env.AGY_ALLOW_WRITE !== "0";

// Long-turn / cleanup behaviour, mirroring dsh-acp. agy sessions are usually
// short, so the default wait is 10 min (max 1h). Idle sessions close after the
// TTL; a later agy_send respawns with --conversation and keeps the context.
const DEFAULT_WAIT_SECONDS = 600;
const MAX_WAIT_SECONDS = 3_600;
const PROGRESS_INTERVAL_MS = 20_000;
const IDLE_TTL_SECONDS = (() => {
  const n = Number(process.env.AGY_IDLE_TTL_SECONDS ?? 1800);
  return Number.isFinite(n) && n >= 0 ? n : 1800;
})();

const log = (...a) => {
  if (DEBUG) process.stderr.write("[agy-mcp] " + a.join(" ") + "\n");
};

function findAgy() {
  const explicit = process.env.AGY_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  const local = path.join(HOME, ".local", "bin", "agy");
  if (existsSync(local)) return local;
  return "agy";
}
const AGY = findAgy();

/* ------------------------------------------------------------------ */
/* Command construction                                               */
/* ------------------------------------------------------------------ */

function buildSpawn({ mode, model, effort, cwd, conversationId }) {
  const agyArgs = [
    "--print=",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--model", model,
    "--effort", effort,
    "--mode", "accept-edits",
  ];
  if (conversationId) agyArgs.push("--conversation", conversationId);
  if (mode === "workspace-write") agyArgs.push("--dangerously-skip-permissions");

  if (!existsSync(BWRAP)) {
    if (mode === "read-only") {
      throw new Error("read-only mode requires bubblewrap (bwrap) at " + BWRAP);
    }
    return { cmd: AGY, args: agyArgs, cwd };
  }

  const gemini = path.join(HOME, ".gemini");
  const cache = path.join(HOME, ".cache");
  for (const d of [gemini, cache]) {
    try { mkdirSync(d, { recursive: true }); } catch {}
  }

  const bwrapArgs = [
    "--ro-bind", "/", "/",
    "--bind", gemini, gemini,
    "--bind", cache, cache,
    "--dev", "/dev",
    "--proc", "/proc",
    "--bind", "/tmp", "/tmp",
  ];
  if (mode === "workspace-write") {
    bwrapArgs.push("--bind", cwd, cwd);
  } else {
    bwrapArgs.push("--ro-bind", cwd, cwd);
  }
  bwrapArgs.push("--chdir", cwd, AGY, ...agyArgs);
  return { cmd: BWRAP, args: bwrapArgs, cwd };
}

/* ------------------------------------------------------------------ */
/* Session                                                           */
/* ------------------------------------------------------------------ */

let nextSession = 1;

class AgySession {
  constructor({ mode, modeRequested, cwd, model, effort }) {
    this.id = "g" + nextSession++;
    this.mode = mode;
    this.modeRequested = modeRequested || mode;
    this.cwd = cwd;
    this.model = model;
    this.effort = effort;
    this.status = "starting";
    this.conversationId = null;
    this.permissionMode = null;
    this.proc = null;
    this.buf = "";
    this.output = "";
    this.streamText = "";
    this.lastTool = null;
    this.toolCalls = [];
    this.usage = null;
    this.denied = null;
    this.stopReason = null;
    this.error = null;
    this.turnStartedAt = null;
    this.turnDone = null;
    this.turnResolve = null;
    this.cancelled = false;
    this.closed = false;
    this.idleTimer = null;
  }

  spawnProcess() {
    const { cmd, args, cwd } = buildSpawn({
      mode: this.mode,
      model: this.model,
      effort: this.effort,
      cwd: this.cwd,
      conversationId: this.conversationId,
    });
    this.proc = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}:${path.join(HOME, ".local", "bin")}:${process.env.PATH ?? ""}`,
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buf = "";
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d) => this.onData(d));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (d) => log("agy stderr:", d.trim()));
    this.proc.on("error", (e) => this.fail(e));
    this.proc.on("exit", (code, signal) => {
      if (this.cancelled) return;
      if (this.status === "running") {
        this.fail(new Error(`agy exited (code=${code} signal=${signal})`));
      }
    });
  }

  ensureProcess() {
    if (!this.proc || this.proc.exitCode !== null) {
      this.cancelled = false;
      this.closed = false;
      this.spawnProcess();
    }
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { log("bad agy line:", line.slice(0, 200)); continue; }
      this.onMessage(m);
    }
  }

  onMessage(m) {
    if (m.event === "init") {
      this.conversationId = m.conversation_id || this.conversationId;
      this.permissionMode = m.init?.permission_mode || this.permissionMode;
      if (m.init?.model) this.model = m.init.model;
      return;
    }
    if (m.event === "step_update") {
      const u = m.step_update;
      if (!u) return;
      if (u.step_type === "tool") {
        this.lastTool = { name: u.tool_name, state: u.state };
        if (u.state === "DONE") {
          this.toolCalls.push({ name: u.tool_name, state: u.state });
        }
      } else if (u.step_type === "agent_response" && typeof u.text_delta === "string") {
        this.streamText += u.text_delta;
      }
      if (u.usage) this.usage = u.usage;
      return;
    }
    if (m.event === "result") {
      const r = m.result || {};
      this.conversationId = r.conversation_id || this.conversationId;
      this.output = r.response || this.streamText;
      this.usage = r.usage || this.usage;
      this.stopReason = r.status || null;
      this.denied = r.denied_actions || null;
      this.status = r.status === "SUCCESS" ? "idle" : "error";
      if (r.status !== "SUCCESS") this.error = r.error || r.status || "agy error";
      this.finishTurn();
    }
  }

  fail(err) {
    if (this.status === "error") return;
    this.status = "error";
    this.error = err?.message || String(err);
    this.finishTurn();
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

  /** Free the agy process after idle; a later send resumes via --conversation. */
  scheduleIdleClose() {
    this.clearIdleTimer();
    if (IDLE_TTL_SECONDS <= 0 || this.status === "running") return;
    this.idleTimer = setTimeout(() => {
      if (this.status === "running") return;
      log(`idle TTL (${IDLE_TTL_SECONDS}s): closing ${this.id}`);
      this.close();
    }, IDLE_TTL_SECONDS * 1000);
    this.idleTimer.unref?.();
  }

  startTurn(text) {
    if (this.status === "running") throw new Error("session is busy; wait for the current turn");
    this.clearIdleTimer();
    this.closed = false;
    this.ensureProcess();
    this.output = "";
    this.streamText = "";
    this.lastTool = null;
    this.toolCalls = [];
    this.denied = null;
    this.error = null;
    this.stopReason = null;
    this.turnStartedAt = Date.now();
    this.status = "running";
    this.turnDone = new Promise((resolve) => { this.turnResolve = resolve; });
    this.proc.stdin.write(JSON.stringify({
      event: "user",
      message: { role: "user", content: text },
    }) + "\n");
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
    const p = {
      session_id: this.id,
      conversation_id: this.conversationId,
      status: this.status,
      mode: this.mode,
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
      closed: this.closed,
      elapsed_seconds: this.elapsedSeconds(),
      stop_reason: this.stopReason,
      last_tool: this.lastTool,
      output_chars: this.output.length,
      usage: this.usage,
      denied_actions: this.denied,
      error: this.error,
    };
    if (this.modeRequested !== this.mode) {
      p.mode_requested = this.modeRequested;
      p.mode_note = "AGY_ALLOW_WRITE=0: write access is disabled by the orchestrator; ran read-only";
    }
    return p;
  }

  statusPayload() {
    const p = this.basePayload();
    p.has_result = this.output.length > 0 || this.streamText.length > 0;
    if (this.status !== "running") {
      const text = this.output || this.streamText;
      if (text.length > 0) {
        const max = 400;
        p.output_preview = text.length > max ? text.slice(0, max) : text;
        if (text.length > max) p.output_preview_truncated = true;
      }
    }
    return p;
  }

  resultPayload(maxChars = 20_000) {
    const p = this.basePayload();
    const text = this.output || this.streamText;
    p.output = text.length > maxChars ? text.slice(0, maxChars) : text;
    p.truncated = text.length > maxChars;
    p.tool_calls = this.toolCalls;
    p.has_result = text.length > 0;
    return p;
  }

  cancel() {
    this.cancelled = true;
    try { this.proc?.kill("SIGKILL"); } catch {}
    this.proc = null;
    this.status = "cancelled";
    this.stopReason = "cancelled";
    this.finishTurn();
  }

  close() {
    this.closed = true;
    this.clearIdleTimer();
    this.cancelled = true;
    try { this.proc?.kill("SIGKILL"); } catch {}
    this.proc = null;
  }
}

/* ------------------------------------------------------------------ */
/* Tools                                                             */
/* ------------------------------------------------------------------ */

const sessions = new Map();

function clampWait(explicit, fallback, max) {
  const n = Number(explicit ?? fallback);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(n, max));
}

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

function normalizeMode(raw) {
  return raw === "read-only" ? "read-only" : "workspace-write";
}

function normalizeModel(raw) {
  return MODELS.includes(raw) ? raw : DEFAULT_MODEL;
}

function normalizeEffort(raw) {
  return EFFORTS.includes(raw) ? raw : DEFAULT_EFFORT;
}

function sendProgress(progressToken, session, label) {
  if (progressToken === undefined || progressToken === null) return;
  const elapsed = session.elapsedSeconds();
  const last = session.lastTool?.name ? ` last_tool=${session.lastTool.name}` : "";
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

async function createSession(args) {
  const modeRequested = normalizeMode(args.mode);
  let mode = modeRequested;
  if (mode === "workspace-write" && !ALLOW_WRITE) {
    mode = "read-only";
    log("workspace-write requested but AGY_ALLOW_WRITE=0; downgrading to read-only");
  }
  const cwd = resolveCwd(args.cwd);
  const model = normalizeModel(args.model);
  const effort = normalizeEffort(args.effort);
  const session = new AgySession({ mode, modeRequested, cwd, model, effort });
  sessions.set(session.id, session);
  try {
    session.spawnProcess();
    // Wait briefly for the init event / session bootstrap.
    await new Promise((r) => setTimeout(r, 800));
    session.startTurn(String(args.prompt));
    return session;
  } catch (err) {
    sessions.delete(session.id);
    session.close();
    throw err;
  }
}

async function toolStart(args, progressToken) {
  const session = await createSession(args);
  const wait = clampWait(args.wait_seconds, args.wait ? DEFAULT_WAIT_SECONDS : 0, MAX_WAIT_SECONDS);
  if (wait > 0) await session.waitForTurn(wait, (s) => sendProgress(progressToken, s, "agy_start"));
  if (session.status === "idle") return session.resultPayload();
  return session.statusPayload();
}

/** Start every task concurrently, in one call, so N agents really run together. */
async function toolStartMany(args) {
  const tasks = Array.isArray(args.tasks) ? args.tasks : [];
  if (tasks.length === 0) throw new Error("tasks must be a non-empty array");
  if (tasks.length > 8) throw new Error("at most 8 tasks per call (each one is a bwrap+agy process)");
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
    next: `agy_wait_all(session_ids=${JSON.stringify(ids)}, wait_seconds=${DEFAULT_WAIT_SECONDS})`,
  };
}

function needSession(id) {
  const s = sessions.get(String(id));
  if (!s) throw new Error(`unknown session_id: ${id}`);
  return s;
}

async function toolSend(args, progressToken) {
  const s = needSession(args.session_id);
  if (s.status === "running") return { status: "busy", ...s.statusPayload() };
  s.startTurn(String(args.message));
  const wait = clampWait(args.wait_seconds, args.wait ? DEFAULT_WAIT_SECONDS : 0, MAX_WAIT_SECONDS);
  if (wait > 0) await s.waitForTurn(wait, (x) => sendProgress(progressToken, x, "agy_send"));
  if (s.status === "idle") return s.resultPayload();
  return s.statusPayload();
}

async function toolWait(args, progressToken) {
  const s = needSession(args.session_id);
  const wait = clampWait(args.wait_seconds, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
  if (wait > 0) await s.waitForTurn(wait, (x) => sendProgress(progressToken, x, "agy_wait"));
  if (s.status === "idle") return s.resultPayload();
  return s.statusPayload();
}

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
    if (wait > 0) await s.waitForTurn(wait, (x) => sendProgress(progressToken, x, "agy_wait_all"));
    return s.status === "idle" ? s.resultPayload() : s.statusPayload();
  }));
  const done = out.filter((x) => x.status === "idle").length;
  const running = out.filter((x) => x.status === "running").length;
  const res = { sessions: out, done, running, all_done: done === out.length };
  if (running > 0) {
    res.hint = "some sessions are still running; call agy_wait_all again with the remaining ids";
    res.remaining = out.filter((x) => x.status === "running").map((x) => x.session_id);
  }
  return res;
}

async function toolStatus(args, progressToken) {
  const s = needSession(args.session_id);
  const wait = clampWait(args.wait_seconds, 0, MAX_WAIT_SECONDS);
  await s.waitForTurn(wait, (x) => sendProgress(progressToken, x, "agy_status"));
  return s.statusPayload();
}

async function toolResult(args) {
  const s = needSession(args.session_id);
  if (s.status === "running") {
    return { status: "running", session_id: s.id, message: "still running; use agy_status" };
  }
  const max = Math.max(500, Math.min(Number(args.max_chars) || 20_000, 50_000));
  return s.resultPayload(max);
}

async function toolCancel(args) {
  const s = needSession(args.session_id);
  s.cancel();
  return { status: "cancelled", ...s.statusPayload() };
}

async function toolClose(args) {
  const s = needSession(args.session_id);
  if (s.status === "running") s.cancel();
  s.close();
  sessions.delete(s.id);
  return {
    status: "closed",
    session_id: s.id,
    conversation_id: s.conversationId,
    note: "process terminated and session forgotten; start a new session for more work",
  };
}

async function toolList() {
  return { sessions: [...sessions.values()].map((s) => s.statusPayload()) };
}

/* ------------------------------------------------------------------ */
/* MCP stdio                                                         */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: "agy_start",
    description:
      "Start ONE Antigravity (agy / Gemini 3.8 Flash) session and run a prompt. Returns quickly with session_id and " +
      "status=running. Call agy_wait(session_id) to get the result. For several independent agents use " +
      "agy_start_many in a single call — or start every agent first and only then wait; a wait before the next " +
      "start serializes the work. Workspace-write by default; use mode='read-only' for analysis (bwrap read-only).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Self-contained task. Name files by path; the agent can read them." },
        cwd: { type: "string", description: "Working directory inside the workspace (default: workspace root)." },
        mode: { type: "string", enum: ["read-only", "workspace-write"], description: "workspace-write (default) or read-only" },
        model: { type: "string", enum: MODELS, description: `default ${DEFAULT_MODEL}` },
        effort: { type: "string", enum: EFFORTS, description: `default ${DEFAULT_EFFORT}` },
        wait: { type: "boolean", description: "false (default) = return immediately; true = block here (up to 10 min)." },
        wait_seconds: { type: "number", description: "0-3600; explicit blocking wait." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "agy_start_many",
    description:
      "Start N agy sessions CONCURRENTLY in one call (max 8) and return their session_ids. Use this when a task " +
      "splits into parallel visual checks/agents. Follow with ONE agy_wait_all.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          description: "One object per agent; each becomes its own bwrap+agy process.",
          items: {
            type: "object",
            properties: {
              prompt: { type: "string" },
              cwd: { type: "string" },
              mode: { type: "string", enum: ["read-only", "workspace-write"] },
              model: { type: "string", enum: MODELS },
              effort: { type: "string", enum: EFFORTS },
            },
            required: ["prompt"],
          },
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "agy_send",
    description: "Send a follow-up message to an existing agy session (resumes the process if it was idle-closed). Returns busy if a turn is still running.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        message: { type: "string" },
        wait: { type: "boolean", description: "false (default) = return immediately; true = block here." },
        wait_seconds: { type: "number", description: "0-3600; explicit blocking wait." },
      },
      required: ["session_id", "message"],
    },
  },
  {
    name: "agy_wait",
    description:
      "Block until ONE session's turn finishes (default 10 min, max 1h) and return the full result. For several " +
      "sessions use agy_wait_all (concurrent). Claude Code auto-backgrounds long calls and notifies you on finish.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        wait_seconds: { type: "number", description: "0-3600; default 600" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "agy_wait_all",
    description:
      "Block until ALL given sessions finish (default 10 min, max 1h) and return each result. Waits run " +
      "concurrently: N agents take max(time), not sum(time). If some are still running, call again with the remaining ids.",
    inputSchema: {
      type: "object",
      properties: {
        session_ids: { type: "array", minItems: 1, maxItems: 16, items: { type: "string" } },
        wait_seconds: { type: "number", description: "0-3600; default 600" },
      },
      required: ["session_ids"],
    },
  },
  {
    name: "agy_status",
    description:
      "Compact status: state, elapsed, last tool, usage and denied actions. No full output while running; " +
      "when done, only a ~400-char preview. Use agy_wait for the result; can wait up to 1h.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        wait_seconds: { type: "number", description: "0-3600; default 0" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "agy_result",
    description: "Return the full output of the last completed turn (up to max_chars). Call once when you need the text.",
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
    name: "agy_cancel",
    description: "Cancel the current turn (kills the process; the conversation stays resumable).",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "agy_close",
    description:
      "Close a finished session now: kill its bwrap+agy process and forget it (frees RAM/processes). Sessions also " +
      "auto-close after AGY_IDLE_TTL_SECONDS (default 1800; 0 disables). A TTL-closed session resumes on the next " +
      "agy_send; one closed here does not.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "agy_list",
    description: "List agy sessions started by this MCP server.",
    inputSchema: { type: "object", properties: {} },
  },
];

function textResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], isError };
}

async function callTool(name, args, progressToken) {
  switch (name) {
    case "agy_start": return textResult(await toolStart(args, progressToken));
    case "agy_start_many": return textResult(await toolStartMany(args));
    case "agy_send": return textResult(await toolSend(args, progressToken));
    case "agy_wait": return textResult(await toolWait(args, progressToken));
    case "agy_wait_all": return textResult(await toolWaitAll(args, progressToken));
    case "agy_status": return textResult(await toolStatus(args, progressToken));
    case "agy_result": return textResult(await toolResult(args));
    case "agy_cancel": return textResult(await toolCancel(args));
    case "agy_close": return textResult(await toolClose(args));
    case "agy_list": return textResult(await toolList());
    default: return textResult(`unknown tool: ${name}`, true);
  }
}

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
        serverInfo: { name: "agy-mcp", version: "0.1.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
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
        result: textResult(`error: ${err?.message || String(err)}`, true),
      }));
    return;
  }
  if (method === "shutdown") {
    for (const s of sessions.values()) s.close();
    mcpSend({ jsonrpc: "2.0", id, result: {} });
    process.exit(0);
  }
  if (method === "exit") process.exit(0);
  if (id !== undefined) {
    mcpSend({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

process.on("SIGTERM", () => {
  for (const s of sessions.values()) s.close();
  process.exit(0);
});

log(`ready; agy=${AGY} workspace=${WORKSPACE} bwrap=${BWRAP}`);
