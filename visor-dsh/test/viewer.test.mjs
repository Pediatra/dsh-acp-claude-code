/**
 * Testes do leitor do visor. Não tocam em `~/.dsh/sessions` com escrita e não
 * criam/adquirem `session.lock`; a única leitura de sessão real é opcional.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import zlib from "node:zlib";
import { decodeZstdBuffer, parseEventLines } from "../host/decode.mjs";
import { createSessionStore, defaultSessionsRoot } from "../host/store.mjs";
import { itemForEvent } from "../host/view.mjs";

const TEST_ID = "11111111-1111-4111-8111-111111111111";
const TEST_PARENT = "--tmp-visor-test--";
const TEST_CWD = "/tmp/visor-test";
const NOW = 1_800_000_000_000;

/** @type {string} */
let tempRoot;

before(async () => {
  const base = path.join(os.homedir(), ".local", "state", "visor-dsh", "teste");
  await fs.mkdir(base, { recursive: true });
  tempRoot = await fs.mkdtemp(path.join(base, "run-"));
});

after(async () => {
  if (process.env.VISOR_KEEP_TEST === "1") return;
  await fs.rm(tempRoot, { recursive: true, force: true });
});

/**
 * @param {string} id
 * @param {string} parent
 * @returns {Promise<string>} diretório da sessão
 */
async function sessionDir(id, parent = TEST_PARENT) {
  const dir = path.join(tempRoot, "sessions", parent, id);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * @param {object[]} events
 * @returns {Buffer}
 */
function encodeFrame(events) {
  const text = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  return zlib.zstdCompressSync(Buffer.from(text, "utf8"));
}

/**
 * @param {string} dir
 * @param {Buffer[]} frames
 */
async function writeLog(dir, frames) {
  await fs.writeFile(path.join(dir, "session.v4.jsonl.zstd"), Buffer.concat(frames));
}

/**
 * @param {string} type
 * @param {number|null} seq
 * @param {object} data
 * @param {number} [time]
 */
function event(type, seq, data, time = NOW) {
  return { type, time, ...(seq === null ? {} : { seq }), data };
}

function header(id = TEST_ID, cwd = TEST_CWD) {
  return {
    type: "session",
    version: 4,
    id,
    createdAt: NOW - 1000,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  };
}

/**
 * @param {object[]} events
 * @returns {object[]}
 */
function baseTurn(events) {
  return [
    header(),
    ...events,
  ];
}

test("decode ignora frame truncado e parse descarta linha incompleta", async () => {
  const lines = [
    { type: "session", version: 4, id: TEST_ID, cwd: TEST_CWD },
    { type: "turn/start", seq: 0, time: NOW, data: { turn: 1 } },
    { type: "user/message", seq: 1, time: NOW, data: { content: [{ type: "text", text: "oi" }] } },
    { type: "assistant/message", seq: 2, time: NOW, data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "olá" }] } } },
  ];
  const frames = lines.map((line) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(line) + "\n", "utf8")));
  const full = Buffer.concat(frames);
  const cut = full.subarray(0, full.length - 6);
  const decoded = await decodeZstdBuffer(cut);
  assert.equal(typeof decoded.text, "string");
  assert.match(decoded.text, /"type":"turn\/start"/);
  const parsed = parseEventLines(decoded.text);
  assert.ok(parsed.events.length >= 2);

  const bad = parseEventLines('{"type":"ok","seq":1}\n{"type":"turn/start"');
  assert.equal(bad.events.length, 1);
  assert.equal(bad.partialLine, true);
});

test("view model renderiza texto, ferramenta e motivo interrupted", () => {
  const user = itemForEvent({
    type: "user/message",
    seq: 1,
    time: NOW,
    data: { content: [{ type: "text", text: "mensagem" }] },
  }, { currentTurn: 1 });
  assert.equal(user.kind, "user");
  assert.equal(user.text, "mensagem");
  assert.equal(user.turn, 1);

  const assistant = itemForEvent({
    type: "assistant/message",
    seq: 2,
    time: NOW,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: "assistant",
        content: [
          { type: "reasoning", text: "pensando" },
          { type: "text", text: "resposta" },
        ],
      },
    },
  }, { currentTurn: 1 });
  assert.equal(assistant.kind, "assistant");
  assert.equal(assistant.text, "resposta");
  assert.equal(assistant.reasoning, "pensando");

  const call = itemForEvent({
    type: "tool/call",
    seq: 3,
    time: NOW,
    data: {
      turn: 1,
      step: 1,
      callId: "call-1",
      name: "bash",
      arguments: JSON.stringify({ command: "printf oi", description: "imprime oi" }),
    },
  }, { currentTurn: 1 });
  assert.equal(call.kind, "tool_call");
  assert.equal(call.name, "bash");
  assert.match(call.summary, /imprime oi/);
  assert.match(call.input, /printf oi/);

  const result = itemForEvent({
    type: "tool/result",
    seq: 4,
    time: NOW,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: "tool",
        toolCallId: "call-1",
        content: [{ type: "text", text: "oi\n" }],
        isError: false,
      },
    },
  }, { currentTurn: 1 });
  assert.equal(result.kind, "tool_result");
  assert.equal(result.output, "oi\n");

  const end = itemForEvent({
    type: "turn/end",
    seq: 5,
    time: NOW,
    data: { turn: 1, reason: { kind: "interrupted" } },
  }, { currentTurn: 1 });
  assert.equal(end.kind, "turn_end");
  assert.equal(end.reasonKind, "interrupted");
});

