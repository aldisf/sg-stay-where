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

test("since the run's start, each project gets at most poll.listings Maps checks", async (t) => {
  const { call, add } = await tracker(t, { listings: 2 });
  const ids = await add(flat(1), flat(2), flat(3));
  const { now, left } = await call("GET", "/api/queue/maps?limit=10");
  assert.equal(left, 2);
  await call("PUT", `/api/listings/${ids[0]}/enrichment`, { source: "google-maps", checked_at: now });
  const later = await call("GET", `/api/queue/maps?limit=10&since=${encodeURIComponent(now)}`);
  assert.deepEqual(later.listings.map((l) => l.id), [ids[1]]);
  assert.equal(later.waiting, 2, "the rest still wait, for the next run");
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
