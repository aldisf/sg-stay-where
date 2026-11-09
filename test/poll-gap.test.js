import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PollRuns } from "../src/poll-runs.js";
import { cmdQuote, lockHolder, poll, STALE_LOCK_MIN } from "../src/poll.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = (dir, ...args) => spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "src/cli.js", "poll", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, SSW_DATA_DIR: dir, SSW_AGENT: "none-such" } });
const tempDir = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ssw-poll-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("listing-site polls start at least 20 minutes apart; Google Maps checks don't wait", (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, "poll.last"), String(Math.floor(Date.now() / 1000) - 5 * 60));
  const soon = run(dir, "sites");
  assert.equal(soon.status, 0);
  assert.match(soon.stdout, /last poll started 5 min ago/);
  const maps = run(dir);
  assert.match(maps.stdout, /last poll started 5 min ago/);
  assert.equal(maps.status, 2, "the Maps agent still starts");
  writeFileSync(path.join(dir, "poll.last"), String(Math.floor(Date.now() / 1000) - 25 * 60));
  const later = run(dir, "sites");
  assert.equal(later.status, 2, "past the gap it goes on to start the agent");
  assert.match(later.stderr, /SSW_AGENT must be/);
  assert.equal(existsSync(path.join(dir, "poll.lock")), false, "the lock is removed");
  assert.equal(run(dir, "everything").status, 1);
});

test("a lock counts while its process lives and the run is under two hours; a hung run is passed over", (t) => {
  const dir = tempDir(t);
  const lock = path.join(dir, "poll.lock");
  writeFileSync(lock, String(process.pid));
  assert.equal(lockHolder(lock), process.pid);
  assert.match(run(dir, "sites").stdout, /already running/);
  const old = (Date.now() - (STALE_LOCK_MIN + 1) * 60_000) / 1000;
  utimesSync(lock, old, old);
  assert.equal(lockHolder(lock), 0, "a run this old is hung, not working");
  const later = run(dir, "sites");
  assert.doesNotMatch(later.stdout, /already running/);
  assert.equal(later.status, 2, "it went on to start the agent");
  writeFileSync(lock, "999999");
  assert.equal(lockHolder(lock), 0, "a pid that is gone");
  assert.equal(lockHolder(path.join(dir, "none.lock")), 0);
});

test("the agent gets the prompt on stdin; its report and errors go to the poll log", async (t) => {
  const dir = tempDir(t);
  const prompt = path.join(dir, "prompt.md");
  writeFileSync(prompt, "line one\nline two \"quoted\"\n");
  const agent = path.join(dir, "agent with space.mjs");
  writeFileSync(agent, "let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => { console.log('report: ' + JSON.stringify(s) + ' ' + process.argv.slice(2).join('|')); console.error('progress'); process.exit(3); });");
  const lines = [];
  const code = await poll({ root, env: { ...process.env, SSW_DATA_DIR: dir, SSW_AGENT: "fake" }, agents: { fake: [process.execPath, agent, "Bash(node src/cli.js api:*)", "-"] }, jobs: { sites: { prompt, lock: "poll.lock", log: "" } }, out: (l) => lines.push(l) });
  assert.equal(code, 3);
  const logs = readdirSync(path.join(dir, "poll-logs")).sort();
  assert.equal(logs.length, 2);
  assert.equal(readFileSync(path.join(dir, "poll-logs", logs[1]), "utf8").trim(), 'report: "line one\\nline two \\"quoted\\"\\n" Bash(node src/cli.js api:*)|-');
  assert.equal(readFileSync(path.join(dir, "poll-logs", logs[0]), "utf8").trim(), "progress");
  assert.match(lines.at(-1), /^sites: exit 3, log /);
});

// Each fake agent logs when it starts and ends, and whether the sites lock was there.
async function twoJobs(t, agentName) {
  const dir = tempDir(t);
  const agent = path.join(dir, "agent.mjs");
  writeFileSync(agent, `import { existsSync } from "node:fs";
let job = ""; process.stdin.on("data", (d) => (job += d)).on("end", async () => {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, job.trim() === "sites" ? 300 : 100));
  if (job.trim() === "maps") while (existsSync(process.env.SSW_DATA_DIR + "/poll.lock") && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));
  console.log(JSON.stringify({ job: job.trim(), start, end: Date.now(), sitesLock: existsSync(process.env.SSW_DATA_DIR + "/poll.lock") }));
});`);
  for (const job of ["sites", "maps"]) writeFileSync(path.join(dir, `${job}.md`), job);
  const jobs = { sites: { prompt: path.join(dir, "sites.md"), lock: "poll.lock", log: "" }, maps: { prompt: path.join(dir, "maps.md"), lock: "maps.lock", log: "-maps" } };
  const code = await poll({ root, env: { ...process.env, SSW_DATA_DIR: dir, SSW_AGENT: agentName }, agents: { [agentName]: [process.execPath, agent] }, jobs, out: () => {} });
  assert.equal(code, 0);
  const logs = readdirSync(path.join(dir, "poll-logs")).sort();
  assert.equal(logs.length, 2);
  assert.ok(logs[0].endsWith("-maps.log"));
  const [maps, sites] = logs.map((f) => JSON.parse(readFileSync(path.join(dir, "poll-logs", f), "utf8")));
  assert.deepEqual([sites.job, maps.job], ["sites", "maps"]);
  assert.equal(existsSync(path.join(dir, "maps.lock")), false);
  return { sites, maps };
}

