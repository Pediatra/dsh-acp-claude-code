/**
 * Store somente-leitura das sessões persistidas do DSH.
 *
 * Lê `<DSH_HOME>/sessions/*​/*​/session.v4.jsonl.zstd`, reconcilia por `seq`
 * e mantém um cache curto por sessão. Não abre o `session.lock`, não cria
 * arquivos e não conhece ACP.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  decodeZstdBuffer,
  describeDecodeError,
  parseEventLines,
} from "./decode.mjs";
import { scanOwners } from "./owner.mjs";
import {
  eventSeq,
  eventTime,
  extractHeader,
  extractTitle,
  itemForEvent,
} from "./view.mjs";

export const LOG_NAME = "session.v4.jsonl.zstd";
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_IDLE_MS = 10_000;
const DEFAULT_INDEX_TTL_MS = 5_000;
const DEFAULT_MAX_STATES = 8;
const DEFAULT_MAX_STATE_ITEMS = 30_000;

export class SessionNotFoundError extends Error {
  /** @param {string} id */
  constructor(id) {
    super(`sessão "${id}" não encontrada`);
    this.name = "SessionNotFoundError";
    this.code = "SESSION_NOT_FOUND";
    this.sessionId = id;
  }
}

/** @returns {string} raiz padrão das sessões persistidas. */
export function defaultSessionsRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "sessions");
}

/**
 * Decodifica o nome do diretório de projeto usado pelo DSH
 * (`/var/home/x` -> `--var-home-x--`). É apenas o rótulo de descoberta; o
 * `cwd` autoritativo vem do cabeçalho `session` do log quando disponível.
 * @param {string} name
 * @returns {string}
 */
export function decodeDirName(name) {
  if (name.startsWith("--") && name.endsWith("--") && name.length > 4) {
    return "/" + name.slice(2, -2).split("-").join("/");
  }
  return name;
}

/**
 * @param {{
 *   root?: string,
 *   now?: () => number,
 *   idleMs?: number,
 *   indexTtlMs?: number,
 *   maxStates?: number,
 *   maxStateItems?: number,
 *   hostPid?: number,
 * }} [options]
 */
