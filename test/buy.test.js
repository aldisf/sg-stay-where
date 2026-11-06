import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Store } from "../src/db.js";
import { composeIntro } from "../src/intro.js";
import { leadSignals } from "../src/leads.js";
import { findPropertyLinks } from "../src/links.js";
import { checkProject, newProject, ProjectFiles } from "../src/projects.js";
import { projectVersion, requestSearchBrief, resolveSearchBrief } from "../src/search-brief.js";
import { applySearchLinks, applyTemplate } from "../src/searches.js";

process.env.SSW_PORT = "0";
const { startServer } = await import("../src/server.js");

const PG_SALE = "https://www.propertyguru.com.sg/property-for-sale?listingType=sale&isCommercial=false&minPrice=500000&maxPrice=900000";
const N99_SALE = "https://www.99.co/singapore/sale?main_category=all&property_segments=residential&price_range=500000,900000";
const CX_SALE = "https://www.carousell.sg/categories/property-102/property-for-sale-230/?price_start=500000&price_end=900000";
const filters = { minPrice: 500000, maxPrice: 900000, bedrooms: [3], wholeUnit: true, districts: [] };

test("a project is for renting or buying; buying starts without rental criteria", () => {
  assert.deepEqual(checkProject({ ...newProject({ title: "Rent" }) }), []);
  assert.match(checkProject({ ...newProject({ title: "X" }), deal: "lease" }).join(), /deal must be "rent" or "buy"/);
  const buy = newProject({ title: "Our flat", deal: "buy" });
  assert.equal(buy.deal, "buy");
  assert.deepEqual(checkProject(buy), []);
  const types = buy.criteria.map((c) => c.type);
  assert.ok(!types.includes("lease") && !types.includes("furnishing"), types.join());
  assert.ok(types.includes("price") && types.includes("station"));
});

test("buying searches come from links the agent built on each site, newest first", () => {
  const buy = newProject({ title: "Our flat", deal: "buy" });
  assert.throws(() => applyTemplate(buy, "main", { filters }), /by link/);
  const next = applySearchLinks(buy, "main", { searches: [{ url: PG_SALE }, { url: N99_SALE, title: "99.co · HDB 4-room+" }, { url: CX_SALE }] });
  assert.deepEqual(next.searches.map((s) => [s.id, s.site, s.template, s.active, s.pages]), [
    ["main-propertyguru", "propertyguru", "main", true, 5],
    ["main-99co", "99co", "main", true, 5],
    ["main-carousell", "carousell", "main", true, 5]
  ]);
  assert.match(next.searches[0].url, /sort=date&order=desc/);
  assert.match(next.searches[1].url, /sort_field=recency&sort_order=desc/);
  assert.match(next.searches[2].url, /sort_by=3/);
  assert.equal(next.searches[1].title, "99.co · HDB 4-room+");
  // Re-applying replaces the template's searches and keeps each one's switch.
  next.searches[1].active = false;
  const again = applySearchLinks({ ...next, searches: [...next.searches, { id: "own", title: "Own", site: "propertyguru", url: PG_SALE, active: true }] }, "main", { searches: [{ url: N99_SALE }], pages: 3 });
  assert.deepEqual(again.searches.map((s) => [s.id, s.active, s.pages ?? null]), [["own", true, null], ["main-99co", false, 3]]);
  assert.throws(() => applySearchLinks(buy, "main", { searches: [{ url: "https://example.com/x" }] }), /PropertyGuru, 99.co or Carousell/);
  assert.throws(() => applySearchLinks(buy, "main", { searches: [] }), /at least one/);
  const east = applySearchLinks(buy, "main", { searches: [{ url: N99_SALE, districts: ["D16", "D18"], why: "99.co has no district filter" }] }).searches[0];
  assert.deepEqual([east.districts, east.why], [["D16", "D18"], "99.co has no district filter"]);
  assert.throws(() => applySearchLinks(buy, "main", { searches: [{ url: N99_SALE, districts: ["D99"] }] }), /D01–D28/);
});