test("Claude runs the listing-site and Google Maps agents side by side", async (t) => {
  const { sites, maps } = await twoJobs(t, "claude");
  assert.ok(maps.start < sites.end, "the Maps agent starts before the sites agent ends");
  assert.equal(maps.sitesLock, false, "the sites lock goes as soon as its agent ends");
  assert.ok(maps.end >= sites.end);
});

test("Codex runs the Google Maps agent after the listing-site agent", async (t) => {
  const { sites, maps } = await twoJobs(t, "codex");
  assert.ok(maps.start >= sites.end);
});

test("a failed run keeps the agent's own words as its reason and in the notification", async (t) => {
  const dir = tempDir(t);
  const prompt = path.join(dir, "prompt.md");
  writeFileSync(prompt, "go");
  const agent = path.join(dir, "agent.mjs");
  writeFileSync(agent, "process.stdin.resume().on('end', () => { console.log(\"You've hit your 5-hour limit\"); process.exit(1); });");
  const notes = [];
  const env = { ...process.env, SSW_DATA_DIR: dir, SSW_AGENT: "fake" };
  const options = { root, env, agents: { fake: [process.execPath, agent] }, jobs: { sites: { prompt, lock: "poll.lock", log: "" } }, out: () => {}, notifyUser: (_, text) => notes.push(text) };
  assert.equal(await poll(options), 1);
  const ledger = new PollRuns(path.join(dir, "sg-stay-where.sqlite"));
  t.after(() => ledger.close());
  assert.equal(ledger.recent("sites", 1)[0].reason, "You've hit your 5-hour limit");
  assert.deepEqual(notes, ["You've hit your 5-hour limit"]);
});

test("a missing agent CLI is reported in the error log, not thrown", async (t) => {
  const dir = tempDir(t);
  const code = await poll({ root, env: { ...process.env, SSW_DATA_DIR: dir, SSW_AGENT: "gone" }, agents: { gone: ["ssw-no-such-agent-cli"] }, only: "sites", out: () => {} });
  assert.notEqual(code, 0);
  assert.equal(existsSync(path.join(dir, "poll.last")), false, "a failed launch must not impose a cooldown");
  const err = readdirSync(path.join(dir, "poll-logs")).find((f) => f.endsWith(".err.log"));
  assert.ok(err, "an error log is kept");
});

test("Windows command lines quote arguments cmd.exe would split or expand", () => {
  assert.equal(cmdQuote("-p"), "-p");
  assert.equal(cmdQuote("Bash(node src/cli.js api:*)"), '"Bash(node src/cli.js api:*)"');
  assert.equal(cmdQuote('a "b"'), '"a ""b"""');
});


test("an old runner cannot remove a replacement lock", async (t) => {
  const dir = tempDir(t);
  const agent = path.join(dir, "replace-lock.mjs");
  writeFileSync(agent, `import { writeFileSync } from "node:fs"; process.stdin.resume();
writeFileSync(process.env.SSW_DATA_DIR + "/poll.lock", "999999");`);
  await poll({ root, env: { ...process.env, SSW_DATA_DIR: dir, SSW_AGENT: "fake" }, agents: { fake: [process.execPath, agent] }, only: "sites", out: () => {} });
  assert.equal(readFileSync(path.join(dir, "poll.lock"), "utf8"), "999999");
});

test("native agent executables receive shell characters as literal arguments", async t => {
  const dir = tempDir(t);
  const agent = path.join(dir, "agent & space.mjs");
  const args = ['quotes "stay quoted"', '& | < > ^ ( )', '%PATH% !NAME!', 'trailing\\'];
  writeFileSync(agent, "process.stdin.resume(); console.log(JSON.stringify(process.argv.slice(2)));");
  const code = await poll({ root, env: { ...process.env, SSW_DATA_DIR: dir, SSW_AGENT: "fake" }, agents: { fake: [process.execPath, agent, ...args] }, only: "sites", out: () => {}, notifyUser: () => {} });
  assert.equal(code, 0);
  const log = readdirSync(path.join(dir, "poll-logs")).find(f => f.endsWith(".log") && !f.endsWith(".err.log"));
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "poll-logs", log), "utf8")), args);
});

test("Windows resolves batch agent shims on PATH and forwards stdin", { skip: process.platform !== "win32" }, async t => {
  const dir = tempDir(t);
  const prompt = path.join(dir, "prompt.md"), agent = path.join(dir, "agent.mjs");
  writeFileSync(prompt, "a prompt\nwith two lines\n");
  writeFileSync(agent, "let text = ''; process.stdin.on('data', d => text += d).on('end', () => console.log(JSON.stringify({ text, args: process.argv.slice(2) })));");
  writeFileSync(path.join(dir, "ssw-test-agent.cmd"), `@echo off\r\n"${process.execPath}" "${agent}" %*\r\n`);
  const code = await poll({ root, env: { ...process.env, PATH: `${dir};${process.env.PATH}`, SSW_DATA_DIR: dir, SSW_AGENT: "fake" }, agents: { fake: ["ssw-test-agent", "argument with spaces"] }, jobs: { sites: { prompt, lock: "poll.lock", log: "" } }, out: () => {}, notifyUser: () => {} });
  const files = readdirSync(path.join(dir, "poll-logs"));
  assert.equal(code, 0, files.filter(f => f.endsWith(".err.log")).map(f => readFileSync(path.join(dir, "poll-logs", f), "utf8")).join("\n"));
  const log = files.find(f => f.endsWith(".log") && !f.endsWith(".err.log"));
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "poll-logs", log), "utf8")), { text: "a prompt\nwith two lines\n", args: ["argument with spaces"] });
});