export function createSessionStore(options = {}) {
  const root = path.resolve(options.root ?? defaultSessionsRoot());
  const nowMs = options.now ?? Date.now;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const indexTtlMs = options.indexTtlMs ?? DEFAULT_INDEX_TTL_MS;
  const maxStates = options.maxStates ?? DEFAULT_MAX_STATES;
  const maxStateItems = options.maxStateItems ?? DEFAULT_MAX_STATE_ITEMS;
  const hostPid = options.hostPid ?? process.pid;

  /** @type {{at: number, entries: Map<string, object>}|null} */
  let index = null;
  /** @type {Promise<Map<string, object>>|null} */
  let indexPromise = null;
  /** @type {Promise<string>|null} */
  let realRootPromise = null;
  /** @type {Map<string, object>} */
  const states = new Map();

  async function realRoot() {
    realRootPromise ??= fs.realpath(root).catch(() => root);
    return realRootPromise;
  }

  /** @returns {Promise<Map<string, object>>} */
  async function getIndex(force = false) {
    if (!force && index !== null && nowMs() - index.at < indexTtlMs) {
      return index.entries;
    }
    if (indexPromise !== null) return indexPromise;
    indexPromise = scanIndex().finally(() => {
      indexPromise = null;
    });
    return indexPromise;
  }

  async function scanIndex() {
    const entries = new Map();
    let parents;
    try {
      parents = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        index = { at: nowMs(), entries };
        return entries;
      }
      throw error;
    }

    for (const parent of parents) {
      if (!parent.isDirectory() || parent.name.startsWith(".")) continue;
      const parentPath = path.join(root, parent.name);
      let children;
      try {
        children = await fs.readdir(parentPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory() || !SESSION_ID_RE.test(child.name)) continue;
        const dir = path.join(parentPath, child.name);
        entries.set(child.name, {
          id: child.name,
          dirName: parent.name,
          cwdFromDir: decodeDirName(parent.name),
          dir,
          logPath: path.join(dir, LOG_NAME),
          lockPath: path.join(dir, "session.lock"),
        });
      }
    }

    index = { at: nowMs(), entries };
    return entries;
  }

  /** @returns {Promise<object|undefined>} */
  async function getEntry(id) {
    let entries = await getIndex(false);
    let entry = entries.get(id);
    if (entry === undefined) {
      entries = await getIndex(true);
      entry = entries.get(id);
    }
    return entry;
  }

  /** @returns {object} */
  function createState(id) {
    return {
      id,
      loaded: false,
      hasLog: false,
      items: [],
      lastSeq: -1,
      currentTurn: 0,
      generation: 0,
      headerCwd: null,
      createdAt: null,
      title: null,
      eventCount: 0,
      badLines: 0,
      partialLine: false,
      truncated: false,
      degraded: false,
      readError: null,
      lastEventTime: null,
      logSize: 0,
      logMtimeMs: null,
      logIno: null,
      lastAccess: nowMs(),
    };
  }

  /** @param {object} state */
  function touchState(state) {
    if (states.has(state.id)) states.delete(state.id);
    states.set(state.id, state);
    state.lastAccess = nowMs();
    while (states.size > maxStates) {
      const oldest = states.keys().next().value;
      if (oldest === undefined || oldest === state.id) break;
      states.delete(oldest);
    }
  }

  /**
   * Lista as sessões descobertas, com tamanho/mtime do log e dono do lock.
   * @returns {Promise<object[]>}
   */
  async function listSessions() {
    const entries = [...(await getIndex(false)).values()];
    const canonicalRoot = await realRoot();
    const owners = await scanOwners(canonicalRoot);

    const rows = await Promise.all(entries.map(async (entry) => {
      const [logStat, lockStat, dirStat] = await Promise.all([
        statOrNull(entry.logPath),
        statOrNull(entry.lockPath),
        statOrNull(entry.dir),
      ]);
      const state = states.get(entry.id);
      const lockPath = path.join(canonicalRoot, entry.dirName, entry.id, "session.lock");
      const owner = owners.get(lockPath) ?? [];
      const mtimeMs = logStat?.mtimeMs ?? dirStat?.mtimeMs ?? null;
      return {
        id: entry.id,
        dirName: entry.dirName,
        cwd: state?.headerCwd ?? entry.cwdFromDir,
        cwdFromDir: entry.cwdFromDir,
        title: state?.title ?? null,
        hasLog: logStat !== undefined,
        logSize: logStat?.size ?? 0,
        logMtimeMs: logStat?.mtimeMs ?? null,
        dirMtimeMs: dirStat?.mtimeMs ?? null,
        mtimeMs,
        lockExists: lockStat !== undefined,
        owner: owner.length > 0 ? owner : null,
        ownerPids: owner.map((item) => item.pid),
        live: logStat !== undefined && nowMs() - logStat.mtimeMs <= idleMs,
        lastSeq: state?.lastSeq ?? null,
        generation: state?.generation ?? 0,
        empty: state?.loaded === true ? state.items.length === 0 : (logStat?.size ?? 0) === 0,
      };
    }));

    rows.sort((left, right) => {
      const delta = (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0);
      return delta !== 0 ? delta : left.id.localeCompare(right.id);
    });
    return rows;
  }

  /**
   * Lê uma sessão e devolve os itens novos (ou o snapshot completo quando
   * `reset` é true).
   *
   * @param {string} id
   * @param {{afterSeq?: number, generation?: number}} [options]
   * @returns {Promise<{meta: object, items: object[], reset: boolean}>}
   */
  async function readSession(id, options = {}) {
    const entry = await getEntry(id);
    if (entry === undefined) throw new SessionNotFoundError(id);

    const previous = states.get(id);
    const state = previous ?? createState(id);
    if (previous === undefined) touchState(state);
    else touchState(state);

    const [logStat, lockStat, canonicalRoot, owners] = await Promise.all([
      statOrNull(entry.logPath),
      statOrNull(entry.lockPath),
      realRoot(),
      scanOwners(await realRoot()),
    ]);
    const lockPath = path.join(canonicalRoot, entry.dirName, entry.id, "session.lock");
    const owner = owners.get(lockPath) ?? [];

    if (logStat === undefined) {
      state.hasLog = false;
      state.loaded = true;
      state.logSize = 0;
      state.logMtimeMs = null;
      state.logIno = null;
      state.readError = null;
      state.degraded = false;
      state.truncated = false;
      state.partialLine = false;
      const wasLoaded = previous?.loaded === true;
      return finish(state, entry, {
        afterSeq: options.afterSeq,
        generation: options.generation,
        logStat: undefined,
        lockStat,
        owner,
        forceReset: !wasLoaded,
      });
    }

    const wasLoaded = state.loaded === true;
    const previousSize = state.logSize;
    const previousIno = state.logIno;
    const changed = !wasLoaded
      || state.logSize !== logStat.size
      || state.logMtimeMs !== logStat.mtimeMs
      || state.logIno !== logStat.ino;

    let forceReset = !wasLoaded;

    if (changed) {
      const buffer = await fs.readFile(entry.logPath);
      const decoded = await decodeZstdBuffer(buffer);
      const parsed = parseEventLines(decoded.text);
      const events = parsed.events;
      const header = extractHeader(events);

      if (header?.cwd) state.headerCwd = header.cwd;
      if (header?.createdAt !== null && header?.createdAt !== undefined) {
        state.createdAt = header.createdAt;
      }

      const newInode = wasLoaded && previousIno !== null && previousIno !== logStat.ino;
      const resetState = !wasLoaded || newInode;
      if (resetState) {
        state.items = [];
        state.lastSeq = -1;
        state.currentTurn = 0;
        state.lastEventTime = null;
        state.title = null;
        state.truncated = false;
        if (newInode) state.generation += 1;
        forceReset = true;
      }

      const shrank = wasLoaded && previousSize > logStat.size;
      let currentTurn = state.currentTurn ?? 0;
      for (const event of events) {
        const seq = eventSeq(event);
        if (seq !== null && seq <= state.lastSeq) continue;
        if (event.type === "turn/start" && Number.isInteger(event.data?.turn)) {
          currentTurn = event.data.turn;
        }
        if (seq === null) continue;
        const item = itemForEvent(event, { currentTurn });
        if (item !== null) state.items.push(item);
        if (seq > state.lastSeq) state.lastSeq = seq;
        const time = eventTime(event);
        if (time !== null) state.lastEventTime = Math.max(state.lastEventTime ?? 0, time);
      }
      state.currentTurn = currentTurn;

      const title = extractTitle(events);
      if (title !== null) state.title = title;

      state.eventCount = events.length;
      state.badLines = parsed.badLines;
      state.partialLine = parsed.partialLine;
      state.readError = decoded.error === null ? null : describeDecodeError(decoded.error);
      state.degraded = decoded.error !== null;
      state.truncated = shrank;
      state.hasLog = true;
      state.loaded = true;
      state.logSize = logStat.size;
      state.logMtimeMs = logStat.mtimeMs;
      state.logIno = logStat.ino;

      if (state.items.length > maxStateItems) {
        // O afterSeq é um high-water de seq; descartar o começo não quebra a
        // reconciliação, mas o snapshot inicial fica limitado ao rabo atual.
        state.items = state.items.slice(state.items.length - maxStateItems);
      }
    }

    return finish(state, entry, {
      afterSeq: options.afterSeq,
      generation: options.generation,
      logStat,
      lockStat,
      owner,
      forceReset,
    });
  }

  /**
   * @param {object} state
   * @param {object} entry
   * @param {{
   *   afterSeq?: number,
   *   generation?: number,
   *   logStat: import("node:fs").Stats|undefined,
   *   lockStat: import("node:fs").Stats|undefined,
   *   owner: object[],
   *   forceReset: boolean,
   * }} context
   */
  function finish(state, entry, context) {
    const now = nowMs();
    const logMtimeMs = context.logStat?.mtimeMs ?? null;
    const afterSeq = Number.isInteger(context.afterSeq) && context.afterSeq >= 0
      ? context.afterSeq
      : null;
    const clientGeneration = Number.isInteger(context.generation)
      ? context.generation
      : null;

    let reset = context.forceReset;
    let items;
    if (afterSeq === null) {
      reset = true;
      items = state.items;
    } else if (clientGeneration !== null && clientGeneration !== state.generation) {
      reset = true;
      items = state.items;
    } else if (afterSeq > state.lastSeq) {
      reset = true;
      items = state.items;
    } else {
      items = state.items.filter((item) => item.seq !== null && item.seq > afterSeq);
    }

    const live = (state.lastEventTime !== null && now - state.lastEventTime <= idleMs)
      || (logMtimeMs !== null && now - logMtimeMs <= idleMs);

    const meta = {
      id: entry.id,
      dirName: entry.dirName,
      cwd: state.headerCwd ?? entry.cwdFromDir,
      cwdFromDir: entry.cwdFromDir,
      title: state.title,
      createdAt: state.createdAt,
      hasLog: context.logStat !== undefined,
      logName: LOG_NAME,
      logSize: context.logStat?.size ?? 0,
      logMtimeMs,
      lastSeq: state.lastSeq,
      generation: state.generation,
      eventCount: state.eventCount,
      itemCount: state.items.length,
      badLines: state.badLines,
      partialLine: state.partialLine === true,
      truncated: state.truncated === true,
      degraded: state.degraded === true,
      readError: state.readError,
      lastEventTime: state.lastEventTime,
      live,
      now,
      idleMs,
      lockExists: context.lockStat !== undefined,
      owner: context.owner.length > 0 ? context.owner : null,
      ownerPids: context.owner.map((item) => item.pid),
      hostPid,
      empty: state.items.length === 0,
    };

    return { meta, items, reset };
  }

  return {
    root,
    listSessions,
    readSession,
    /** Exposto para testes de integração. */
    async owners() {
      return scanOwners(await realRoot());
    },
    /** Exposto para testes; não use na UI. */
    clearStates() {
      states.clear();
    },
  };
}

/**
 * @param {string} file
 * @returns {Promise<import("node:fs").Stats|undefined>}
 */
async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
    throw error;
  }
}
