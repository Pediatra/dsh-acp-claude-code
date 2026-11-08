#!/usr/bin/env node
/**
 * dsh-acp-mcp — expose DeepSeek Harness agents to Claude Code over MCP,
 * using the official ACP server (`dsh --profile acp`) as the transport.
 *
 * No HTTP, no browser cookie, no token: ACP is local JSON-RPC over stdio.
 * Workspace-write by default (sandboxed to cwd); use mode="read-only" for analysis.
 */

import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { createServer } from "node:net";
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
// Cold starts used to time out at 30 s while npx was reinstalling the whole
// dependency tree. A stable binary starts in seconds; keep a generous margin.
const INIT_TIMEOUT_MS = (() => {
  const n = Number(process.env.DSH_ACP_INIT_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
})();
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
/* Durable per-session state (for the out-of-band dsh-wait command)   */
/* ------------------------------------------------------------------ */

const STATE_DIR = path.resolve(
  process.env.DSH_ACP_STATE_DIR || path.join(os.homedir(), ".local", "state", "dsh-acp-mcp"),
);
const STATE_SESSIONS_DIR = path.join(STATE_DIR, "sessions");
const CONTROL_DIR = path.join(STATE_DIR, "control");
const CONTROL_SOCKET = path.join(CONTROL_DIR, `shim-${process.pid}.sock`);
const CONTROL_REGISTRY = path.join(CONTROL_DIR, `shim-${process.pid}.json`);

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

try {
  mkdirSync(STATE_SESSIONS_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 });
} catch (err) {
  log("state dir unavailable:", err.message);
}

/* ------------------------------------------------------------------ */
/* Resolve the dsh binary                                             */
/* ------------------------------------------------------------------ */

function findDsh() {
  const explicit = process.env.DSH_BIN;
  if (explicit && existsSync(explicit)) return { cmd: explicit, prefix: [] };

  // Stable installation: survives `npm cache clean`, npm updates and npx
  // cache pruning. install-dsh.sh creates this symlink.
  const local = path.join(os.homedir(), ".local", "bin", "dsh");
  if (existsSync(local)) return { cmd: local, prefix: [] };

  const stable = path.join(
    os.homedir(), ".local", "share", "dsh-stable", "node_modules", ".bin", "dsh",
  );
  if (existsSync(stable)) return { cmd: stable, prefix: [] };

  // Last resort for an already-populated npx cache. Never invoke npx here:
  // a cold install takes minutes and the ACP initialize deadline expires.
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

  throw new Error(
    "dsh binary not found. Run dsh-acp/bin/install-dsh.sh (or set DSH_BIN). " +
    "The npx cache is ephemeral and npm cache clean removes it.",
  );
}

/* ------------------------------------------------------------------ */
/* Tool-call extraction                                               */
/* ------------------------------------------------------------------ */

