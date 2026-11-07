/**
 * Testa o contrato HTTP do Host sem instalar o plugin: rotas, autenticação e
 * resposta JSON. A autenticação real é delegada a `connection.requestRejection`;
 * aqui ela é simulada.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import zlib from "node:zlib";
import { apply } from "../index.js";

const ID = "55555555-5555-4555-8555-555555555555";
const NOW = 1_800_000_000_000;

/** @type {string} */
let tempHome;
/** @type {Map<string, {handler: Function}>} */
const routes = new Map();
let rejection;

const fakeCtx = {
  effect: (factory) => {
    factory();
  },
  webServer: {
    register: (route) => {
      routes.set(route.path, route);
      return () => {};
    },
  },
  connection: {
    requestRejection: () => rejection,
  },
  logger: { warn: () => {} },
};

before(async () => {
  const base = path.join(os.homedir(), ".local", "state", "visor-dsh", "teste");
  await fs.mkdir(base, { recursive: true });
  tempHome = await fs.mkdtemp(path.join(base, "http-"));
  const dir = path.join(tempHome, "sessions", "--tmp-http--", ID);
  await fs.mkdir(dir, { recursive: true });
  const events = [
    { type: "session", version: 4, id: ID, createdAt: NOW, cwd: "/tmp/http", isSeeded: false, delegationDepth: 0 },
    { type: "turn/start", seq: 0, time: NOW, data: { turn: 1 } },
    { type: "user/message", seq: 1, time: NOW, data: { content: [{ type: "text", text: "olá http" }] } },
    { type: "turn/end", seq: 2, time: NOW, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  const frame = zlib.zstdCompressSync(
    Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8"),
  );
  await fs.writeFile(path.join(dir, "session.v4.jsonl.zstd"), frame);
  process.env.DSH_HOME = tempHome;
  apply(fakeCtx);
});

after(async () => {
  if (process.env.VISOR_KEEP_TEST === "1") return;
  await fs.rm(tempHome, { recursive: true, force: true });
});

function mockRequest(method, url) {
  return { method, url, headers: {} };
}

function mockResponse() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
      return this;
    },
    end(body) {
      if (body !== undefined) this.body += Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
      return this;
    },
  };
}

async function call(routePath, method, url) {
  const route = routes.get(routePath);
  assert.ok(route, `rota ${routePath} registrada`);
  const response = mockResponse();
  await route.handler(mockRequest(method, url), response);
  return response;
}

test("rotas do visor respondem JSON autenticado", async () => {
  rejection = undefined;

  const list = await call("/api/visor/sessions", "GET", "/api/visor/sessions");
  assert.equal(list.status, 200);
  assert.match(list.headers["content-type"], /application\/json/);
  const listBody = JSON.parse(list.body);
  assert.equal(Array.isArray(listBody.sessions), true);
  assert.ok(listBody.sessions.some((session) => session.id === ID));

  const snapshot = await call("/api/visor/session", "GET", `/api/visor/session?id=${ID}`);
  assert.equal(snapshot.status, 200);
  const body = JSON.parse(snapshot.body);
  assert.equal(body.meta.id, ID);
  assert.equal(body.meta.hasLog, true);
  assert.equal(body.meta.owner, null);
  assert.equal(body.reset, true);
  assert.ok(body.items.some((item) => item.kind === "user" && item.text === "olá http"));
  assert.ok(body.items.some((item) => item.kind === "turn_end" && item.reasonKind === "completed"));

  const missing = await call("/api/visor/session", "GET", "/api/visor/session?id=nao-existe");
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.body).error, "session/not-found");

  const post = await call("/api/visor/sessions", "POST", "/api/visor/sessions");
  assert.equal(post.status, 405);

  const head = await call("/api/visor/session", "HEAD", `/api/visor/session?id=${ID}`);
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
});

test("rota devolve 401/403 quando a conexão rejeita", async () => {
  rejection = 401;
  const unauthorized = await call("/api/visor/sessions", "GET", "/api/visor/sessions");
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.body, /Unauthorized/);

  rejection = 403;
  const forbidden = await call("/api/visor/session", "GET", `/api/visor/session?id=${ID}`);
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.body, /Forbidden/);
  rejection = undefined;
});
