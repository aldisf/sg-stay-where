import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = (dir) => spawnSync("zsh", ["scripts/poll.sh"], { cwd: root, encoding: "utf8", env: { ...process.env, SSW_DATA_DIR: dir, SSW_AGENT: "none-such" } });

test("polls start at least 20 minutes apart", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ssw-gap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "poll.last"), String(Math.floor(Date.now() / 1000) - 5 * 60));
  const soon = run(dir);
  assert.equal(soon.status, 0);
  assert.match(soon.stdout, /last poll started 5 min ago/);
  writeFileSync(path.join(dir, "poll.last"), String(Math.floor(Date.now() / 1000) - 25 * 60));
  const later = run(dir);
  assert.equal(later.status, 2, "past the gap it goes on to start the agent");
  assert.match(later.stderr, /SSW_AGENT must be/);
});
