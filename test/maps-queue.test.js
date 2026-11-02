import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Store } from "../src/db.js";
import { newProject, ProjectFiles } from "../src/projects.js";

process.env.SSW_PORT = "0";
const { startServer } = await import("../src/server.js");

async function tracker(t, poll) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ssw-mapsq-"));
  const store = new Store(":memory:");
  const projects = new ProjectFiles(path.join(dataDir, "projects"));
  projects.save({ ...newProject({ title: "Home" }), poll });
  const server = await startServer({ root: fileURLToPath(new URL("../", import.meta.url)), dataDir, store, projects, log: () => {} });
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, data) => {
    const res = await fetch(origin + route, { method, headers: { "content-type": "application/json", origin }, body: data == null ? undefined : JSON.stringify(data) });
    return res.json();
  };
  const add = async (...listings) => (await call("POST", "/api/import", { listings, found_by: "poll" })).results.map((r) => r.id);
  return { dataDir, store, call, add };
}

const flat = (n, extra = {}) => ({
  url: `https://www.propertyguru.com.sg/listing/for-rent-flat-${n}`, source: "propertyguru", source_id: String(n),
  title: `Flat ${n}`, postal: String(100000 + n), lat: 1.3 + n / 1000, lng: 103.85, price: 3000, bedrooms: 2, sqft: 700 + n * 37,
  details_at: new Date().toISOString(), ...extra
});

test("the Maps queue hands out listings with details and a position, oldest first and co-living last", async (t) => {
  const { store, call, add } = await tracker(t);
  const [coliving, first, second, noDetails, noPosition, hidden] = await add(
    flat(1, { title: "Co-living room at Flat 1" }), flat(2), flat(3), flat(4, { details_at: undefined }), flat(5, { lat: undefined, lng: undefined }), flat(6)
  );
  store.db.prepare("UPDATE listings SET status = 'rejected' WHERE id = ?").run(hidden);
  const q = await call("GET", "/api/queue/maps?limit=10");
  assert.deepEqual(q.listings.map((l) => l.id), [first, second, coliving]);
  assert.ok(![noDetails, noPosition, hidden].some((id) => q.listings.some((l) => l.id === id)));
  assert.equal(q.waiting, 3);
  assert.equal(q.sitesPollRunning, false);
  assert.ok(q.criteria[q.listings[0].project].some((c) => c.type === "price"), "each project's criteria come along");
  assert.equal((await call("GET", "/api/queue/maps")).listings.length, 2, "two at a time by default");
});

test("Maps drains all ready work despite a legacy listing cap, until the run deadline", async (t) => {
  const { call, add } = await tracker(t, { listings: 2 });
  const ids = await add(flat(1), flat(2), flat(3));
  const { now, left } = await call("GET", "/api/queue/maps?limit=10");
  assert.equal(left, 3);
  await call("PUT", `/api/listings/${ids[0]}/enrichment`, { source: "google-maps", checked_at: now });
  const later = await call("GET", `/api/queue/maps?limit=10&since=${encodeURIComponent(now)}`);
  assert.deepEqual(later.listings.map((l) => l.id), [ids[1], ids[2]]);
  assert.equal(later.waiting, 2);
  const old = new Date(Date.now() - 101 * 60_000).toISOString();
  const late = await call("GET", `/api/queue/maps?limit=10&since=${encodeURIComponent(old)}`);
  assert.deepEqual([late.listings, late.timeUp], [[], true], "after 100 minutes a run takes no more, so it ends before the next poll");
});

test("an empty queue waits while the listing-site agent runs, and answers as soon as work arrives", async (t) => {
  const { dataDir, call, add } = await tracker(t);
  await writeFile(path.join(dataDir, "poll.lock"), String(process.pid));
  const started = Date.now();
  const pending = call("GET", "/api/queue/maps?wait=10");
  setTimeout(() => add(flat(1)), 400);
  const q = await pending;
  assert.equal(q.listings.length, 1);
  assert.ok(Date.now() - started < 5000);
  assert.equal(q.sitesPollRunning, true);

  await call("PUT", `/api/listings/${q.listings[0].id}/enrichment`, { source: "google-maps", checked_at: q.now });
  await rm(path.join(dataDir, "poll.lock"));
  const t0 = Date.now();
  const done = await call("GET", "/api/queue/maps?wait=10");
  assert.deepEqual(done.listings, []);
  assert.equal(done.sitesPollRunning, false);
  assert.ok(Date.now() - t0 < 1000, "with the sites agent gone it answers at once");
});

