/**
 * Descoberta de quem segura o `session.lock` sem adquirir o lock.
 *
 * A abordagem é puramente de leitura de metadados: varremos os links de
 * `/proc/<pid>/fd` e comparamos o caminho do lock. Nunca abrimos, criamos ou
 * travamos o arquivo. O resultado é informativo e não interfere na leitura do
 * log.
 */
import fs from "node:fs/promises";
import path from "node:path";

const LOCK_BASENAME = "session.lock";
const DEFAULT_TTL_MS = 2_000;
const CONCURRENCY = 32;

/** @type {Map<string, {at: number, byPath: Map<string, Owner[]>}>} */
const caches = new Map();

/**
 * @typedef {{pid: number, comm: string, label: string}} Owner
 */

/**
 * Varre /proc e devolve um mapa `caminho absoluto do lock -> donos`.
 * @param {string} root raiz das sessões (ex.: ~/.dsh/sessions).
 * @param {{ttlMs?: number, now?: () => number}} [options]
 * @returns {Promise<Map<string, Owner[]>>}
 */
export async function scanOwners(root, options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const key = path.resolve(root);
  const cached = caches.get(key);
  if (cached !== undefined && now() - cached.at < ttlMs) return cached.byPath;

  const prefix = key.endsWith(path.sep) ? key : key + path.sep;
  let procEntries;
  try {
    procEntries = await fs.readdir("/proc");
  } catch {
    return new Map();
  }

  const pids = procEntries.filter((entry) => /^\d+$/.test(entry));
  const matches = await mapLimit(pids, CONCURRENCY, async (entry) => {
    let fds;
    try {
      fds = await fs.readdir(`/proc/${entry}/fd`);
    } catch {
      return null;
    }
    const locks = new Set();
    for (const fd of fds) {
      let target;
      try {
        target = await fs.readlink(`/proc/${entry}/fd/${fd}`);
      } catch {
        continue;
      }
      if (!target.startsWith(prefix)) continue;
      if (path.basename(target) !== LOCK_BASENAME) continue;
      locks.add(path.resolve(target));
    }
    if (locks.size === 0) return null;
    return { pid: Number(entry), locks: [...locks] };
  });

  const byPath = new Map();
  for (const match of matches) {
    if (match === null) continue;
    const info = await processInfo(match.pid);
    for (const lockPath of match.locks) {
      const owners = byPath.get(lockPath) ?? [];
      owners.push({ pid: match.pid, ...info });
      byPath.set(lockPath, owners);
    }
  }
  for (const owners of byPath.values()) owners.sort((left, right) => left.pid - right.pid);

  caches.set(key, { at: now(), byPath });
  return byPath;
}

/**
 * @param {number} pid
 * @returns {Promise<{comm: string, label: string}>}
 */
async function processInfo(pid) {
  let comm = "";
  try {
    comm = (await fs.readFile(`/proc/${pid}/comm`, "utf8")).trim();
  } catch {
    // processo pode ter saído entre o readdir e a leitura
  }

  let label = comm || `pid ${pid}`;
  try {
    const cmdline = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
    const args = cmdline.split("\0").filter(Boolean);
    const profileIndex = args.indexOf("--profile");
    const profile = profileIndex >= 0 ? args[profileIndex + 1] ?? "" : "";
    const looksLikeDsh = args.some((arg) => {
      const base = path.basename(arg);
      return base === "dsh" || base === "dsh.js" || base === "dsh.mjs";
    });
    if (looksLikeDsh && args.includes("web")) label = "dsh web";
    else if (looksLikeDsh && profile === "acp") label = "dsh acp";
    else if (looksLikeDsh) label = "dsh";
  } catch {
    // sem permissão ou processo já encerrado: mantém comm
  }
  return { comm, label };
}

/**
 * Executa um mapper com concorrência limitada.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} mapper
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await mapper(items[current]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Limpa o cache entre testes. */
export function clearOwnerCache() {
  caches.clear();
}
