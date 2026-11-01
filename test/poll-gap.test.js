import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cmdQuote, poll } from "../src/poll.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = (dir) => spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "src/cli.js", "poll"], { cwd: root, encoding: "utf8", env: { ...process.env, SSW_DATA_DIR: dir, SSW_AGENT: "none-such" } });
const tempDir = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ssw-poll-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("polls start at least 20 minutes apart", (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, "poll.last"), String(Math.floor(Date.now() / 1000) - 5 * 60));
  const soon = run(dir);
  assert.equal(soon.status, 0);
  assert.match(soon.stdout, /last poll started 5 min ago/);
  writeFileSync(path.join(dir, "poll.last"), String(Math.floor(Date.now() / 1000) - 25 * 60));
  const later = run(dir);
  assert.equal(later.status, 2, "past the gap it goes on to start the agent");
  assert.match(later.stderr, /SSW_AGENT must be/);
  assert.equal(existsSync(path.join(dir, "poll.lock")), false, "the lock is removed");
});

test("the agent gets the prompt on stdin; its report and errors go to the poll log", async (t) => {
  const dir = tempDir(t);
  const prompt = path.join(dir, "prompt.md");
  writeFileSync(prompt, "line one\nline two \"quoted\"\n");
  const agent = path.join(dir, "agent with space.mjs");
  writeFileSync(agent, "let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => { console.log('report: ' + JSON.stringify(s) + ' ' + process.argv.slice(2).join('|')); console.error('progress'); process.exit(3); });");
  const lines = [];
  const code = await poll({ root, env: { ...process.env, SSW_DATA_DIR: dir, SSW_AGENT: "fake", SSW_POLL_PROMPT: prompt }, agents: { fake: [process.execPath, agent, "Bash(node src/cli.js api:*)", "-"] }, out: (l) => lines.push(l) });
  assert.equal(code, 3);
  const logs = readdirSync(path.join(dir, "poll-logs")).sort();
  assert.equal(logs.length, 2);
  assert.equal(readFileSync(path.join(dir, "poll-logs", logs[1]), "utf8").trim(), 'report: "line one\\nline two \\"quoted\\"\\n" Bash(node src/cli.js api:*)|-');
  assert.equal(readFileSync(path.join(dir, "poll-logs", logs[0]), "utf8").trim(), "progress");
  assert.match(lines.at(-1), /^exit 3, log /);
});

test("a missing agent CLI is reported in the error log, not thrown", async (t) => {
  const dir = tempDir(t);
  const code = await poll({ root, env: { ...process.env, SSW_DATA_DIR: dir, SSW_AGENT: "gone" }, agents: { gone: ["ssw-no-such-agent-cli"] }, out: () => {} });
  assert.notEqual(code, 0);
  const err = readdirSync(path.join(dir, "poll-logs")).find((f) => f.endsWith(".err.log"));
  assert.ok(err, "an error log is kept");
});

test("Windows command lines quote arguments cmd.exe would split or expand", () => {
  assert.equal(cmdQuote("-p"), "-p");
  assert.equal(cmdQuote("Bash(node src/cli.js api:*)"), '"Bash(node src/cli.js api:*)"');
  assert.equal(cmdQuote('a "b"'), '"a ""b"""');
});
