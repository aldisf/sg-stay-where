import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Store } from "../src/db.js";
import { newProject, ProjectFiles } from "../src/projects.js";

process.env.SSW_PORT = "0";
const { startServer } = await import("../src/server.js");

async function tracker(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ssw-upkeep-"));
  const store = new Store(":memory:");
  const projects = new ProjectFiles(path.join(dataDir, "projects"));
  projects.save(newProject({ title: "Home" }));
  const server = await startServer({ root: fileURLToPath(new URL("../", import.meta.url)), dataDir, store, projects, log: () => {} });
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, data, headers = {}) => {
    const res = await fetch(origin + route, { method, headers: { "content-type": "application/json", origin, ...headers }, body: data == null ? undefined : JSON.stringify(data) });
    return { status: res.status, headers: res.headers, body: res.status === 304 ? null : await res.json() };
  };
  const listing = async (id) => (await call("GET", "/api/state")).body.listings.find((l) => l.id === id);
  return { store, call, listing };
}

const flat = (n, postal, extra = {}) => ({
  url: `https://www.propertyguru.com.sg/listing/for-rent-flat-${n}`, source: "propertyguru", source_id: String(n),
  title: `Flat ${n}`, postal, lat: 1.3, lng: 103.85, price: 3000, bedrooms: 2, sqft: 700 + n, details_at: new Date().toISOString(), ...extra
});

test("a listing in a building already checked on Google Maps reuses that check, including later saves", async (t) => {
  const { call, listing } = await tracker(t);
  const [a] = (await call("POST", "/api/import", { listings: [flat(1, "123456")], found_by: "poll" })).body.results;
  await call("PUT", `/api/listings/${a.id}/enrichment`, { source: "google-maps", checked_at: "2026-11-01T00:00:00Z", facilities: { gym: [{ name: "Gym", meters: 300, walk_min: 4 }] } });
  const [b, c] = (await call("POST", "/api/import", { listings: [flat(2, "123456", { bedrooms: 3, sqft: 1100, price: 4200 }), flat(3, "654321", { bedrooms: 3, sqft: 1200, price: 4500 })], found_by: "poll" })).body.results;
  assert.equal((await listing(b.id)).needsMaps, false);
  assert.equal((await listing(b.id)).enrichment.shared_from, a.id);
  assert.equal((await listing(c.id)).needsMaps, true, "another building needs its own check");
  await call("PUT", `/api/listings/${a.id}/enrichment`, { facilityWalks: { gym: { walk_min: 6, walk_m: 420 } } });
  assert.equal((await listing(b.id)).enrichment.facilities.gym[0].walk_min, 6);
});

test("listings no search page has shown for 3 days are rechecked, and a removed page reads as removed until the user decides", async (t) => {
  const { store, call, listing } = await tracker(t);
  const [a] = (await call("POST", "/api/import", { listings: [flat(1, "123456")], found_by: "poll" })).body.results;
  await call("PUT", `/api/listings/${a.id}/enrichment`, { source: "google-maps", checked_at: "2026-11-01T00:00:00Z" });
  assert.equal((await listing(a.id)).needsRecheck, false);
  store.db.prepare("UPDATE listings SET seen_at = ? WHERE id = ?").run(new Date(Date.now() - 4 * 86_400_000).toISOString(), a.id);
  assert.equal((await listing(a.id)).needsRecheck, true);
  await call("POST", "/api/import", { listings: [flat(1, "123456", { details_at: undefined })], found_by: "poll" });
  assert.equal((await listing(a.id)).needsRecheck, false, "a search card showing it again resets the clock");

  assert.equal((await call("PATCH", `/api/listings/${a.id}`, { status: "unavailable" }, { "x-ssw-actor": "poll" })).status, 200);
  assert.ok((await listing(a.id)).gone_at);
  assert.equal((await listing(a.id)).needsRecheck, false);
  await call("PATCH", `/api/listings/${a.id}`, { status: "shortlisted" });
  assert.equal((await listing(a.id)).gone_at, null);
});

test("an unchanged state answers 304 to its tag; a change gives a new tag", async (t) => {
  const { call } = await tracker(t);
  const first = await call("GET", "/api/state");
  const tag = first.headers.get("etag");
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal((await call("GET", "/api/state", null, { "if-none-match": tag })).status, 304);
  await call("POST", "/api/import", { listings: [flat(1, "123456")], found_by: "poll" });
  const after = await call("GET", "/api/state", null, { "if-none-match": tag });
  assert.equal(after.status, 200);
  assert.notEqual(after.headers.get("etag"), tag);
});
