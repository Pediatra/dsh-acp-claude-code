/**
 * Contrato da página de acesso remoto, com ctx falso e token fictício.
 */
import assert from "node:assert/strict";
import test, { before } from "node:test";
import { apply } from "../index.js";

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
    authenticatedUrl: (base) => `${base}?token=test-token`,
  },
};

before(() => {
  apply(fakeCtx);
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
  };
}

async function call(method, url) {
  const route = routes.get("/api/remote-url");
  assert.ok(route, "rota registrada");
  const res = mockResponse();
  await route.handler({ method, url, headers: { host: "127.0.0.1" } }, res);
  return res;
}

test("gera link autenticado e QR para a base Tailscale", async () => {
  rejection = undefined;
  const res = await call("GET", "/api/remote-url?base=https://bazzite.example.ts.net/");
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-visor-remote-version"], "2");
  assert.match(res.headers["content-type"], /text\/html/);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.match(res.body, /https:\/\/bazzite\.example\.ts\.net\/\?token=test-token/);
  assert.match(res.body, /Tailscale/);
  assert.match(res.body, /Escaneie o QR/);
  assert.match(res.body, /<svg[^>]+viewBox=/);
  assert.match(res.body, /document\.execCommand\("copy"\)/);
  assert.doesNotMatch(res.body, /Base Tailscale/);
});

test("rejeita base http:// ou com query", async () => {
  rejection = undefined;
  const httpBase = await call("GET", "/api/remote-url?base=http://example.test/");
  assert.equal(httpBase.status, 400);

  const withQuery = await call("GET", "/api/remote-url?base=https://example.test/?x=1");
  assert.equal(withQuery.status, 400);
});

test("exige autenticação e responde HEAD sem corpo", async () => {
  rejection = 401;
  const unauthorized = await call("GET", "/api/remote-url?base=https://example.test/");
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers["x-visor-remote-version"], "2");
  assert.match(unauthorized.body, /Unauthorized/);

  rejection = undefined;
  const head = await call("HEAD", "/api/remote-url?base=https://example.test/");
  assert.equal(head.status, 200);
  assert.equal(head.headers["x-visor-remote-version"], "2");
  assert.equal(head.body, "");

  const post = await call("POST", "/api/remote-url?base=https://example.test/");
  assert.equal(post.status, 405);
});