test("a sourcing plan for a buying project carries the searches the agent built", () => {
  const buy = requestSearchBrief(newProject({ title: "Our flat", deal: "buy" }), "4-room HDB in the east, up to S$800k");
  const plan = { revision: buy.searchBrief.revision, projectVersion: projectVersion(buy), searches: [{ url: PG_SALE }, { url: CX_SALE }], explanation: "HDB 4-room+ in D16–D18 on PropertyGuru; Carousell has price only." };
  const applied = resolveSearchBrief(buy, plan);
  assert.equal(applied.searchBrief.status, "applied");
  assert.deepEqual(applied.searches.map((s) => s.site), ["propertyguru", "carousell"]);
});

test("the buyer's intro has no monthly rent, and names financing and timing", () => {
  const listing = { source: "propertyguru", building: "100A Example Road", bedrooms: 3, price: 758000, url: "https://www.propertyguru.com.sg/listing/hdb-for-sale-100a-example-road-500000901", agent_name: "Rachel Tan" };
  const text = composeIntro({ deal: "buy", name: "Alex", household: "Couple, first home", residency: "Singapore citizens", financing: "HDB loan, HFE letter ready", moveIn: "Within 6 months", closing: "Could we view it this week?", budget: { min: 600000, max: 800000, stretchMax: 820000, spread: 20000, roundTo: 1000 } }, listing);
  assert.doesNotMatch(text, /\/month/);
  assert.match(text, /\(S\$758,000\)/);
  assert.match(text, /Financing: HDB loan, HFE letter ready/);
  assert.match(text, /Timeline: Within 6 months/);
  assert.match(text, /Budget: S\$738,000–778,000/);
  assert.match(text, /^Hi Rachel, I'm Alex\./);
});

test("sale listing links count for the WhatsApp filter, and sold means taken", () => {
  assert.equal(findPropertyLinks("hi https://www.propertyguru.com.sg/listing/hdb-for-sale-100a-example-road-500000901")[0].listingKey, "propertyguru:500000901");
  assert.equal(findPropertyLinks("https://www.99.co/singapore/sale/property/100b-example-view-hdb-8KNzExampleHdbView0001")[0].source, "99co");
  const me = (ts, text) => ({ ts, text, from_me: true });
  const agent = (ts, text) => ({ ts, text, from_me: false });
  for (const text of ["Sorry, it's sold", "The unit has been sold", "Sold already", "Owner has granted the option to another buyer", "OTP exercised yesterday"]) {
    assert.ok(leadSignals([me(1, "hi"), agent(2, text)]).unavailable, text);
  }
  for (const text of ["Yes, still available", "I sold a similar unit last month, this one is open for viewing"]) {
    assert.equal(leadSignals([me(1, "hi"), agent(2, text)]).unavailable, null, text);
  }
});

test("the API creates buying projects, refuses the rental template for them and adds sale searches by link", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ssw-buy-"));
  const store = new Store(":memory:");
  const projects = new ProjectFiles(path.join(dataDir, "projects"));
  const server = await startServer({ root: fileURLToPath(new URL("../", import.meta.url)), dataDir, store, projects, log: () => {} });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, data) => {
    const res = await fetch(origin + route, { method, headers: { "content-type": "application/json", origin }, body: data == null ? undefined : JSON.stringify(data) });
    return { status: res.status, body: await res.json() };
  };
  const created = await call("POST", "/api/projects", { title: "Our flat", deal: "buy" });
  assert.equal(created.body.deal, "buy");
  const id = created.body.id;
  assert.equal((await call("PUT", `/api/projects/${id}/templates/main`, { filters })).status, 400);
  const added = await call("POST", `/api/projects/${id}/searches`, { title: "PropertyGuru · HDB east", url: PG_SALE });
  assert.equal(added.status, 200);
  assert.match(added.body.url, /property-for-sale.*sort=date&order=desc/);
  const state = (await call("GET", `/api/state?project=${id}`)).body;
  assert.equal(state.project.deal, "buy");
  assert.equal(state.templateDraft, null);
  assert.equal((await call("POST", "/api/projects", { title: "Bad", deal: "lease" })).status, 400);
});
