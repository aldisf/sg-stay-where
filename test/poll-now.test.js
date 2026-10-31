import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Store } from "../src/db.js";
import { newProject, ProjectFiles } from "../src/projects.js";

process.env.SSW_PORT = "0";
const { startServer } = await import("../src/server.js");

test("Poll now starts one background poll and the state shows it and the last poll", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ssw-pollnow-"));
  const script = path.join(dataDir, "fake-poll.mjs");
  await writeFile(script, `import { writeFileSync } from "node:fs";
writeFileSync(process.env.SSW_DATA_DIR + "/ran.json", JSON.stringify({ port: process.env.SSW_PORT, dir: process.env.SSW_DATA_DIR }));
setTimeout(() => {}, 400);`);
  const store = new Store(":memory:");
  const projects = new ProjectFiles(path.join(dataDir, "projects"));
  projects.save(newProject({ title: "Home" }));
  const server = await startServer({ root: fileURLToPath(new URL("../", import.meta.url)), dataDir, store, projects, log: () => {}, pollCommand: [process.execPath, script] });
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route) => {
    const res = await fetch(origin + route, { method, headers: { "content-type": "application/json", origin }, body: method === "GET" ? undefined : "{}" });
    return { status: res.status, body: await res.json() };
  };

  let poll = (await call("GET", "/api/state")).body.poll;
  assert.equal(poll.lastAt, null);
  assert.equal(poll.running, false);
  assert.equal(typeof poll.scheduled, "boolean");

  assert.equal((await call("POST", "/api/poll")).status, 200);
  assert.equal((await call("POST", "/api/poll")).status, 409, "one poll at a time");
  assert.equal((await call("GET", "/api/state")).body.poll.running, true);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal((await call("GET", "/api/state")).body.poll.running, false);
  const ran = JSON.parse(await readFile(path.join(dataDir, "ran.json"), "utf8"));
  assert.deepEqual(ran, { port: String(server.address().port), dir: dataDir });

  const again = await call("POST", "/api/poll");
  assert.equal(again.status, 409, "the next poll waits out the gap");
  assert.match(again.body.error ?? JSON.stringify(again.body), /20 minutes/);

  store.recordPoll({ search: "PropertyGuru · test", seen: 3, added: 1 });
  poll = (await call("GET", "/api/state")).body.poll;
  assert.ok(Date.now() - Date.parse(poll.lastAt) < 60_000);
});
