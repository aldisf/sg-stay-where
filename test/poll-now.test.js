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
writeFileSync(process.env.SSW_DATA_DIR + "/poll.last", String(Math.floor(Date.now() / 1000)));
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

test("browser imports and CLI skips belong to one run; a later failure cannot borrow earlier search success", async t => {
  const { PollRuns } = await import("../src/poll-runs.js");
  const dataDir = await mkdtemp(path.join(tmpdir(), "ssw-run-api-"));
  const store = new Store(":memory:");
  const runs = new PollRuns(store.db);
  const projects = new ProjectFiles(path.join(dataDir, "projects"));
  projects.save(newProject({ title: "Home" }));
  const server = await startServer({ root: fileURLToPath(new URL("../", import.meta.url)), dataDir, store, projects, log: () => {}, pollJobs: [] });
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body, headers = {}) => {
    const res = await fetch(origin + route, { method, headers: { "content-type": "application/json", origin, ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const searches = [{ projectId: "home", id: "pg", title: "PG" }, { projectId: "home", id: "99", title: "99" }];
  let id = runs.start({ job: "sites", agent: "fake", searches });
  assert.equal((await call("POST", "/api/import", { project: "home", listings: [], poll: "PG" })).status, 200);
  assert.equal((await call("POST", "/api/polls", { search: "99", project: "home", note: "skipped: browser unavailable" }, { "x-ssw-poll-run": id })).status, 200);
  assert.equal(runs.finish(id, { code: 0 }).state, "ok");
  assert.equal((await call("GET", "/api/state")).body.poll.health, "ok");
  id = runs.start({ job: "sites", agent: "fake", searches });
  runs.finish(id, { code: 7 });
  const poll = (await call("GET", "/api/state")).body.poll;
  assert.equal(poll.health, "failed");
  assert.equal(poll.lastRun.exit_code, 7);
  assert.match(poll.reason, /Agent exited 7/);
  assert.deepEqual(poll.skipped, [], "previous run's skip must not leak into this one");
  assert.equal((await call("POST", "/api/polls", { search: "99", note: "skipped: browser unavailable" }, { "x-ssw-poll-run": id })).status, 409);
  assert.equal((await call("POST", "/api/import", { project: "home", poll: "PG", listings: [{ url: "https://www.propertyguru.com.sg/listing/for-rent-example-999991234", source: "propertyguru", source_id: "999991234" }] }, { "x-ssw-poll-run": id })).status, 409);
  assert.equal(store.listListings().length, 0, "a refused stale worker must not mutate listings");
});