test("store reconcilia por seq, sobrevive a truncamento e retoma", async () => {
  const dir = await sessionDir(TEST_ID);
  const firstEvents = baseTurn([
    event("turn/start", 0, { turn: 1 }),
    event("step/start", 1, { turn: 1, step: 1 }),
    event("user/message", 2, { content: [{ type: "text", text: "primeira" }] }),
    event("assistant/message", 3, {
      turn: 1,
      step: 1,
      message: { role: "assistant", content: [{ type: "text", text: "resposta um" }] },
    }),
    event("tool/call", 4, {
      turn: 1,
      step: 1,
      callId: "c1",
      name: "read",
      arguments: JSON.stringify({ file_path: "/tmp/a" }),
    }),
    event("tool/result", 5, {
      turn: 1,
      step: 1,
      message: {
        role: "tool",
        toolCallId: "c1",
        content: [{ type: "text", text: "conteúdo" }],
        isError: false,
      },
    }),
    event("step/end", 6, { turn: 1, step: 1 }),
    event("turn/end", 7, { turn: 1, reason: { kind: "interrupted" } }),
  ]);
  const secondEvents = [
    event("turn/start", 8, { turn: 2 }),
    event("user/message", 9, { content: [{ type: "text", text: "segunda" }] }),
    event("turn/end", 10, { turn: 2, reason: { kind: "completed" } }),
  ];
  await writeLog(dir, [encodeFrame(firstEvents), encodeFrame(secondEvents)]);

  const store = createSessionStore({ root: path.join(tempRoot, "sessions") });
  const listed = await store.listSessions();
  const row = listed.find((item) => item.id === TEST_ID);
  assert.ok(row);
  assert.equal(row.hasLog, true);
  assert.ok(row.logSize > 0);

  const first = await store.readSession(TEST_ID, {});
  assert.equal(first.reset, true);
  assert.ok(first.items.some((item) => item.kind === "user" && item.text === "primeira"));
  assert.ok(first.items.some((item) => item.kind === "assistant" && item.text === "resposta um"));
  assert.ok(first.items.some((item) => item.kind === "tool_call" && item.name === "read"));
  assert.ok(first.items.some((item) => item.kind === "tool_result" && item.output === "conteúdo"));
  assert.ok(first.items.some((item) => item.kind === "turn_end" && item.reasonKind === "interrupted"));
  assert.equal(first.meta.lastSeq, 10);

  const incremental = await store.readSession(TEST_ID, {
    afterSeq: 7,
    generation: first.meta.generation,
  });
  assert.equal(incremental.reset, false);
  assert.equal(incremental.items.length, 3);
  assert.equal(incremental.items[0].kind, "turn_start");
  assert.equal(incremental.items.at(-1).reasonKind, "completed");

  // Truncamento no meio do último frame: não pode lançar e não deve perder o
  // que já foi lido.
  const logPath = path.join(dir, "session.v4.jsonl.zstd");
  const full = await fs.readFile(logPath);
  await fs.truncate(logPath, full.length - 9);
  const truncated = await store.readSession(TEST_ID, {
    afterSeq: 10,
    generation: first.meta.generation,
  });
  assert.equal(truncated.meta.truncated, true);
  assert.ok(truncated.items.length === 0);
  assert.ok(truncated.meta.readError === null || typeof truncated.meta.readError === "string");

  // O writer completa o frame e acrescenta um turno novo.
  const thirdEvents = [
    event("turn/start", 11, { turn: 3 }),
    event("user/message", 12, { content: [{ type: "text", text: "terceira" }] }),
  ];
  await fs.writeFile(logPath, Buffer.concat([full, encodeFrame(thirdEvents)]));
  const resumed = await store.readSession(TEST_ID, {
    afterSeq: 10,
    generation: first.meta.generation,
  });
  assert.equal(resumed.meta.truncated, false);
  assert.ok(resumed.items.some((item) => item.kind === "user" && item.text === "terceira"));
});

