import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Store } from "../src/db.js";
import { applyTemplate } from "../src/searches.js";
import { newProject, ProjectFiles } from "../src/projects.js";

process.env.SSW_PORT = "0";
const { startServer } = await import("../src/server.js");

test("Carousell listings outside the districts, or rooms, leave Review once their page is read", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ssw-cx-"));
  const store = new Store(":memory:");
  const projects = new ProjectFiles(path.join(dataDir, "projects"));
  const home = applyTemplate({ ...newProject({ title: "Home" }), skip: { agents: [], titlePatterns: ["room rental"] } }, "main",
    { filters: { minPrice: 3000, maxPrice: 4000, bedrooms: [2], wholeUnit: true, districts: ["D09"] }, sites: ["carousell"] });
  projects.save(home);
  const server = await startServer({ root: fileURLToPath(new URL("../", import.meta.url)), dataDir, store, projects, log: () => {} });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (data) => {
    const res = await fetch(`${origin}/api/import`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ project: "home", found_by: "poll", ...data }) });
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  };
  const url = (id) => `https://www.carousell.sg/p/flat-for-rent-${id}/`;
  await post({ listings: [1000001, 1000002, 1000003].map((id) => ({ source: "carousell", source_id: String(id), url: url(id), title: "2 bedroom flat", price: 3500 })) });
  const status = (id) => store.findListingByKey(`carousell:${id}`).status;
  assert.deepEqual([1000001, 1000002, 1000003].map(status), ["new", "new", "new"], "cards wait in Review until their page is read");

  await post({ listings: [
    { source: "carousell", source_id: "1000001", url: url(1000001), postal: "238877", district: "D09", property_type: "Condos & ECs" },
    { source: "carousell", source_id: "1000002", url: url(1000002), postal: "530123", district: "D19", property_type: "HDB" },
    { source: "carousell", source_id: "1000003", url: url(1000003), postal: "238800", district: "D09", property_type: "Room Rentals" }
  ] });
  assert.deepEqual([1000001, 1000002, 1000003].map(status), ["new", "rejected", "rejected"]);
  assert.match(store.findListingByKey("carousell:1000002").notes, /outside your districts \(D19\)/);
});
