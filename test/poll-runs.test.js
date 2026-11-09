import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PollRuns, BLOCKED_EXIT } from "../src/poll-runs.js";
import { poll } from "../src/poll.js";
import { newProject, ProjectFiles } from "../src/projects.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const searches = [{ projectId: "home", id: "pg", title: "PG" }, { projectId: "home", id: "99", title: "99" }];
const ledger = t => { const runs = new PollRuns(":memory:"); t.after(() => runs.close()); return runs; };
const start = (runs, extra = {}) => runs.start({ job: "sites", agent: "fake", searches, ...extra });
const skip = (runs, title) => runs.record({ search: title, projectId: "home", note: "skipped: Chrome extension not connected" });

test("run outcomes use only their own search reports, and finished runs cannot be rewritten", t => {
  const runs = ledger(t);
  let id = start(runs);
  skip(runs, "PG"); skip(runs, "99");
  let result = runs.finish(id, { code: 0 });
  assert.equal(result.state, "blocked");
  assert.equal(result.exit_code, BLOCKED_EXIT);
  assert.equal(result.agent_exit_code, 0);
  assert.match(result.reason, /Chrome extension/);
  assert.equal(runs.finish(id, { code: 7 }).state, "blocked");
  assert.throws(() => runs.record({ search: "PG", runId: id }), /active sites run/);
  id = start(runs);
  runs.record({ search: "PG", projectId: "home" });
  result = runs.finish(id, { code: 0 });
  assert.equal(result.state, "failed");
  assert.match(result.reason, /No search report: 99/);
  assert.equal(runs.blockedStreak(), 0);
});

test("partial reads, zero-match reads, and ordinary notes count as success; duplicate titles need a project", t => {
  const runs = ledger(t);
  const id = start(runs);
  runs.running(id);
  runs.record({ search: "PG", projectId: "home", note: "No matching listings" });
  skip(runs, "PG"); skip(runs, "99");
  assert.equal(runs.finish(id, { code: 0 }).state, "ok");
  assert.equal(runs.get(id).searches.find(s => s.title === "PG").outcome, "read");
  const duplicate = start(runs, { searches: [searches[0], { projectId: "other", id: "pg", title: "PG" }] });
  assert.equal(runs.record({ search: "PG" }), false, "an ambiguous title is never guessed");
  runs.record({ search: "PG", projectId: "home" });
  assert.equal(runs.get(duplicate).searches.filter(s => s.outcome).length, 1);
});

test("Maps-only runs do not reset repeated blocks; recovery does, and abandoned owners are interrupted", t => {
  const runs = ledger(t);
  for (let i = 0; i < 2; i++) {
    const id = start(runs);
    skip(runs, "PG"); skip(runs, "99");
    runs.finish(id, { code: 0 });
    const maps = start(runs, { job: "maps", searches: [] });
    assert.equal(runs.finish(maps, { code: 0 }).state, "ok");
  }
  assert.equal(runs.blockedStreak(), 2);
  const recovery = start(runs);
  for (const s of searches) runs.record({ search: s.title });
  runs.finish(recovery, { code: 0 });
  assert.equal(runs.blockedStreak(), 0);
  const abandoned = start(runs, { pid: 999999999 });
  runs.reconcile();
  assert.equal(runs.get(abandoned).state, "interrupted");
  assert.ok(runs.get(abandoned).finished_at);
});

test("the real runner persists failures and escalates the second fully blocked sites run", async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "ssw-runs-"));
  let runs;
  t.after(() => { runs?.close(); rmSync(dir, { recursive: true, force: true }); });
  const projects = new ProjectFiles(path.join(dir, "projects"));
  const project = newProject({ title: "Home" });
  project.searches = searches.map(s => ({ id: s.id, title: s.title, site: s.id === "pg" ? "propertyguru" : "99co", active: true, pages: 5, url: s.id === "pg" ? "https://www.propertyguru.com.sg/property-for-rent" : "https://www.99.co/singapore/rent" }));
  projects.save(project);
  const agent = path.join(dir, "agent.mjs");
  const moduleUrl = new URL("../src/poll-runs.js", import.meta.url).href;
  writeFileSync(agent, `import { PollRuns } from ${JSON.stringify(moduleUrl)};
process.stdin.resume();
const runs = new PollRuns(process.env.SSW_DATA_DIR + "/sg-stay-where.sqlite");
for (const s of runs.get(process.env.SSW_POLL_RUN_ID).searches) runs.record({ search: s.title, projectId: s.project_id, runId: process.env.SSW_POLL_RUN_ID, note: "skipped: Chrome extension not connected" });
runs.close();`);
  const notifications = [];
  const options = { root, env: { ...process.env, SSW_DATA_DIR: dir, SSW_AGENT: "fake" }, agents: { fake: [process.execPath, agent] }, only: "sites", out: () => {}, notifyUser: (...args) => notifications.push(args) };
  assert.equal(await poll(options), BLOCKED_EXIT);
  rmSync(path.join(dir, "poll.last"));
  assert.equal(await poll(options), BLOCKED_EXIT);
  assert.match(notifications[1][0], /blocked again/);
  assert.match(notifications[1][1], /Chrome extension/);
  runs = new PollRuns(path.join(dir, "sg-stay-where.sqlite"));
  assert.equal(runs.recent("sites").length, 2);
  rmSync(path.join(dir, "poll.last"));
  writeFileSync(agent, "process.stdin.resume(); process.exitCode = 7;");
  assert.equal(await poll(options), 7);
  const failed = runs.recent("sites", 1)[0];
  assert.equal(failed.state, "failed");
  assert.equal(failed.agent_exit_code, 7);
  assert.ok(failed.started_at && failed.finished_at);
});

test("two processes reclaiming a stale lock start only one worker", async t => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(execFile);
  const dir = mkdtempSync(path.join(tmpdir(), "ssw-claim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "poll.lock"), "999999999");
  const agent = path.join(dir, "agent.mjs"), invocation = path.join(dir, "invoke.mjs"), prompt = path.join(dir, "prompt.md");
  writeFileSync(agent, "process.stdin.resume(); setTimeout(() => {}, 600);");
  writeFileSync(prompt, "test");
  writeFileSync(invocation, `import { poll } from ${JSON.stringify(new URL("../src/poll.js", import.meta.url).href)};
process.exitCode = await poll({ root: ${JSON.stringify(root)}, env: { ...process.env, SSW_AGENT: "fake", SSW_DATA_DIR: ${JSON.stringify(dir)} }, agents: { fake: [process.execPath, ${JSON.stringify(agent)}] }, jobs: { sites: { prompt: ${JSON.stringify(prompt)}, lock: "poll.lock", log: "" } }, notifyUser: () => {} });`);
  const results = await Promise.all([execute(process.execPath, [invocation]), execute(process.execPath, [invocation])]);
  assert.equal(results.filter(r => r.stdout.includes("already running")).length, 1);
  const runs = new PollRuns(path.join(dir, "sg-stay-where.sqlite"));
  try { assert.equal(runs.recent("sites").length, 1); } finally { runs.close(); }
});
