/**
 * Testa o proxy loopback do Tailscale Serve com um upstream falso.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createProxyServer } from "../index.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function get(port, path, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path,
      method: "GET",
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("reescreve Host/Origin/Referer e encaminha HTTP e WebSocket", async () => {
  let httpSeen = null;
  let upgradeSeen = null;

  const upstream = http.createServer((req, res) => {
    httpSeen = { url: req.url, headers: req.headers };
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  upstream.on("upgrade", (req, socket) => {
    upgradeSeen = { url: req.url, headers: req.headers };
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n"
      + "Upgrade: websocket\r\n"
      + "Connection: Upgrade\r\n\r\n",
    );
    socket.end();
  });
  const upstreamPort = await listen(upstream);

  const proxy = createProxyServer({
    upstreamHost: "127.0.0.1",
    upstreamPort,
    upstreamAuthority: "192.168.2.164:3080",
    upstreamOrigin: "http://192.168.2.164:3080",
  });
  const proxyPort = await listen(proxy);

  try {
    const response = await get(proxyPort, "/api/visor/sessions", {
      Host: "bazzite.example.ts.net",
      Origin: "https://bazzite.example.ts.net",
      Referer: "https://bazzite.example.ts.net/visao?x=1",
      "Sec-Fetch-Site": "same-origin",
    });
    assert.equal(response.status, 200);
    assert.equal(response.body, "ok");
    assert.ok(httpSeen);
    assert.equal(httpSeen.url, "/api/visor/sessions");
    assert.equal(httpSeen.headers.host, "192.168.2.164:3080");
    assert.equal(httpSeen.headers.origin, "http://192.168.2.164:3080");
    assert.equal(httpSeen.headers.referer, "http://192.168.2.164:3080/visao?x=1");
    assert.equal(httpSeen.headers["sec-fetch-site"], "same-origin");

    await new Promise((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: proxyPort,
        path: "/api/socket",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
          Host: "bazzite.example.ts.net",
          Origin: "https://bazzite.example.ts.net",
          "Sec-Fetch-Site": "same-origin",
        },
      });
      request.on("upgrade", (response, socket) => {
        assert.equal(response.statusCode, 101);
        socket.destroy();
        resolve();
      });
      request.on("response", (response) => {
        reject(new Error(`unexpected HTTP ${response.statusCode}`));
      });
      request.on("error", reject);
      request.end();
    });

    assert.ok(upgradeSeen);
    assert.equal(upgradeSeen.url, "/api/socket");
    assert.equal(upgradeSeen.headers.host, "192.168.2.164:3080");
    assert.equal(upgradeSeen.headers.origin, "http://192.168.2.164:3080");
    assert.equal(upgradeSeen.headers["sec-fetch-site"], "same-origin");
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
  }
});

test("relaxa o cookie de auth para SameSite=Lax e Secure", async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(303, {
      location: "./",
      "set-cookie": [
        "dsh-auth-abc=v1.payload.sig; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict",
        "other=1; Path=/; SameSite=Strict",
      ],
    });
    res.end();
  });
  const upstreamPort = await listen(upstream);

  const proxy = createProxyServer({
    upstreamHost: "127.0.0.1",
    upstreamPort,
    upstreamAuthority: "192.168.2.164:3080",
    upstreamOrigin: "http://192.168.2.164:3080",
  });
  const proxyPort = await listen(proxy);

  try {
    const response = await get(proxyPort, "/?token=fake", {
      Host: "bazzite.example.ts.net",
    });
    assert.equal(response.status, 303);
    const cookies = response.headers["set-cookie"];
    assert.ok(Array.isArray(cookies));
    assert.equal(cookies.length, 2);
    assert.match(cookies[0], /SameSite=Lax/);
    assert.match(cookies[0], /;\s*Secure/);
    assert.doesNotMatch(cookies[0], /SameSite=Strict/);
    assert.match(cookies[0], /dsh-auth-abc=v1\.payload\.sig/);
    assert.match(cookies[1], /SameSite=Strict/);
    assert.doesNotMatch(cookies[1], /;\s*Secure/);
  } finally {
    await closeServer(proxy);
    await closeServer(upstream);
  }
});