test("linha JSON parcial é completada no frame seguinte", async () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const dir = await sessionDir(id);
  const line = JSON.stringify(event("turn/start", 0, { turn: 1 }));
  const partialStart = line.slice(0, Math.floor(line.length / 2));
  const partialRest = line.slice(Math.floor(line.length / 2));
  const frameOne = zlib.zstdCompressSync(Buffer.from(JSON.stringify(header(id)) + "\n" + partialStart, "utf8"));
  const frameTwo = zlib.zstdCompressSync(Buffer.from(partialRest + "\n" + JSON.stringify(event("user/message", 1, { content: [{ type: "text", text: "ok" }] })) + "\n", "utf8"));
  const logPath = path.join(dir, "session.v4.jsonl.zstd");
  await fs.writeFile(logPath, frameOne);

  const store = createSessionStore({ root: path.join(tempRoot, "sessions") });
  const first = await store.readSession(id, {});
  assert.ok(first.items.some((item) => item.kind === "user" && item.text === "ok") === false);
  assert.equal(first.meta.partialLine, true);
  assert.ok(first.meta.lastSeq <= 0);

  await fs.appendFile(logPath, frameTwo);
  const second = await store.readSession(id, {
    afterSeq: first.meta.lastSeq >= 0 ? first.meta.lastSeq : undefined,
    generation: first.meta.generation,
  });
  assert.ok(second.items.some((item) => item.kind === "user" && item.text === "ok"));
});

test("sessão vazia (sem log e com log só de cabeçalho) não quebra", async () => {
  const noLogId = "33333333-3333-4333-8333-333333333333";
  await sessionDir(noLogId);
  const headerOnlyId = "44444444-4444-4444-8444-444444444444";
  const headerOnlyDir = await sessionDir(headerOnlyId);
  await writeLog(headerOnlyDir, [encodeFrame([header(headerOnlyId)])]);

  const store = createSessionStore({ root: path.join(tempRoot, "sessions") });
  const sessions = await store.listSessions();
  const noLog = sessions.find((item) => item.id === noLogId);
  assert.ok(noLog);
  assert.equal(noLog.hasLog, false);
  const empty = await store.readSession(noLogId, {});
  assert.equal(empty.meta.hasLog, false);
  assert.equal(empty.items.length, 0);
  assert.equal(empty.meta.readError, null);

  const headerOnly = await store.readSession(headerOnlyId, {});
  assert.equal(headerOnly.meta.hasLog, true);
  assert.equal(headerOnly.meta.readError, null);
  assert.equal(headerOnly.items.length, 0);
  assert.equal(headerOnly.meta.empty, true);
});

test("evento novo aparece no poll seguinte (simula 1 s)", async () => {
  const id = "66666666-6666-4666-8666-666666666666";
  const dir = await sessionDir(id);
  const logPath = path.join(dir, "session.v4.jsonl.zstd");
  await writeLog(dir, [encodeFrame([
    header(id),
    event("turn/start", 0, { turn: 1 }),
    event("user/message", 1, { content: [{ type: "text", text: "base" }] }),
  ])]);

  const store = createSessionStore({ root: path.join(tempRoot, "sessions") });
  const first = await store.readSession(id, {});
  assert.ok(first.items.some((item) => item.kind === "user" && item.text === "base"));
  const baseline = first.meta.lastSeq;

  await fs.appendFile(logPath, encodeFrame([
    event("turn/end", 2, { turn: 1, reason: { kind: "completed" } }),
  ]));
  const appendedAt = Date.now();
  // O Client do plugin usa exatamente 1 s de intervalo.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const next = await store.readSession(id, {
    afterSeq: baseline,
    generation: first.meta.generation,
  });
  const elapsed = Date.now() - appendedAt;
  assert.ok(elapsed < 2000, `latência ${elapsed} ms`);
  assert.ok(next.items.some((item) => item.kind === "turn_end" && item.reasonKind === "completed"));
});

test("sessão real: dono do lock é detectado sem adquiri-lo", async (t) => {
  const realId = process.env.VISOR_REAL_SESSION ?? "bce8f2a0-9995-4d00-86db-c2b0bdbba2e3";
  const root = defaultSessionsRoot();
  let exists = false;
  try {
    await fs.access(path.join(root, "--var-home-gabriel-Projects-chorinho-dataset--", realId));
    exists = true;
  } catch {
    // diretório de outra máquina: teste opcional
  }
  if (!exists) {
    t.skip("sessão real não está presente nesta máquina");
    return;
  }
  const store = createSessionStore({ root });
  const sessions = await store.listSessions();
  const row = sessions.find((item) => item.id === realId);
  assert.ok(row);
  assert.equal(row.hasLog, true);
  if (row.owner !== null) {
    assert.ok(row.owner.length > 0);
    assert.ok(row.owner.every((owner) => owner.pid > 0));
  }
  const snapshot = await store.readSession(realId, {});
  assert.ok(snapshot.items.some((item) => item.kind === "turn_end"));
  assert.ok(snapshot.items.some((item) => item.kind === "tool_call"));
  if (snapshot.meta.owner !== null) {
    assert.ok(snapshot.meta.owner.some((owner) => Number.isInteger(owner.pid)));
  }
});
