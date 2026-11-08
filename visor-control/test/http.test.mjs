/**
 * Contrato HTTP do canal de controle, sem shim vivo: autenticação, validação
 * do corpo e resposta de erro de sessão inexistente.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { apply } from "../index.js";

let base;
let rejection;
const routes = new Map();

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
  const root = path.join(os.homedir(), ".local", "state", "visor-dsh", "teste");
  await fs.mkdir(root, { recursive: true });
  base = await fs.mkdtemp(path.join(root, "control-http-"));
  process.env.DSH_ACP_STATE_DIR = base;
  apply(fakeCtx);
});

after(async () => {
  if (process.env.VISOR_KEEP_TEST === "1") return;
  await fs.rm(base, { recursive: true, force: true });
});

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
    destroy() {},
  };
}

async function call(method, body, headers = {}) {
  const route = routes.get("/api/visor/control");
  assert.ok(route, "rota registrada");
  const req = {
    method,
    url: "/api/visor/control",
    headers: { host: "127.0.0.1", ...headers },
  };
  const res = mockResponse();
  if (body !== undefined) {
    req.setEncoding = () => {};
    req.on = (event, callback) => {
      if (event === "data") queueMicrotask(() => callback(body));
      if (event === "end") queueMicrotask(() => callback());
      if (event === "error") return;
    };
  }
  await route.handler(req, res);
  return res;
}

test("GET lista shims e sessões controláveis", async () => {
  rejection = undefined;
  const res = await call("GET");
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.available, true);
  assert.deepEqual(body.shims, []);
  assert.deepEqual(body.live, []);
});

test("POST exige tipo, cabeçalho e corpo válido", async () => {
  rejection = undefined;
  const noType = await call("POST", "{}");
  assert.equal(noType.status, 415);

  const noHeader = await call("POST", "{}", { "content-type": "application/json" });
  assert.equal(noHeader.status, 400);

  const badJson = await call("POST", "{", {
    "content-type": "application/json",
    "x-visor-control": "1",
  });
  assert.equal(badJson.status, 400);

  const unknown = await call("POST", JSON.stringify({ action: "nope" }), {
    "content-type": "application/json",
    "x-visor-control": "1",
  });
  assert.equal(unknown.status, 400);

  const cancel = await call("POST", JSON.stringify({
    action: "cancel",
    dsh_session_id: "00000000-0000-4000-8000-000000000000",
  }), {
    "content-type": "application/json",
    "x-visor-control": "1",
  });
  assert.equal(cancel.status, 200);
  const body = JSON.parse(cancel.body);
  assert.equal(body.ok, false);
  assert.equal(body.code, "not-live");
});

test("rota devolve 401/403 da conexão", async () => {
  rejection = 401;
  const unauthorized = await call("GET");
  assert.equal(unauthorized.status, 401);

  rejection = 403;
  const forbidden = await call("GET");
  assert.equal(forbidden.status, 403);
  rejection = undefined;
});
