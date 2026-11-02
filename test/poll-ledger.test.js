import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Store } from "../src/db.js";
import { newProject, ProjectFiles } from "../src/projects.js";

process.env.SSW_PORT = "0";
const { startServer } = await import("../src/server.js");

test("a skipped search is recorded with its reason, and each search's last poll is in the state", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ssw-ledger-"));
  const store = new Store(":memory:");
  const projects = new ProjectFiles(path.join(dataDir, "projects"));
  projects.save(newProject({ title: "Home" }));
  const server = await startServer({ root: fileURLToPath(new URL("../", import.meta.url)), dataDir, store, projects, log: () => {} });
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, data) => {
    const res = await fetch(origin + route, { method, headers: { "content-type": "application/json", origin }, body: data == null ? undefined : JSON.stringify(data) });
    return { status: res.status, body: await res.json() };
  };
  store.recordPoll({ search: "PropertyGuru · central", seen: 20, added: 4 });
  assert.equal((await call("POST", "/api/polls", { search: "PropertyGuru · central", note: "skipped: Cloudflare check" })).status, 200);
  assert.equal((await call("POST", "/api/polls", { search: "", note: "x" })).status, 400);
  store.recordPoll({ search: "99.co · central", seen: 30, added: 2 });
  const last = (await call("GET", "/api/state")).body.searchLast;
  assert.equal(last["PropertyGuru · central"].note, "skipped: Cloudflare check");
  assert.equal(last["PropertyGuru · central"].added, 0);
  assert.equal(last["99.co · central"].added, 2);
});
