/**
 * Testa o gerenciador do canal de controle contra um shim real iniciado em
 * diretório temporário, sem chamar a API do DeepSeek.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import {
  callShim,
  createControlManager,
  findLiveSession,
  listShims,
  status,
} from "../lib/control.mjs";

const SERVER = fileURLToPath(new URL("../../dsh-acp/server.mjs", import.meta.url));
let base;
let workspace;

before(async () => {
  const root = path.join(os.homedir(), ".local", "state", "visor-dsh", "teste");
  await fs.mkdir(root, { recursive: true });
  base = await fs.mkdtemp(path.join(root, "control-"));
  workspace = path.join(base, "ws");
  await fs.mkdir(workspace, { recursive: true });
});

after(async () => {
  if (process.env.VISOR_KEEP_TEST === "1") return;
  await fs.rm(base, { recursive: true, force: true });
});

test("manager sobe um shim e fala list pelo socket", async () => {
  const manager = createControlManager({ base, server: SERVER });
  try {
    const shim = await manager.ensureShim(workspace);
    assert.equal(typeof shim.pid, "number");
    assert.ok(shim.pid > 0);

    const shims = await listShims(base);
    assert.ok(shims.some((item) => item.pid === shim.pid && item.workspace === workspace));

    const response = await callShim(shim, { id: "test", action: "list" }, { timeoutMs: 5000 });
    assert.equal(response.ok, true);
    assert.equal(response.result.pid, shim.pid);
    assert.deepEqual(response.result.sessions, []);

    const current = await status(base);
    assert.ok(current.shims.some((item) => item.pid === shim.pid));
    assert.equal(current.live.length, 0);

    assert.equal(await findLiveSession("00000000-0000-4000-8000-000000000000", base), null);
    const cancelMissing = await manager.cancelSession("00000000-0000-4000-8000-000000000000", 0);
    assert.equal(cancelMissing.ok, false);
    assert.equal(cancelMissing.code, "not-live");

    const badResume = await manager.resumeSession({
      dshSessionId: "00000000-0000-4000-8000-000000000000",
      cwd: workspace,
      prompt: "",
    });
    assert.equal(badResume.ok, false);
  } finally {
    manager.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  const remaining = await listShims(base).catch(() => []);
  assert.equal(remaining.length, 0);
});
