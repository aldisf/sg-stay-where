import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detailDue, PortalPacer, RECHECK_AFTER_MS } from "../src/poll-policy.js";

test("listing pages are due when never opened, or when no search page has shown them for 3 days", () => {
  const now = Date.parse("2026-11-02T00:00:00Z");
  const day = 86_400_000;
  const listing = { status: "new", details_at: new Date(now - 10 * day).toISOString(), enriched_at: "x", seen_at: new Date(now - RECHECK_AFTER_MS - 1).toISOString() };
  assert.equal(detailDue(listing, now), true);
  assert.equal(detailDue({ ...listing, seen_at: new Date(now - day).toISOString() }, now), false, "a search card showed it lately");
  assert.equal(detailDue({ ...listing, details_at: null, seen_at: null }, now), true);
  for (const status of ["rejected", "closed", "unavailable"]) assert.equal(detailDue({ ...listing, details_at: null, status }, now), false);
  for (const status of ["contacted", "applied"]) assert.equal(detailDue({ ...listing, status }, now), false, "the chat says whether it is still available");
  assert.equal(detailDue({ ...listing, merged_into: 5 }, now), false);
  assert.equal(detailDue({ ...listing, status: "shortlisted" }, now), true);
});

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
