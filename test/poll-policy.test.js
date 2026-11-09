import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PortalPacer } from "../src/poll-policy.js";

test("portal grants use persistent per-site jitter and never exceed the RPM ceiling", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ssw-pace-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "pace.json");
  let now = 100_000;
  let sample = 0;
  let pacer = new PortalPacer(file, () => now, () => sample);
  assert.equal(pacer.permit("99co", 10).allowed, true);
  assert.equal(pacer.permit("99co", 10).wait_ms, 6000);
  assert.equal(pacer.permit("carousell", 10).allowed, true, "sites have independent budgets");
  now += 6000;
  sample = 0.8;
  assert.equal(pacer.permit("99co", 10).allowed, true);
  pacer = new PortalPacer(file, () => now, () => 0);
  assert.equal(pacer.permit("99co", 10).wait_ms, 8400, "restart and repeated denial preserve the sampled pause");
  now += 6000;
  assert.equal(pacer.permit("99co", 10).wait_ms, 2400);
  assert.equal(pacer.permit("99co", 5).wait_ms, 6000, "lowering RPM also delays the next grant");
  now += 6000;
  const grants = [];
  for (let i = 0; i < 30; i++) {
    const answer = pacer.permit("99co", 10);
    if (answer.allowed) { grants.push(now); now++; }
    else now += answer.wait_ms;
  }
  for (const start of grants) assert.ok(grants.filter((at) => at >= start && at < start + 60_000).length <= 10);
});
