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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const WORKSPACE = path.resolve(process.env.AGY_WORKSPACE || process.cwd());
const BWRAP = process.env.AGY_BWRAP || "/usr/bin/bwrap";
// Auto routing: try the primary model first and, only when its quota/credits
// are exhausted, respawn the same prompt on the fallback model.
const AUTO_MODEL = "auto";
// Sonnet always runs at medium and the Gemini family always at high, no matter
// what the caller asks for. normalizeModel() enforces this.
const PRIMARY_MODEL = process.env.AGY_PRIMARY_MODEL || "claude-sonnet-5-5-medium";
const FALLBACK_MODEL = process.env.AGY_FALLBACK_MODEL || "gemini-3.8-flash-high";
const DEFAULT_MODEL = process.env.AGY_MODEL || AUTO_MODEL;
const DEFAULT_EFFORT = process.env.AGY_EFFORT || "high";
// Hydrogen is the exception to the fixed-level rule: the caller chooses the
// level per task (low/medium/high/xhigh). The bare id defaults to high.
const HYDROGEN_LEVELS = ["low", "medium", "high", "xhigh"];
const MODELS = [
  AUTO_MODEL,
  "claude-sonnet-5-5-medium",
  "gemini-4-argon-high",
  ...HYDROGEN_LEVELS.map((level) => `gemini-4-hydrogen-${level}`),
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

/* ------------------------------------------------------------------ */
/* Durable per-session state (for the out-of-band agy-wait command)   */
/* ------------------------------------------------------------------ */

const STATE_DIR = path.resolve(
  process.env.AGY_STATE_DIR || path.join(HOME, ".local", "state", "agy-mcp"),
);
const STATE_SESSIONS_DIR = path.join(STATE_DIR, "sessions");

const safeStateId = (id) => {
  if (!/^[A-Za-z0-9._-]+$/.test(String(id))) throw new Error(`invalid session id for state: ${id}`);
  return String(id);
};
const statePath = (id) => path.join(STATE_SESSIONS_DIR, `${safeStateId(id)}.json`);
const outputPath = (id) => path.join(STATE_SESSIONS_DIR, `${safeStateId(id)}.out.txt`);
const toolLogPath = (id) => path.join(STATE_SESSIONS_DIR, `${safeStateId(id)}.tools.jsonl`);

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

function extractToolCommand(input) {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return null;
  for (const key of ["CommandLine", "command", "cmd", "script", "code"]) {
    if (typeof input[key] === "string") return input[key];
  }
  return null;
}

function extractToolPaths(input) {
  const found = new Set();
  const visit = (value, key) => {
    if (typeof value === "string") {
      if (/path|file|dir|target|destination|filename|output/i.test(key) && value.trim()) {
        found.add(value);
      }
      if (/^(command|CommandLine)$/.test(key)) {
        for (const match of value.matchAll(/(?:^|\s)(\/[^\s"'`;|&<>]+)/g)) {
          found.add(match[1].replace(/[,:]+$/, ""));
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) visit(v, k);
    }
  };
  visit(input, "");
  return [...found].slice(0, 50);
}

function compactToolInput(input) {
  if (input == null) return null;
  try {
    const text = JSON.stringify(input);
    if (text.length <= 4_000) return input;
    return { truncated: true, chars: text.length, preview: text.slice(0, 4_000) };
  } catch {
    return null;
  }
}

function parseExitCode(text) {
  if (!text) return null;
  const match = /(?:exited with code|exit code:?)\s*(-?\d+)/i.exec(text)
    || /\[exit code:\s*(-?\d+)\]/i.exec(text);
  return match ? Number(match[1]) : null;
}

// Signals agy uses when the model's plan quota / AI credits are gone.
// The canonical one is the gRPC-ish `INSUFFICIENT_G1_CREDITS_BALANCE`, but the
// CLI also prints human text such as "AI: Out of credits".
const CREDIT_EXHAUSTED_RE = new RegExp([
  "INSUFFICIENT_[A-Z0-9_]*CREDIT",
  "insufficient[^\\n]{0,40}credit",
  "credit[^\\n]{0,40}(?:exhaust|insufficient|balance|depleted|out of)",
  "(?:out of|no)[^\\n]{0,20}credits?",
  "quota[^\\n]{0,40}(?:exceed|exhaust)",
  "RESOURCE_EXHAUSTED",
].join("|"), "i");

function isCreditExhaustion(text) {
  return CREDIT_EXHAUSTED_RE.test(String(text || ""));
}

function resultErrorText(result) {
  if (!result || typeof result !== "object") return "";
  return [
    result.status,
    result.error,
    result.short_error,
    result.message,
    result.response,
  ].filter(Boolean).join(" | ");
}

function normalizeProfile(raw, cwd) {
  if (!raw || typeof raw !== "object") {
    return { instructions: "", writable_dirs: [], forbidden_paths: [] };
  }
  const resolve = (value) => path.resolve(cwd, String(value));
  const writable = Array.isArray(raw.writable_dirs) ? raw.writable_dirs.map(resolve) : [];
  const forbidden = Array.isArray(raw.forbidden_paths) ? raw.forbidden_paths.map(resolve) : [];
  for (const dir of writable) {
    try { mkdirSync(dir, { recursive: true }); } catch {}
  }
  return {
    instructions: typeof raw.instructions === "string" ? raw.instructions.trim() : "",
    writable_dirs: [...new Set(writable)],
    forbidden_paths: [...new Set(forbidden)],
    silent: raw.silent === true,
  };
}

function applyProfilePrompt(prompt, profile) {
  if (!profile || (!profile.instructions && profile.writable_dirs.length === 0 && profile.forbidden_paths.length === 0)) {
    return prompt;
  }
  const lines = ["[PERFIL DA SESSÃO]"];
  if (profile.instructions) lines.push(profile.instructions);
  if (!profile.silent) {
    if (profile.writable_dirs.length > 0) lines.push(`Pastas graváveis: ${profile.writable_dirs.join(", ")}`);
    if (profile.forbidden_paths.length > 0) lines.push(`Caminhos proibidos: ${profile.forbidden_paths.join(", ")}`);
  }
  if (lines.length === 1) return prompt;
  lines.push("[FIM DO PERFIL]", "", prompt);
  return lines.join("\n");
}

function profileSummary(profile) {
  if (!profile) return null;
  return {
    instructions_chars: profile.instructions.length,
    writable_dirs: profile.writable_dirs,
    forbidden_paths: profile.forbidden_paths,
    silent: profile.silent === true,
  };
}

try {
  mkdirSync(STATE_SESSIONS_DIR, { recursive: true, mode: 0o700 });
} catch (err) {
  log("state dir unavailable:", err.message);
}

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

function buildSpawn({ mode, model, effort, cwd, conversationId, profile }) {
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
  for (const dir of profile?.writable_dirs || []) {
    if (dir === cwd) continue;
    bwrapArgs.push("--bind", dir, dir);
  }
  for (const forbidden of profile?.forbidden_paths || []) {
    if (!existsSync(forbidden)) continue;
    let isDir = false;
    try { isDir = statSync(forbidden).isDirectory(); } catch {}
    if (isDir) bwrapArgs.push("--tmpfs", forbidden);
    else bwrapArgs.push("--ro-bind", "/dev/null", forbidden);
  }
  bwrapArgs.push("--chdir", cwd, AGY, ...agyArgs);
  return { cmd: BWRAP, args: bwrapArgs, cwd };
}

/* ------------------------------------------------------------------ */
/* Session                                                           */
/* ------------------------------------------------------------------ */

let nextSession = 1;
const SESSION_PREFIX = (process.env.AGY_SESSION_PREFIX || Math.random().toString(36).slice(2, 6))
  .replace(/[^a-z0-9]/gi, "")
  .slice(0, 6) || "x";

class AgySession {
  constructor({ mode, modeRequested, cwd, model, modelRequested = null, modelNote = null, effort, effortSource = "default", conversationId = null, profile = null, router = null }) {
    this.id = `g${SESSION_PREFIX}-${nextSession++}`;
    this.mode = mode;
    this.modeRequested = modeRequested || mode;
    this.cwd = cwd;
    this.model = model;
    this.modelRequested = modelRequested || model;
    this.modelNote = modelNote;
    this.router = router;
    this.effort = effort;
    this.effortSource = effortSource;
    this.profile = profile;
    this.status = "starting";
    this.conversationId = conversationId;
    this.permissionMode = null;
    this.proc = null;
    this.buf = "";
    this.stderrTail = "";
    this.output = "";
    this.streamText = "";
    this.currentPrompt = null;
    this.turnCount = 0;
    this.lastTool = null;
    this.toolCalls = [];
    this.activeTools = new Map();
    this.usage = null;
    this.denied = null;
    this.stopReason = null;
    this.error = null;
    this.turnStartedAt = null;
    this.turnDone = null;
    this.turnResolve = null;
    this.cancelled = false;
    this.closed = false;
    this.emptyRetryUsed = false;
    this.retryNote = null;
    this.idleTimer = null;
    this.stateWriteTimer = null;
    this.lastStateWriteAt = 0;
  }

  spawnProcess() {
    const { cmd, args, cwd } = buildSpawn({
      mode: this.mode,
      model: this.model,
      effort: this.effort,
      cwd: this.cwd,
      conversationId: this.conversationId,
      profile: this.profile,
    });
    const proc = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}:${path.join(HOME, ".local", "bin")}:${process.env.PATH ?? ""}`,
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.buf = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d) => {
      if (this.proc === proc) this.onData(d);
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d) => {
      if (this.proc !== proc) return;
      this.stderrTail = (this.stderrTail + d).slice(-8192);
      log("agy stderr:", d.trim());
    });
    proc.on("error", (e) => {
      if (this.proc === proc) this.fail(e);
    });
    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return;
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
      this.writeState();
      return;
    }
    if (m.event === "step_update") {
      const u = m.step_update;
      if (!u) return;
      if (u.step_type === "tool") {
        const key = `${u.step_index}:${u.tool_name}`;
        const params = u.tool_info?.parameters;
        if (u.state === "ACTIVE") {
          const command = extractToolCommand(params);
          const paths = extractToolPaths(params);
          this.activeTools.set(key, {
            tool_name: u.tool_name,
            state: "ACTIVE",
            command,
            paths,
            exit_code: null,
          });
          this.lastTool = { name: u.tool_name, state: u.state, command };
          this.recordTool({
            event: "tool_call",
            step_index: u.step_index,
            tool_name: u.tool_name,
            state: u.state,
            command,
            paths,
            parameters: compactToolInput(params),
          });
        } else if (u.state === "DONE") {
          const output = u.tool_info?.output || "";
          const exitCode = parseExitCode(output);
          const active = this.activeTools.get(key) || {};
          this.toolCalls.push({
            ...active,
            tool_name: u.tool_name,
            state: "DONE",
            exit_code: exitCode,
            output_chars: output.length,
          });
          this.activeTools.delete(key);
          this.lastTool = {
            name: u.tool_name,
            state: u.state,
            command: active.command,
            exit_code: exitCode,
          };
          this.recordTool({
            event: "tool_call_update",
            step_index: u.step_index,
            tool_name: u.tool_name,
            state: u.state,
            exit_code: exitCode,
            output_chars: output.length,
            output_preview: output.slice(0, 4_000),
          });
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
      const text = this.output || this.streamText || "";
      const denied = Array.isArray(this.denied) ? this.denied : [];

      if (r.status !== "SUCCESS" && this.tryCreditFallback(resultErrorText(r))) {
        return;
      }

      if (r.status === "SUCCESS" && !String(text).trim()) {
        this.status = "error";
        this.error = denied.length > 0
          ? `agy returned SUCCESS with empty text after denied action(s): ${denied.join(", ")}`
          : "agy returned SUCCESS with empty text";
        if (!this.emptyRetryUsed && denied.length > 0) {
          this.emptyRetryUsed = true;
          this.retryNote = "empty SUCCESS after a denied action; retrying once without commands";
          this.writeOutput();
          this.writeState();
          this.finishTurn();
          setTimeout(() => {
            if (this.closed || this.status === "running") return;
            this.startTurn(
              "A resposta anterior veio vazia porque uma ação foi negada. Responda agora apenas com o texto final, sem executar comandos.",
              { internal: true },
            );
          }, 100);
          return;
        }
        this.retryNote = this.emptyRetryUsed ? "empty SUCCESS persisted after one retry" : null;
        this.writeOutput();
        this.writeState();
        this.finishTurn();
        return;
      }

      this.status = r.status === "SUCCESS" ? "idle" : "error";
      if (r.status !== "SUCCESS") this.error = r.error || r.status || "agy error";
      else this.error = null;
      this.retryNote = null;
      this.writeOutput();
      this.writeState();
      this.finishTurn();
    }
  }

  /** Switch an auto-routed session to the fallback model and replay the turn. */
  tryCreditFallback(reasonText) {
    if (!this.router || this.router.used_fallback || !this.currentPrompt) return false;
    const combined = `${reasonText || ""}\n${this.stderrTail || ""}`;
    if (!isCreditExhaustion(combined)) return false;
    this.restartWithFallback(reasonText || combined);
    return true;
  }

  restartWithFallback(reasonText) {
    const from = this.model;
    const prompt = this.currentPrompt;
    this.router.used_fallback = true;
    this.router.from = from;
    this.router.to = FALLBACK_MODEL;
    this.router.reason = String(reasonText || "").replace(/\s+/g, " ").slice(0, 500);
    this.router.at = new Date().toISOString();
    this.model = FALLBACK_MODEL;
    const level = effortFromModel(FALLBACK_MODEL);
    if (level) {
      this.effort = level;
      this.effortSource = "model";
    }
    this.modelNote = `auto: ${from} sem créditos; caiu para ${FALLBACK_MODEL}`;
    log(`credit fallback on ${this.id}: ${from} -> ${FALLBACK_MODEL} (${this.router.reason})`);
    const replay = this.turnCount > 1
      ? `[A sessão anterior ficou sem créditos e foi reiniciada no modelo ${FALLBACK_MODEL}; o contexto anterior não está disponível. Refaça a tarefa a partir do estado atual dos arquivos.]\n\n${prompt}`
      : prompt;

    // Drop the failed process without letting its exit handler report an error.
    this.cancelled = true;
    try { this.proc?.kill("SIGKILL"); } catch {}
    this.proc = null;
    this.buf = "";
    this.conversationId = null;
    this.stderrTail = "";
    this.output = "";
    this.streamText = "";
    this.lastTool = null;
    this.toolCalls = [];
    this.activeTools = new Map();
    this.denied = null;
    this.stopReason = null;
    this.error = null;
    this.status = "starting";

    setTimeout(() => {
      if (this.closed || this.status !== "starting" || !prompt) return;
      try {
        this.ensureProcess();
        this.startTurn(replay, { internal: true, keepTurn: true });
      } catch (err) {
        this.fail(err);
      }
    }, 800);
  }

  /** Persist the state the out-of-band agy-wait command reads. */
  writeState(extra = {}) {
    if (!this.conversationId) return;
    this.lastStateWriteAt = Date.now();
    try {
      writeJsonAtomic(statePath(this.conversationId), {
        ...this.basePayload(),
        wait_command: `agy-wait ${this.conversationId}`,
        output_file: outputPath(this.conversationId),
        tool_log: toolLogPath(this.conversationId),
        shim_pid: process.pid,
        agy_pid: this.proc?.pid ?? null,
        updated_at: new Date().toISOString(),
        ...extra,
      });
    } catch (err) {
      log("state write failed:", err.message);
    }
  }

  /** Refresh the state file while tools run, at most once per interval. */
  scheduleStateWrite(minIntervalMs = 2000) {
    if (this.stateWriteTimer) return;
    const wait = Math.max(0, minIntervalMs - (Date.now() - this.lastStateWriteAt));
    if (wait === 0) {
      this.writeState();
      return;
    }
    this.stateWriteTimer = setTimeout(() => {
      this.stateWriteTimer = null;
      this.writeState();
    }, wait);
    this.stateWriteTimer.unref?.();
  }

  clearStateWrite() {
    if (!this.stateWriteTimer) return;
    clearTimeout(this.stateWriteTimer);
    this.stateWriteTimer = null;
  }

  writeOutput() {
    if (!this.conversationId) return;
    try {
      writeFileSync(outputPath(this.conversationId), this.output || this.streamText || "", { mode: 0o600 });
    } catch (err) {
      log("output write failed:", err.message);
    }
  }

  recordTool(entry) {
    if (!this.conversationId) return;
    try {
      appendFileSync(toolLogPath(this.conversationId), JSON.stringify({
        time: new Date().toISOString(),
        session_id: this.id,
        conversation_id: this.conversationId,
        ...entry,
      }) + "\n", { mode: 0o600 });
      this.scheduleStateWrite();
    } catch (err) {
      log("tool log write failed:", err.message);
    }
  }

  toolSummary() {
    const byStatus = {};
    for (const t of this.toolCalls) {
      const status = t.state || "unknown";
      byStatus[status] = (byStatus[status] || 0) + 1;
    }
    const files = [...new Set(this.toolCalls.flatMap((t) => t.paths || []))];
    return {
      count: this.toolCalls.length,
      by_status: byStatus,
      changed_files: files.slice(0, 50),
      changed_files_truncated: files.length > 50,
      log: this.conversationId ? toolLogPath(this.conversationId) : null,
    };
  }

  fail(err) {
    if (this.status === "error") return;
    const message = err?.message || String(err);
    if (this.tryCreditFallback(message)) return;
    this.status = "error";
    this.error = message;
    this.writeOutput();
    this.writeState();
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
    if (this.closed || IDLE_TTL_SECONDS <= 0 || this.status === "running") return;
    this.idleTimer = setTimeout(() => {
      if (this.closed || this.status === "running") return;
      log(`idle TTL (${IDLE_TTL_SECONDS}s): closing ${this.id}`);
      this.close();
    }, IDLE_TTL_SECONDS * 1000);
    this.idleTimer.unref?.();
  }

  startTurn(text, { internal = false, keepTurn = false } = {}) {
    if (this.status === "running") throw new Error("session is busy; wait for the current turn");
    if (!internal) {
      this.emptyRetryUsed = false;
      this.retryNote = null;
    }
    this.clearIdleTimer();
    this.closed = false;
    this.ensureProcess();
    this.currentPrompt = text;
    this.turnCount = (this.turnCount || 0) + 1;
    this.output = "";
    this.streamText = "";
    this.lastTool = null;
    this.toolCalls = [];
    this.activeTools = new Map();
    this.denied = null;
    this.error = null;
    this.stopReason = null;
    this.turnStartedAt = Date.now();
    this.status = "running";
    if (!keepTurn) {
      this.turnDone = new Promise((resolve) => { this.turnResolve = resolve; });
    }
    this.writeState();
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
      model_requested: this.modelRequested,
      model_note: this.modelNote,
      router: this.router,
      effort: this.effort,
      effort_source: this.effortSource,
      profile: profileSummary(this.profile),
      closed: this.closed,
      elapsed_seconds: this.elapsedSeconds(),
      stop_reason: this.stopReason,
      last_tool: this.lastTool,
      output_chars: (this.output || this.streamText).length,
      usage: this.usage,
      denied_actions: this.denied,
      error: this.error,
      empty_retry_used: this.emptyRetryUsed,
      retry_note: this.retryNote,
      wait_command: this.conversationId ? `agy-wait ${this.conversationId}` : null,
      state_file: this.conversationId ? statePath(this.conversationId) : null,
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
    const tools = this.toolSummary();
    p.tool_calls_count = tools.count;
    p.tool_calls_by_status = tools.by_status;
    p.changed_files = tools.changed_files;
    p.changed_files_truncated = tools.changed_files_truncated;
    p.tool_log = tools.log;
    p.has_result = text.length > 0;
    return p;
  }

  cancel() {
    this.cancelled = true;
    this.clearStateWrite();
    try { this.proc?.kill("SIGKILL"); } catch {}
    this.proc = null;
    this.status = "cancelled";
    this.stopReason = "cancelled";
    this.writeOutput();
    this.writeState();
    this.finishTurn();
  }

  close() {
    this.closed = true;
    this.clearIdleTimer();
    this.clearStateWrite();
    this.cancelled = true;
    this.status = "closed";
    this.stopReason = "closed";
    this.writeOutput();
    this.writeState();
    try { this.proc?.kill("SIGKILL"); } catch {}
    this.proc = null;
    this.finishTurn();
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
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MODEL;
  const wanted = String(raw).trim();
  if (wanted === AUTO_MODEL) return AUTO_MODEL;
  // Fixed levels per family, regardless of the requested variant:
  // Sonnet -> medium; Argon and Flash -> high. Hydrogen keeps whatever level
  // the caller asked for (bare id -> high) and falls through the rule below.
  if (/^claude-sonnet(?:-|$)/.test(wanted)) return "claude-sonnet-5-5-medium";
  if (/^gemini-4-argon(?:-|$)/.test(wanted)) return "gemini-4-argon-high";
  const hydrogen = /^gemini-4-hydrogen(?:-(low|medium|high|xhigh))?$/.exec(wanted);
  if (hydrogen) return `gemini-4-hydrogen-${hydrogen[1] ?? "high"}`;
  if (/^gemini-3\.8-flash(?:-|$)/.test(wanted)) return "gemini-3.8-flash-high";
  return DEFAULT_MODEL;
}

function normalizeEffort(raw) {
  return EFFORTS.includes(raw) ? raw : DEFAULT_EFFORT;
}

function effortFromModel(model) {
  const match = /-(low|medium|high|xhigh)$/.exec(model || "");
  return match ? match[1] : null;
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

async function createSession(args, { conversationId = null } = {}) {
  const modeRequested = normalizeMode(args.mode);
  let mode = modeRequested;
  if (mode === "workspace-write" && !ALLOW_WRITE) {
    mode = "read-only";
    log("workspace-write requested but AGY_ALLOW_WRITE=0; downgrading to read-only");
  }
  const cwd = resolveCwd(args.cwd);
  const requestedModel = normalizeModel(args.model);
  const autoRoute = requestedModel === AUTO_MODEL;
  const model = autoRoute ? PRIMARY_MODEL : requestedModel;
  const router = autoRoute
    ? { mode: "auto", primary: PRIMARY_MODEL, fallback: FALLBACK_MODEL, used_fallback: false }
    : null;
  let modelNote = null;
  if (autoRoute) {
    modelNote = `auto: tenta ${PRIMARY_MODEL}; cai para ${FALLBACK_MODEL} se os créditos acabarem`;
  } else if (args.model && args.model !== requestedModel) {
    modelNote = `model ${args.model} normalized to ${requestedModel} (fixed level per family; Hydrogen accepts low/medium/high/xhigh)`;
  }
  const modelLevel = effortFromModel(model);
  const effort = modelLevel || normalizeEffort(args.effort);
  const effortSource = modelLevel ? "model" : (args.effort !== undefined ? "argument" : "default");
  const profile = normalizeProfile(args.profile, cwd);
  const session = new AgySession({ mode, modeRequested, cwd, model, modelRequested: requestedModel, modelNote, router, effort, effortSource, conversationId, profile });
  sessions.set(session.id, session);
  try {
    session.spawnProcess();
    // Wait briefly for the init event / session bootstrap.
    await new Promise((r) => setTimeout(r, 800));
    session.startTurn(applyProfilePrompt(String(args.prompt), profile));
    return session;
  } catch (err) {
    sessions.delete(session.id);
    session.close();
    throw err;
  }
}

function truncateText(text, max = 20_000) {
  return text.length > max ? text.slice(0, max) + "\n…[truncated]" : text;
}

function runCommandCapture(command, cwd, timeoutSeconds = 600) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timer = null;
    let settled = false;
    const finish = (exitCode, timedOut = false, spawnError = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        command,
        exit_code: exitCode,
        timed_out: timedOut,
        stdout: truncateText(stdout),
        stderr: truncateText(stderr || spawnError || ""),
        duration_ms: Date.now() - started,
      });
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => finish(127, false, err.message));
    child.on("exit", (code, signal) => finish(code ?? (signal ? 128 : 1)));
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(124, true);
    }, Math.max(1, timeoutSeconds) * 1000);
  });
}

async function verifySession(session, options, progressToken, label) {
  const command = String(options.command || "").trim();
  if (!command) return null;
  const retries = Math.max(0, Math.min(Number(options.retries) || 0, 5));
  const timeout = Math.max(1, Math.min(Number(options.timeout) || 600, 3600));
  const wait = Math.max(1, Math.min(Number(options.wait) || DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS));
  const attempts = [];

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (session.status === "running") {
      await session.waitForTurn(wait, (s) => sendProgress(progressToken, s, `${label}: wait`));
    }
    if (session.status === "running") {
      return { command, ok: false, pending: true, exit_code: attempts.at(-1)?.exit_code ?? null, attempts, note: "session still running; call agy_verify again or agy_wait" };
    }
    if (session.status !== "idle") {
      return { command, ok: false, exit_code: attempts.at(-1)?.exit_code ?? null, attempts, note: `session status=${session.status}` };
    }
    const result = await runCommandCapture(command, session.cwd, timeout);
    attempts.push(result);
    if (result.exit_code === 0) {
      return { command, ok: true, exit_code: 0, attempts };
    }
    if (attempt === retries) {
      return { command, ok: false, exit_code: result.exit_code, attempts };
    }
    session.startTurn(
      `A verificação automática falhou (exit ${result.exit_code}). Corrija e termine o trabalho.\n` +
      `Comando: ${command}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return { command, ok: false, attempts };
}

async function toolStart(args, progressToken) {
  const session = await createSession(args);
  const wait = clampWait(args.wait_seconds, args.wait ? DEFAULT_WAIT_SECONDS : 0, MAX_WAIT_SECONDS);
  if (wait > 0) await session.waitForTurn(wait, (s) => sendProgress(progressToken, s, "agy_start"));
  let verification = null;
  if (args.verify_command) {
    verification = wait > 0
      ? await verifySession(session, {
        command: args.verify_command,
        retries: args.verify_retries,
        timeout: args.verify_timeout_seconds,
        wait,
      }, progressToken, "agy_start: verify")
      : { command: args.verify_command, pending: true, note: "set wait_seconds>0 or call agy_verify after the turn" };
  }
  const payload = session.status !== "running" ? session.resultPayload() : session.statusPayload();
  if (verification) payload.verification = verification;
  return payload;
}

/**
 * Reattach to a persisted agy conversation with --conversation and send the
 * first prompt of the new process. The gN aliases are in-memory; the UUID
 * survives in agy's conversation store.
 */
async function toolResume(args, progressToken) {
  const conversationId = String(args.conversation_id || "").trim();
  if (!conversationId) throw new Error("conversation_id is required");
  if (!args.prompt || !String(args.prompt).trim()) throw new Error("prompt is required");
  const session = await createSession(args, { conversationId });
  const wait = clampWait(args.wait_seconds, args.wait ? DEFAULT_WAIT_SECONDS : 0, MAX_WAIT_SECONDS);
  if (wait > 0) await session.waitForTurn(wait, (s) => sendProgress(progressToken, s, "agy_resume"));
  let verification = null;
  if (args.verify_command) {
    verification = wait > 0
      ? await verifySession(session, {
        command: args.verify_command,
        retries: args.verify_retries,
        timeout: args.verify_timeout_seconds,
        wait,
      }, progressToken, "agy_resume: verify")
      : { command: args.verify_command, pending: true, note: "set wait_seconds>0 or call agy_verify after the turn" };
  }
  const payload = session.status !== "running" ? session.resultPayload() : session.statusPayload();
  if (verification) payload.verification = verification;
  return payload;
}

async function toolVerify(args, progressToken) {
  const session = needSession(args.session_id);
  const verification = await verifySession(session, {
    command: args.command,
    retries: args.retries,
    timeout: args.timeout_seconds,
    wait: clampWait(args.wait_seconds, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS),
  }, progressToken, "agy_verify");
  const payload = session.status !== "running" ? session.resultPayload() : session.statusPayload();
  payload.verification = verification;
  return payload;
}

/** Start every task concurrently, in one call, so N agents really run together. */
async function toolStartMany(args) {
  const tasks = Array.isArray(args.tasks) ? args.tasks : [];
  if (tasks.length === 0) throw new Error("tasks must be a non-empty array");
  if (tasks.length > 12) throw new Error("at most 12 tasks per call (each one is a bwrap+agy process)");
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

async function toolConversations(args) {
  const cwd = args.cwd ? resolveCwd(args.cwd) : null;
  const limit = Math.max(1, Math.min(Number(args.limit) || 50, 200));
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (err) {
    throw new Error("node:sqlite is unavailable: " + err.message);
  }
  const dbPath = path.join(HOME, ".gemini", "antigravity-cli", "conversation_summaries.db");
  if (!existsSync(dbPath)) {
    return { cwd, conversations: [], count: 0, note: "agy conversation database not found" };
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      "select conversation_id, title, status, not_fully_idle, last_modified_time, last_user_input_time, workspace_uris " +
      "from conversation_summaries order by last_modified_time desc limit ?",
    ).all(limit);
    const want = cwd ? `file://${cwd}` : null;
    const conversations = rows
      .filter((row) => !want || String(row.workspace_uris || "").includes(want))
      .map((row) => {
        let workspace = row.workspace_uris;
        try { workspace = JSON.parse(row.workspace_uris); } catch {}
        return {
          conversation_id: row.conversation_id,
          title: row.title,
          status: row.status,
          busy: Boolean(row.not_fully_idle),
          last_modified_time: row.last_modified_time,
          last_user_input_time: row.last_user_input_time,
          workspace,
        };
      });
    return {
      cwd,
      conversations,
      count: conversations.length,
      note: "Use agy_resume(conversation_id=..., prompt=...) to continue one.",
    };
  } finally {
    db.close();
  }
}

async function toolSend(args, progressToken) {
  const s = needSession(args.session_id);
  if (s.status === "running") {
    return { ...s.statusPayload(), busy: true, note: "a turn is still in flight; this message was NOT queued. Wait with agy_wait or interrupt with agy_cancel first." };
  }
  s.startTurn(String(args.message));
  const wait = clampWait(args.wait_seconds, args.wait ? DEFAULT_WAIT_SECONDS : 0, MAX_WAIT_SECONDS);
  if (wait > 0) await s.waitForTurn(wait, (x) => sendProgress(progressToken, x, "agy_send"));
  if (s.status !== "running") return s.resultPayload();
  return s.statusPayload();
}

async function toolWait(args, progressToken) {
  const s = needSession(args.session_id);
  const wait = clampWait(args.wait_seconds, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
  if (wait > 0) await s.waitForTurn(wait, (x) => sendProgress(progressToken, x, "agy_wait"));
  if (s.status !== "running") return s.resultPayload();
  return s.statusPayload();
}

function waitSummary(session) {
  const p = session.statusPayload();
  const tools = session.toolSummary();
  p.tool_calls_count = tools.count;
  p.tool_calls_by_status = tools.by_status;
  p.tool_log = tools.log;
  p.result_command = `agy_result(session_id="${session.id}")`;
  return p;
}

async function toolWaitAll(args, progressToken) {
  const ids = Array.isArray(args.session_ids) ? args.session_ids.map(String) : [];
  if (ids.length === 0) throw new Error("session_ids must be a non-empty array");
  const wait = clampWait(args.wait_seconds, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
  const full = args.full === true;
  const out = await Promise.all(ids.map(async (id) => {
    let s;
    try {
      s = needSession(id);
    } catch (err) {
      return { session_id: id, status: "unknown", error: err.message || String(err) };
    }
    if (wait > 0) await s.waitForTurn(wait, (x) => sendProgress(progressToken, x, "agy_wait_all"));
    if (s.status === "running") return s.statusPayload();
    return full ? s.resultPayload() : waitSummary(s);
  }));
  const done = out.filter((x) => x.status === "idle").length;
  const failed = out.filter((x) => ["error", "cancelled", "closed", "unknown"].includes(x.status)).length;
  const running = out.filter((x) => x.status === "running").length;
  const res = { sessions: out, done, failed, running, all_done: done + failed === out.length };
  if (running > 0) {
    res.hint = "some sessions are still running; call agy_wait_all again with the remaining ids";
    res.remaining = out.filter((x) => x.status === "running").map((x) => x.session_id);
  } else if (!full) {
    res.hint = "compact results: use agy_result(session_id) or agy_wait_all(full=true) for full output";
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
  return { ...s.resultPayload(), status: "cancelled" };
}

async function toolClose(args) {
  const s = needSession(args.session_id);
  const final = s.resultPayload();
  final.partial = s.status === "running";
  if (s.status === "running") s.cancel();
  s.close();
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
/* MCP stdio                                                         */
/* ------------------------------------------------------------------ */

const PROFILE_SCHEMA = {
  type: "object",
  description: "Per-session guardrails. Paths are relative to cwd or absolute.",
  properties: {
    instructions: { type: "string", description: "Default text prepended to this prompt." },
    writable_dirs: { type: "array", items: { type: "string" }, description: "Extra directories this session may write." },
    forbidden_paths: { type: "array", items: { type: "string" }, description: "Paths this session must not use (hidden/denied)." },
    silent: { type: "boolean", description: "Do not disclose the path lists in the prompt; enforcement still applies." },
  },
};

const TOOLS = [
  {
    name: "agy_start",
    description:
      "Start ONE Antigravity (agy / Gemini) session and run a prompt. Returns quickly with session_id and " +
      "status=running. Call agy_wait(session_id) to get the result. The returned conversation_id is durable: " +
      "agy_resume can reattach after a restart/crash. For several independent agents use " +
      "agy_start_many in a single call — or start every agent first and only then wait; a wait before the next " +
      "start serializes the work. Workspace-write by default; use mode='read-only' for analysis (bwrap read-only).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Self-contained task. Name files by path; the agent can read them." },
        cwd: { type: "string", description: "Working directory inside the workspace (default: workspace root)." },
        mode: { type: "string", enum: ["read-only", "workspace-write"], description: "workspace-write (default) or read-only" },
        model: { type: "string", enum: MODELS, description: `default ${DEFAULT_MODEL} (auto: ${PRIMARY_MODEL} first, ${FALLBACK_MODEL} if credits run out)` },
        effort: { type: "string", enum: EFFORTS, description: `default ${DEFAULT_EFFORT}` },
        profile: PROFILE_SCHEMA,
        verify_command: { type: "string", description: "Optional test of THIS delegated work, not the repo-wide gate. If it fails, the agent gets the error; keep verify_retries=0 for delegated tasks." },
        verify_retries: { type: "number", description: "0-5; default 0 (keep 0 for delegated tasks)" },
        verify_timeout_seconds: { type: "number", description: "default 600" },
        wait: { type: "boolean", description: "false (default) = return immediately; true = block here (up to 10 min)." },
        wait_seconds: { type: "number", description: "0-3600; explicit blocking wait." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "agy_start_many",
    description:
      "Start N agy sessions CONCURRENTLY in one call (max 12) and return their session_ids. Use this when a task " +
      "splits into parallel visual checks/agents. Follow with ONE agy_wait_all.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          description: "One object per agent; each becomes its own bwrap+agy process.",
          items: {
            type: "object",
            properties: {
              prompt: { type: "string" },
              cwd: { type: "string" },
              mode: { type: "string", enum: ["read-only", "workspace-write"] },
              model: { type: "string", enum: MODELS, description: `default ${DEFAULT_MODEL} (auto: ${PRIMARY_MODEL} then ${FALLBACK_MODEL})` },
              effort: { type: "string", enum: EFFORTS },
              profile: PROFILE_SCHEMA,
            },
            required: ["prompt"],
          },
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "agy_resume",
    description:
      "Resume a persisted agy conversation by its durable conversation_id (the UUID returned in conversation_id, " +
      "not the local gN alias) and send a prompt — use this after a Claude/agy restart or crash. This runs agy with " +
      "--conversation and keeps the conversation history. Background commands and in-flight tools are gone: the " +
      "agent may need to redo the interrupted step. Follow with agy_wait.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "UUID of the agy conversation" },
        prompt: { type: "string", description: "Message to send on resume, e.g. 'Continue de onde parou'" },
        cwd: { type: "string", description: "Working directory inside the project (default: project root)" },
        mode: { type: "string", enum: ["read-only", "workspace-write"], description: "workspace-write (default) or read-only" },
        model: { type: "string", enum: MODELS, description: `default ${DEFAULT_MODEL} (auto: ${PRIMARY_MODEL} first, ${FALLBACK_MODEL} if credits run out)` },
        effort: { type: "string", enum: EFFORTS, description: `default ${DEFAULT_EFFORT}` },
        profile: PROFILE_SCHEMA,
        verify_command: { type: "string", description: "Optional test of THIS delegated work, not the repo-wide gate. If it fails, the agent gets the error; keep verify_retries=0 for delegated tasks." },
        verify_retries: { type: "number", description: "0-5; default 0 (keep 0 for delegated tasks)" },
        verify_timeout_seconds: { type: "number", description: "default 600" },
        wait: { type: "boolean", description: "false (default) = return immediately; true = block here." },
        wait_seconds: { type: "number", description: "0-3600; explicit blocking wait." },
      },
      required: ["conversation_id", "prompt"],
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
      "sessions use agy_wait_all (concurrent). Claude Code auto-backgrounds long calls and notifies you on finish. " +
      "NON-BLOCKING ALTERNATIVE: run `agy-wait <conversation_id>` with Bash run_in_background.",
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
      "concurrently: N agents take max(time), not sum(time). If some are still running, call again with the remaining ids. " +
      "By default returns compact previews (use agy_result for full text); pass full=true to get the full output. " +
      "NON-BLOCKING ALTERNATIVE: run `agy-wait <conversation_id> [...]` with Bash run_in_background.",
    inputSchema: {
      type: "object",
      properties: {
        session_ids: { type: "array", minItems: 1, maxItems: 16, items: { type: "string" } },
        wait_seconds: { type: "number", description: "0-3600; default 600" },
        full: { type: "boolean", description: "false (default) = compact previews; true = full output per session" },
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
    name: "agy_verify",
    description:
      "Run a test command in the session's cwd and return its exit code. If it fails, send the error back to the agent " +
      "and retry up to retries times. Use only this work's tests; the repo-wide gate stays with the coordinator. Use after agy_wait, or set verify_command on start/resume.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        command: { type: "string" },
        retries: { type: "number", description: "0-5; default 0 (keep 0 for delegated tasks)" },
        timeout_seconds: { type: "number", description: "default 600" },
        wait_seconds: { type: "number", description: "how long to wait for the current turn; default 600" },
      },
      required: ["session_id", "command"],
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
    description: "List agy sessions started by THIS MCP server process (live only; empty after a restart). Use agy_conversations for persisted conversations.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agy_conversations",
    description:
      "List persisted agy conversations from the local conversation database (survives restarts), newest first. " +
      "Use the returned conversation_id with agy_resume.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Workspace directory (default: project root)" },
        limit: { type: "number", description: "1-200; default 50" },
      },
    },
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
    case "agy_resume": return textResult(await toolResume(args, progressToken));
    case "agy_send": return textResult(await toolSend(args, progressToken));
    case "agy_wait": return textResult(await toolWait(args, progressToken));
    case "agy_wait_all": return textResult(await toolWaitAll(args, progressToken));
    case "agy_status": return textResult(await toolStatus(args, progressToken));
    case "agy_result": return textResult(await toolResult(args));
    case "agy_verify": return textResult(await toolVerify(args, progressToken));
    case "agy_cancel": return textResult(await toolCancel(args));
    case "agy_close": return textResult(await toolClose(args));
    case "agy_list": return textResult(await toolList());
    case "agy_conversations": return textResult(await toolConversations(args));
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
