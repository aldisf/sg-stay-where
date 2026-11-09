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
  const server = await startServer({ root: fileURLToPath(new URL("../", import.meta.url)), dataDir, store, projects, log: () => {}, pollCommand: [process.execPath, script], pollJobs: [] });
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route) => {
    const res = await fetch(origin + route, { method, headers: { "content-type": "application/json", origin }, body: method === "GET" ? undefined : "{}" });
    return { status: res.status, body: await res.json() };
  };

  let poll = (await call("GET", "/api/state")).body.poll;
  assert.equal(poll.lastAt, null);
  assert.equal(poll.running, false);
  assert.equal(poll.scheduled, false);
  assert.equal(poll.health, "never");

  assert.equal((await call("POST", "/api/poll")).status, 200);
  assert.equal((await call("POST", "/api/poll")).status, 409, "one poll at a time");
  assert.equal((await call("GET", "/api/state")).body.poll.health, "running");
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
  assert.equal(poll.health, "ok");
});

test("the poll's health is blocked when the last run skipped every active search", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ssw-pollhealth-"));
  const store = new Store(":memory:");
  const projects = new ProjectFiles(path.join(dataDir, "projects"));
  projects.save(newProject({ title: "Home" }));
  const server = await startServer({ root: fileURLToPath(new URL("../", import.meta.url)), dataDir, store, projects, log: () => {}, pollJobs: [] });
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body) => {
    const res = await fetch(origin + route, { method, headers: { "content-type": "application/json", origin }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  await call("POST", "/api/projects/home/searches", { title: "PG · test", url: "https://www.propertyguru.com.sg/property-for-rent?minPrice=2500" });
  await call("POST", "/api/projects/home/searches", { title: "99 · test", url: "https://www.99.co/singapore/rent?price_range=2500,3600" });
  await call("POST", "/api/polls", { search: "PG · test", note: "skipped: Cloudflare check" });
  let poll = (await call("GET", "/api/state")).body.poll;
  assert.equal(poll.health, "ok", "one of two searches skipped is a partial run");
  assert.deepEqual(poll.skipped.map((s) => s.search), ["PG · test"]);
  await call("POST", "/api/polls", { search: "99 · test", note: "skipped: Chrome extension not connected" });
  poll = (await call("GET", "/api/state")).body.poll;
  assert.equal(poll.health, "blocked");
  assert.equal(poll.skipped.length, 2);
  store.recordPoll({ search: "PG · test", seen: 20, added: 2 });
  poll = (await call("GET", "/api/state")).body.poll;
  assert.equal(poll.health, "ok");
  assert.deepEqual(poll.skipped.map((s) => s.search), ["99 · test"]);
});