test("the detail queue opens new pages first, then unseen ones, up to poll.listings a run, and can skip blocked work", async (t) => {
  const { call, add, store } = await tracker(t, { listings: 2 });
  const [unseen, fresh, first, second, hidden] = await add(flat(1), flat(2), flat(3, { details_at: undefined }), flat(4, { details_at: undefined }), flat(5, { details_at: undefined }));
  store.db.prepare("UPDATE listings SET status = 'rejected' WHERE id = ?").run(hidden);
  store.db.prepare("UPDATE listings SET enriched_at = ?, seen_at = ? WHERE id IN (?, ?)").run(new Date().toISOString(), new Date(Date.now() - 4 * 86_400_000).toISOString(), unseen, fresh);
  store.db.prepare("UPDATE listings SET seen_at = ? WHERE id = ?").run(new Date().toISOString(), fresh);
  const q = await call("GET", "/api/queue/details?limit=10");
  assert.deepEqual(q.listings.map((l) => l.id), [first, second], "the cap of 2 takes the never-opened pages first");
  assert.equal(q.waiting, 3);
  assert.deepEqual([q.listings[0].recheck, q.listings[0].source], [false, "propertyguru"]);
  const skipped = await call("GET", `/api/queue/details?exclude=${first}&limit=10`);
  assert.deepEqual(skipped.listings.map((l) => l.id), [second, unseen]);
  assert.deepEqual((await call("GET", "/api/queue/details?excludeSites=propertyguru")).listings, []);

  const since = new Date(Date.now() - 1000).toISOString();
  await add(flat(3), flat(4));
  const later = await call("GET", `/api/queue/details?since=${encodeURIComponent(since)}&limit=10`);
  assert.deepEqual(later.listings, [], "two pages opened this run use up the cap");
  assert.equal(later.waiting, 1, "the unseen one waits for the next run");
  const expired = new Date(Date.now() - 101 * 60_000).toISOString();
  assert.equal((await call("GET", `/api/queue/details?since=${encodeURIComponent(expired)}`)).timeUp, true);
});

test("a run reopens at most 5 listings no search has shown lately", async (t) => {
  const { call, add, store } = await tracker(t, { listings: 40 });
  const ids = await add(...Array.from({ length: 7 }, (_, i) => flat(i + 1)));
  store.db.prepare(`UPDATE listings SET enriched_at = ?, seen_at = ? WHERE id IN (${ids.join(",")})`).run(new Date().toISOString(), new Date(Date.now() - 4 * 86_400_000).toISOString());
  const { now } = await call("GET", "/api/queue/details");
  const since = encodeURIComponent(now);
  const first = await call("GET", `/api/queue/details?since=${since}&limit=3`);
  assert.equal(first.listings.length, 3);
  assert.ok(first.listings.every((l) => l.recheck));
  await add(...first.listings.map((l) => flat(l.id)));
  const rest = await call("GET", `/api/queue/details?since=${since}&limit=10`);
  assert.equal(rest.listings.length, 2, "5 a run, counting the 3 already reopened");
  assert.equal(rest.waiting, 4);
});

test("the portal permit API shares pacing across projects and keeps sites independent", async (t) => {
  const { call } = await tracker(t, { rpm: 5 });
  const first = await call("POST", "/api/poll/permit", { site: "99co" });
  assert.equal(first.allowed, true);
  assert.equal(first.rpm, 5);
  const denied = await call("POST", "/api/poll/permit", { site: "99co" });
  assert.equal(denied.allowed, false);
  assert.ok(denied.wait_ms > 10_000 && denied.wait_ms <= 18_000);
  assert.equal((await call("POST", "/api/poll/permit", { site: "carousell" })).allowed, true);
  const other = await call("POST", "/api/projects", { title: "Other" });
  await call("PATCH", `/api/projects/${other.id}`, { poll: { rpm: 2 } });
  const shared = await call("POST", "/api/poll/permit", { site: "99co" });
  assert.equal(shared.rpm, 2);
  assert.equal(shared.allowed, false);
  assert.ok(shared.wait_ms > 28_000, "a second project cannot multiply the same site's budget");
});

test("a permit with wait holds the answer until the next page load is due", async (t) => {
  const { call } = await tracker(t, { rpm: 12 });
  assert.equal((await call("POST", "/api/poll/permit", { site: "propertyguru" })).allowed, true);
  const started = Date.now();
  const next = await call("POST", "/api/poll/permit", { site: "propertyguru", wait: 30 });
  assert.equal(next.allowed, true);
  assert.ok(Date.now() - started >= 4900, "5 to 7.5 seconds apart at 12 a minute");
});