function extractToolCommand(input) {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return null;
  for (const key of ["command", "CommandLine", "cmd", "script", "code"]) {
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

const HOST_SPAWN_POLICY = `#!/usr/bin/env python3
import json, os, re, sys

policy_path = os.environ.get("DSH_ACP_PROFILE_FILE")
real = os.environ.get("DSH_ACP_REAL_HOST_SPAWN", "/usr/bin/host-spawn")
args = sys.argv[1:]
if not policy_path or not os.path.exists(policy_path):
    os.execv(real, [real] + args)
try:
    policy = json.load(open(policy_path))
except Exception:
    sys.stderr.write("host-spawn policy: cannot read profile\\n")
    sys.exit(126)

def realpath(value):
    return os.path.realpath(os.path.expanduser(value))

def inside(value, root):
    return value == root or value.startswith(root + os.sep)

cwd = realpath(policy.get("cwd", ""))
forbidden = [realpath(p) for p in policy.get("forbidden_paths", [])]
writable = [realpath(p) for p in policy.get("writable_dirs", [])]
joined = " ".join(args)

for path in forbidden:
    for token in joined.split():
        token = token.strip("'\\"")
        if token == path or token.startswith(path + ":") or token.startswith(path + "/"):
            sys.stderr.write("host-spawn policy: forbidden path: " + path + "\\n")
            sys.exit(126)

def allow_mount(src):
    src = realpath(src)
    if any(inside(src, root) for root in forbidden):
        return False
    return inside(src, cwd) or any(inside(src, root) for root in writable)

for i, arg in enumerate(args):
    spec = None
    if arg in ("-v", "--volume") and i + 1 < len(args):
        spec = args[i + 1]
    elif arg.startswith("--volume="):
        spec = arg.split("=", 1)[1]
    elif arg == "--mount" and i + 1 < len(args):
        match = re.search(r"(?:source|src)=([^,]+)", args[i + 1])
        if match:
            spec = match.group(1)
    elif arg.startswith("--mount"):
        match = re.search(r"(?:source|src)=([^,]+)", arg)
        if match:
            spec = match.group(1)
    if spec:
        src = spec.split(":", 1)[0]
        if not allow_mount(src):
            sys.stderr.write("host-spawn policy: mount source outside allowed dirs: " + src + "\\n")
            sys.exit(126)

for match in re.finditer(r"(?:-v|--volume)\\s+([^\\s:]+)", joined):
    if not allow_mount(match.group(1)):
        sys.stderr.write("host-spawn policy: mount source outside allowed dirs: " + match.group(1) + "\\n")
        sys.exit(126)

os.execv(real, [real] + args)
`;

function toolResultText(update) {
  const parts = [];
  for (const block of update.content || []) {
    if (block?.content?.type === "text" && typeof block.content.text === "string") {
      parts.push(block.content.text);
    } else if (typeof block?.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function parseExitCode(text) {
  if (!text) return null;
  const match = /\[exit code:\s*(-?\d+)\]/i.exec(text)
    || /(?:exited with code|exit code:?)\s*(-?\d+)/i.exec(text);
  return match ? Number(match[1]) : null;
}

/* ------------------------------------------------------------------ */
/* ACP client (JSON lines over stdio)                                 */
/* ------------------------------------------------------------------ */

let nextSession = 1;
const SESSION_PREFIX = (process.env.DSH_ACP_SESSION_PREFIX || Math.random().toString(36).slice(2, 6))
  .replace(/[^a-z0-9]/gi, "")
  .slice(0, 6) || "x";

class AcpSession {
  constructor({ mode, cwd, effort = DEFAULT_EFFORT, resumeSessionId = null, profile = null }) {
    this.id = `s${SESSION_PREFIX}-${nextSession++}`;
    this.mode = mode;
    this.cwd = cwd;
    this.model = DEFAULT_MODEL;
    this.effort = effort;
    this.resumeSessionId = resumeSessionId;
    this.profile = profile;
    this.policyDir = null;
    this.status = "starting";
    this.sessionId = null;
    this.proc = null;
    this.buf = "";
    this.pending = new Map();
    this.nextRpc = 1;
    this.output = "";
    this.toolCalls = [];
    this.policyBlock = null;
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

    let policyFile = null;
    let sandboxPatch = null;
    if (profile && (profile.forbidden_paths.length > 0 || profile.writable_dirs.length > 0)) {
      try {
        this.policyDir = path.join(STATE_DIR, "policy", `${this.id}-${process.pid}`);
        mkdirSync(this.policyDir, { recursive: true, mode: 0o700 });
        policyFile = path.join(this.policyDir, "profile.json");
        writeFileSync(policyFile, JSON.stringify({ cwd: this.cwd, ...profile }, null, 2) + "\n", { mode: 0o600 });
        writeFileSync(path.join(this.policyDir, "host-spawn"), HOST_SPAWN_POLICY, { mode: 0o755 });
        if (profile.writable_dirs.length > 0) {
          sandboxPatch = path.join(this.policyDir, "sandbox-patch.yml");
          const roots = profile.writable_dirs
            .map((root) => `      - ${JSON.stringify(root)}`)
            .join("\n");
          writeFileSync(
            sandboxPatch,
            "- id: sandbox-policy\n" +
            "  name: '@deepseek-ai/dsh-sandbox-policy'\n" +
            "  config:\n" +
            "    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'\n" +
            "    workspaceRoot: !!js process.cwd()\n" +
            "    additionalWritableRoots:\n" +
            roots + "\n",
            { mode: 0o600 },
          );
        }
      } catch (err) {
        log("policy setup failed:", err.message);
        this.policyDir = null;
        policyFile = null;
        sandboxPatch = null;
      }
    }
    if (sandboxPatch) args.push("--patch", sandboxPatch);
    const childPath = [this.policyDir, path.dirname(process.execPath), process.env.PATH]
      .filter(Boolean)
      .join(":");

    this.proc = spawn(cmd, args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        PATH: childPath,
        DSH_PERMISSION_MODE: mode === "workspace-write" ? "workspace-write" : "read-only",
        NO_COLOR: "1",
        ...(policyFile ? {
          DSH_ACP_PROFILE_FILE: policyFile,
          DSH_ACP_REAL_HOST_SPAWN: process.env.DSH_ACP_REAL_HOST_SPAWN || "/usr/bin/host-spawn",
        } : {}),
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
        const title = u.title || u.kind || "tool";
        const command = extractToolCommand(u.rawInput);
        const paths = extractToolPaths(u.rawInput);
        const hit = this.forbiddenHit(u.rawInput);
        if (hit) {
          this.policyBlock = {
            path: hit,
            tool_call_id: u.toolCallId,
            command,
            time: new Date().toISOString(),
          };
          this.recordTool({
            event: "policy_block",
            tool_call_id: u.toolCallId,
            path: hit,
            command,
            raw_input: compactToolInput(u.rawInput),
          });
          this.notify("session/cancel", { sessionId: this.sessionId });
        }
        this.lastTool = { title, status: u.status || "pending", command, tool_call_id: u.toolCallId, policy_block: hit || undefined };
        this.toolCalls.push({
          tool_call_id: u.toolCallId,
          title,
          status: u.status || "pending",
          command,
          paths,
          exit_code: null,
          policy_block: hit || undefined,
        });
        this.recordTool({
          event: "tool_call",
          tool_call_id: u.toolCallId,
          title,
          kind: u.kind,
          status: u.status || "pending",
          command,
          paths,
          policy_block: hit || undefined,
          raw_input: compactToolInput(u.rawInput),
        });
      } else if (u.sessionUpdate === "tool_call_update") {
        const text = toolResultText(u);
        const exitCode = parseExitCode(text) ?? (u.status === "completed" ? 0 : null);
        const call = this.toolCalls.find((t) => t.tool_call_id === u.toolCallId);
        if (call) {
          if (u.status) call.status = u.status;
          call.exit_code = exitCode;
          call.output_chars = text.length;
          this.lastTool = {
            title: call.title,
            status: call.status,
            command: call.command,
            exit_code: call.exit_code,
            tool_call_id: call.tool_call_id,
          };
        }
        this.recordTool({
          event: "tool_call_update",
          tool_call_id: u.toolCallId,
          status: u.status,
          exit_code: exitCode,
          output_chars: text.length,
          output_preview: text.slice(0, 4_000),
        });
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

  /** Persist the state the out-of-band dsh-wait command reads. */
  writeState(extra = {}) {
    if (!this.sessionId) return;
    try {
      writeJsonAtomic(statePath(this.sessionId), {
        ...this.basePayload(),
        wait_command: `dsh-wait ${this.sessionId}`,
        output_file: outputPath(this.sessionId),
        tool_log: toolLogPath(this.sessionId),
        shim_pid: process.pid,
        acp_pid: this.proc?.pid ?? null,
        updated_at: new Date().toISOString(),
        ...extra,
      });
    } catch (err) {
      log("state write failed:", err.message);
    }
  }

  writeOutput() {
    if (!this.sessionId) return;
    try {
      writeFileSync(outputPath(this.sessionId), this.output ?? "", { mode: 0o600 });
    } catch (err) {
      log("output write failed:", err.message);
    }
  }

  /** Append one tool lifecycle event to the per-session JSONL log. */
  recordTool(entry) {
    if (!this.sessionId) return;
    try {
      appendFileSync(toolLogPath(this.sessionId), JSON.stringify({
        time: new Date().toISOString(),
        session_id: this.id,
        dsh_session_id: this.sessionId,
        ...entry,
      }) + "\n", { mode: 0o600 });
    } catch (err) {
      log("tool log write failed:", err.message);
    }
  }

  /** Compact replacement for the old full tool_calls array in results. */
  toolSummary() {
    const byStatus = {};
    for (const t of this.toolCalls) {
      const status = t.status || "unknown";
      byStatus[status] = (byStatus[status] || 0) + 1;
    }
    const files = [...new Set(this.toolCalls.flatMap((t) => t.paths || []))];
    return {
      count: this.toolCalls.length,
      by_status: byStatus,
      changed_files: files.slice(0, 50),
      changed_files_truncated: files.length > 50,
      log: this.sessionId ? toolLogPath(this.sessionId) : null,
    };
  }

  /** Return the first forbidden path referenced by a tool input, if any. */
  forbiddenHit(input) {
    const forbidden = this.profile?.forbidden_paths || [];
    if (forbidden.length === 0) return null;
    const command = extractToolCommand(input) || "";
    const paths = extractToolPaths(input);
    for (const path of forbidden) {
      if (command.includes(path)) return path;
      if (paths.some((candidate) => candidate === path || candidate.startsWith(path + "/"))) return path;
    }
    return null;
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
    this.writeOutput();
    this.writeState();
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
    await this.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, INIT_TIMEOUT_MS);
    let state;
    if (this.resumeSessionId) {
      state = await this.request(
        "session/resume",
        { sessionId: this.resumeSessionId, cwd: this.cwd, mcpServers: [] },
        INIT_TIMEOUT_MS,
      );
      this.sessionId = this.resumeSessionId;
    } else {
      state = await this.request("session/new", { cwd: this.cwd, mcpServers: [] }, INIT_TIMEOUT_MS);
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
    this.writeState();
  }

  prompt(text) {
    if (this.busy) {
      throw new Error("session is busy; call deepseek_wait to keep waiting, or deepseek_cancel to interrupt the current turn");
    }
    this.clearIdleTimer();
    this.output = "";
    this.toolCalls = [];
    this.policyBlock = null;
    this.stopReason = null;
    this.error = null;
    this.lastTool = null;
    this.cancelRequestedAt = null;
    this.turnStartedAt = Date.now();
    this.status = "running";
    this.promptPending = true;
    const turn = ++this.turnSeq;
    this.turnDone = new Promise((resolve) => { this.turnResolve = resolve; });
    this.writeState();
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
        this.writeOutput();
        this.writeState();
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
      profile: profileSummary(this.profile),
      elapsed_seconds: this.elapsedSeconds(),
      stop_reason: this.stopReason,
      last_tool: this.lastTool,
      output_chars: this.output.length,
      usage: this.usage,
      error: this.error,
      policy_block: this.policyBlock,
      wait_command: this.sessionId ? `dsh-wait ${this.sessionId}` : null,
      state_file: this.sessionId ? statePath(this.sessionId) : null,
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
    if (this.policyBlock) {
      p.hint = `profile policy blocked forbidden path: ${this.policyBlock.path}`;
      p.next = `deepseek_status(session_id="${this.id}") or deepseek_close(session_id="${this.id}")`;
    } else if (this.cancelRequestedAt) {
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
    const tools = this.toolSummary();
    p.tool_calls_count = tools.count;
    p.tool_calls_by_status = tools.by_status;
    p.changed_files = tools.changed_files;
    p.changed_files_truncated = tools.changed_files_truncated;
    p.tool_log = tools.log;
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
    this.writeOutput();
    this.writeState();
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
  const profile = normalizeProfile(args.profile, cwd);
  if (resumeSessionId) {
    for (const s of sessions.values()) {
      if (s.sessionId === resumeSessionId) {
        throw new Error(`session ${resumeSessionId} is already open as ${s.id}; use that session or close it first`);
      }
    }
  }
  const session = new AcpSession({ mode, cwd, effort, resumeSessionId, profile });
  sessions.set(session.id, session);
  try {
    await session.init({ configure: !resumeSessionId });
    session.prompt(applyProfilePrompt(String(args.prompt), profile));
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
  let verification = null;
  if (args.verify_command) {
    verification = wait > 0
      ? await verifySession(session, {
        command: args.verify_command,
        retries: args.verify_retries,
        timeout: args.verify_timeout_seconds,
        wait,
      }, progressToken, "deepseek_start: verify")
      : { command: args.verify_command, pending: true, note: "set wait_seconds>0 or call deepseek_verify after the turn" };
  }
  const payload = session.busy ? session.statusPayload() : session.resultPayload();
  if (verification) payload.verification = verification;
  return payload;
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
  let verification = null;
  if (args.verify_command) {
    verification = wait > 0
      ? await verifySession(session, {
        command: args.verify_command,
        retries: args.verify_retries,
        timeout: args.verify_timeout_seconds,
        wait,
      }, progressToken, "deepseek_resume: verify")
      : { command: args.verify_command, pending: true, note: "set wait_seconds>0 or call deepseek_verify after the turn" };
  }
  const payload = session.busy ? session.statusPayload() : session.resultPayload();
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
  }, progressToken, "deepseek_verify");
  const payload = session.busy ? session.statusPayload() : session.resultPayload();
  payload.verification = verification;
  return payload;
}

/**
 * Starts every task concurrently, in one tool call. This is the only way to
 * guarantee parallel agents: interleaving start/wait in separate calls makes
 * each wait block the next start.
 */
async function toolStartMany(args) {
  const tasks = Array.isArray(args.tasks) ? args.tasks : [];
  if (tasks.length === 0) throw new Error("tasks must be a non-empty array");
  if (tasks.length > 12) throw new Error("at most 12 tasks per call (each one is a DSH process)");
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
function waitSummary(session) {
  const p = session.statusPayload();
  const tools = session.toolSummary();
  p.tool_calls_count = tools.count;
  p.tool_calls_by_status = tools.by_status;
  p.tool_log = tools.log;
  p.result_command = `deepseek_result(session_id="${session.id}")`;
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
    if (wait > 0) await s.waitForTurn(wait, (x) => sendProgress(progressToken, x, "deepseek_wait_all"));
    if (s.busy) return s.statusPayload();
    return full ? s.resultPayload() : waitSummary(s);
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
  } else if (!full) {
    res.hint = "compact results: use deepseek_result(session_id) or deepseek_wait_all(full=true) for full output";
  }
  return res;
}

function needSession(id) {
  const s = sessions.get(String(id));
  if (!s) throw new Error(`unknown session_id: ${id}`);
  return s;
}

function dshSessionsRoot(cwd) {
  const encoded = "-" + cwd.replaceAll("/", "-") + "--";
  return path.join(os.homedir(), ".dsh", "sessions", encoded);
}

function listPersistedDshSessions(cwd, limit) {
  const root = dshSessionsRoot(cwd);
  if (!existsSync(root)) return [];
  const rows = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "session.v4.jsonl.zstd");
    if (!existsSync(file)) continue;
    const stat = statSync(file);
    rows.push({
      dsh_session_id: entry.name,
      cwd,
      updated_at: new Date(stat.mtimeMs).toISOString(),
      size_bytes: stat.size,
      log: file,
    });
  }
  rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return rows.slice(0, limit);
}

function truncateText(text, max = 20_000) {
  return text.length > max ? text.slice(0, max) + "\n…[truncated]" : text;
}

/** Run the user's verification command on the host, capturing its exit code. */
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

/** Run the verification command; on failure, send the error back to the agent. */
async function verifySession(session, options, progressToken, label) {
  const command = String(options.command || "").trim();
  if (!command) return null;
  const retries = Math.max(0, Math.min(Number(options.retries) || 0, 5));
  const timeout = Math.max(1, Math.min(Number(options.timeout) || 600, 3600));
  const wait = Math.max(1, Math.min(Number(options.wait) || DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS));
  const attempts = [];

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (session.busy) {
      await session.waitForTurn(wait, (s) => sendProgress(progressToken, s, `${label}: wait`));
    }
    if (session.busy) {
      return { command, ok: false, pending: true, exit_code: attempts.at(-1)?.exit_code ?? null, attempts, note: "session still running; call deepseek_verify again or deepseek_wait" };
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
    session.prompt(
      `A verificação automática falhou (exit ${result.exit_code}). Corrija e termine o trabalho.\n` +
      `Comando: ${command}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return { command, ok: false, attempts };
}

async function toolSessions(args) {
  const cwd = resolveCwd(args.cwd);
  const limit = Math.max(1, Math.min(Number(args.limit) || 50, 200));
  const rows = listPersistedDshSessions(cwd, limit);
  return {
    cwd,
    sessions: rows,
    count: rows.length,
    note: "Persisted sessions survive restarts. Resume one with deepseek_resume(dsh_session_id=..., prompt=...).",
  };
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
        profile: PROFILE_SCHEMA,
        verify_command: { type: "string", description: "Optional test of THIS delegated work, not the repo-wide gate. If it fails, the agent gets the error; keep verify_retries=0 for delegated tasks." },
        verify_retries: { type: "number", description: "0-5; default 0 (keep 0 for delegated tasks)" },
        verify_timeout_seconds: { type: "number", description: "default 600" },
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
      "time. Follow with ONE deepseek_wait_all(session_ids). Each task is a full DSH process; max 12 per call.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          description: "One object per agent. Each becomes its own DSH session/process.",
          items: {
            type: "object",
            properties: {
              prompt: { type: "string", description: "Self-contained task for this agent." },
              cwd: { type: "string", description: "Working directory inside the project (default: project root)." },
              mode: { type: "string", enum: ["read-only", "workspace-write"], description: "workspace-write (default) or read-only" },
              reasoning_effort: { type: "string", enum: ["off", "low", "high", "max"], description: "default max" },
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
        profile: PROFILE_SCHEMA,
        verify_command: { type: "string", description: "Optional test of THIS delegated work, not the repo-wide gate. If it fails, the agent gets the error; keep verify_retries=0 for delegated tasks." },
        verify_retries: { type: "number", description: "0-5; default 0 (keep 0 for delegated tasks)" },
        verify_timeout_seconds: { type: "number", description: "default 600" },
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
      "with the remaining ids — never loop with short waits. By default returns compact previews (use " +
      "deepseek_result for full text); pass full=true for full output. NON-BLOCKING ALTERNATIVE: run " +
      "`dsh-wait <dsh_session_id> [...]` with Bash run_in_background instead; it waits outside this MCP call.",
    inputSchema: {
      type: "object",
      properties: {
        session_ids: { type: "array", minItems: 1, maxItems: 16, items: { type: "string" } },
        wait_seconds: { type: "number", description: "0-21600; default 3600" },
        full: { type: "boolean", description: "false (default) = compact previews; true = full output per session" },
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
      "alive: call deepseek_wait again once with a large wait_seconds; never send a new prompt or loop with short waits. " +
      "NON-BLOCKING ALTERNATIVE: run `dsh-wait <dsh_session_id>` with Bash run_in_background; it waits outside this MCP turn.",
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
    name: "deepseek_verify",
    description:
      "Run a test command in the session's cwd and return its exit code. If it fails, send the error back to the agent " +
      "and retry up to retries times. Use only this work's tests; the repo-wide gate stays with the coordinator. Use after deepseek_wait, or set verify_command on start/resume.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        command: { type: "string" },
        retries: { type: "number", description: "0-5; default 0 (keep 0 for delegated tasks)" },
        timeout_seconds: { type: "number", description: "default 600" },
        wait_seconds: { type: "number", description: "how long to wait for the current turn; default 3600" },
      },
      required: ["session_id", "command"],
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
    description: "List DeepSeek sessions started by THIS MCP server process (live only; empty after a restart). Use deepseek_sessions for persisted sessions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "deepseek_sessions",
    description:
      "List persisted DeepSeek sessions for a workspace (reads the durable session store; survives restarts). " +
      "Use the returned dsh_session_id with deepseek_resume.",
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
    case "deepseek_start": return textResult(await toolStart(args, progressToken));
    case "deepseek_start_many": return textResult(await toolStartMany(args));
    case "deepseek_resume": return textResult(await toolResume(args, progressToken));
    case "deepseek_send": return textResult(await toolSend(args, progressToken));
    case "deepseek_wait": return textResult(await toolWait(args, progressToken));
    case "deepseek_wait_all": return textResult(await toolWaitAll(args, progressToken));
    case "deepseek_status": return textResult(await toolStatus(args, progressToken));
    case "deepseek_result": return textResult(await toolResult(args));
    case "deepseek_verify": return textResult(await toolVerify(args, progressToken));
    case "deepseek_cancel": return textResult(await toolCancel(args));
    case "deepseek_close": return textResult(await toolClose(args));
    case "deepseek_list": return textResult(await toolList());
    case "deepseek_sessions": return textResult(await toolSessions(args));
    default: return textResult(`unknown tool: ${name}`, true);
  }
}

/* ------------------------------------------------------------------ */
/* Local control socket (viewer read-only + cancel/resume)            */
/* ------------------------------------------------------------------ */

let controlServer = null;

function controlLiveSessions() {
  return [...sessions.values()].map((s) => ({
    session_id: s.id,
    dsh_session_id: s.sessionId,
    busy: s.busy,
    status: s.status,
    cwd: s.cwd,
    mode: s.mode,
  }));
}

function findControlSession(args) {
  const dsh = String(args.dsh_session_id || "").trim();
  if (dsh) {
    for (const s of sessions.values()) {
      if (s.sessionId === dsh) return s;
    }
  }
  const alias = String(args.session_id || "").trim();
  if (alias) return sessions.get(alias);
  return undefined;
}

async function handleControlRequest(request) {
  const action = String(request?.action || "").trim();
  if (action === "list" || action === "status") {
    return { ok: true, result: { pid: process.pid, workspace: WORKSPACE, sessions: controlLiveSessions() } };
  }
  if (action === "cancel") {
    const s = findControlSession(request);
    if (!s) return { ok: false, code: "not-live", error: "sessão não está viva neste shim" };
    const result = await toolCancel({ session_id: s.id, wait_seconds: request.wait_seconds }, undefined);
    return { ok: true, result };
  }
  if (action === "resume") {
    const dshSessionId = String(request?.dsh_session_id || "").trim();
    if (!dshSessionId) return { ok: false, code: "bad-request", error: "dsh_session_id é obrigatório" };
    const prompt = String(request?.prompt || "").trim();
    if (!prompt) return { ok: false, code: "bad-request", error: "prompt é obrigatório" };
    const live = findControlSession({ dsh_session_id: dshSessionId });
    if (live) {
      if (live.busy) {
        return {
          ok: false,
          code: "busy",
          error: "turno em andamento; cancele antes de retomar",
          result: live.statusPayload(),
        };
      }
      live.prompt(prompt);
      return { ok: true, mode: "sent", result: live.statusPayload() };
    }
    const result = await toolResume({
      dsh_session_id: dshSessionId,
      prompt,
      cwd: request.cwd,
      mode: request.mode,
      wait: false,
    }, undefined);
    return { ok: true, mode: "resumed", result };
  }
  return { ok: false, code: "unknown-action", error: `acao desconhecida: ${action}` };
}

function startControlServer() {
  if (process.env.DSH_ACP_CONTROL === "0") return;
  try {
    if (existsSync(CONTROL_SOCKET)) unlinkSync(CONTROL_SOCKET);
    controlServer = createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let request;
          try {
            request = JSON.parse(line);
          } catch {
            socket.write(JSON.stringify({ ok: false, error: "json invalido" }) + "\n");
            continue;
          }
          handleControlRequest(request)
            .then((response) => socket.write(JSON.stringify({ id: request.id, ...response }) + "\n"))
            .catch((err) => socket.write(JSON.stringify({
              id: request.id,
              ok: false,
              error: String(err?.message || err).slice(0, 500),
            }) + "\n"));
        }
      });
    });
    controlServer.listen(CONTROL_SOCKET, () => {
      try { chmodSync(CONTROL_SOCKET, 0o600); } catch {}
      try {
        writeJsonAtomic(CONTROL_REGISTRY, {
          pid: process.pid,
          socket: CONTROL_SOCKET,
          workspace: WORKSPACE,
          started_at: new Date().toISOString(),
        });
      } catch (err) {
        log("control registry write failed:", err.message);
      }
      log("control socket ready:", CONTROL_SOCKET);
    });
    controlServer.on("error", (err) => log("control socket error:", err.message));
  } catch (err) {
    log("control socket start failed:", err.message);
  }
}

function stopControlServer() {
  try { controlServer?.close(); } catch {}
  controlServer = null;
  try { if (existsSync(CONTROL_SOCKET)) unlinkSync(CONTROL_SOCKET); } catch {}
  try { if (existsSync(CONTROL_REGISTRY)) unlinkSync(CONTROL_REGISTRY); } catch {}
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
    stopControlServer();
    Promise.allSettled([...sessions.values()].map((s) => s.close())).finally(() => {
      mcpSend({ jsonrpc: "2.0", id, result: {} });
      process.exit(0);
    });
    return;
  }
  if (method === "exit") {
    stopControlServer();
    process.exit(0);
  }
  if (id !== undefined) {
    mcpSend({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

process.on("SIGTERM", async () => {
  stopControlServer();
  await Promise.allSettled([...sessions.values()].map((s) => s.close()));
  process.exit(0);
});

// Claude Code sends SIGINT first when it disconnects a stdio server, then
// SIGTERM ~100ms later. Ignoring SIGINT keeps an accidental interrupt from
// killing live DeepSeek sessions; SIGTERM above still closes them on real exit.
process.on("SIGINT", () => {
  log("SIGINT ignored; live sessions stay up until SIGTERM");
});

startControlServer();

// Um shim iniciado pelo viewer é filho do processo do dsh web. Se esse pai
// morrer, o shim não deve continuar segurando sessões/lock órfãos.
const parentPid = process.ppid;
const parentWatch = setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    log("parent process is gone; closing control shim");
    stopControlServer();
    Promise.allSettled([...sessions.values()].map((s) => s.close())).finally(() => process.exit(0));
  }
}, 5_000);
parentWatch.unref?.();

log("ready; workspace=" + WORKSPACE);
