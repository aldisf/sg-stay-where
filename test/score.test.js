import assert from "node:assert/strict";
import { test } from "node:test";
import { isColiving, scoreListing, stationAccess } from "../src/score.js";
import { criterion } from "../src/projects.js";

// A project like the example: two workplaces, MRT, three everyday places.
const project = {
  budget: { min: 2500, max: 3300, stretchMax: 3500, spread: 300 },
  criteria: [
    { type: "commute", key: "office", label: "Office", query: "Raffles Place", weight: 15 },
    { type: "commute", key: "partner", label: "Partner's office", query: "Orchard", weight: 15 },
    { type: "station", key: "mrt", weight: 13 },
    { type: "price", key: "price", weight: 17 },
    { type: "nearby", key: "laundromat", label: "Laundromat", search: "laundromat", bestMinutes: 3, worstMinutes: 15, maxMinutes: 10, weight: 3 },
    { type: "nearby", key: "hawker", label: "Hawker", search: "hawker centre", weight: 5 },
    { type: "nearby", key: "gym", label: "Gym", search: "gym", bestMinutes: 10, worstMinutes: 30, maxMinutes: 20, weight: 2.5 },
    { type: "size", key: "size", weight: 6 },
    { type: "furnishing", key: "furnishing", weight: 3.5 },
    { type: "move_in", key: "move_in", from: "2026-12", to: "2027-01", weight: 2.5 },
    { type: "lease", key: "lease", weight: 2.5 }
  ],
  bonus: { allBoxes: 10, proximity: 5 }
};

const place = (walk_min) => [{ name: "x", walk_min }];
const great = {
  price: 2700, sqft: 800, furnishing: "Fully Furnished", lease: "1 year lease", availability: "Available from 1 Dec 2026",
  enrichment: {
    mrt: [{ name: "Tanjong Pagar", walk_min: 4, walk_m: 320 }],
    commute: { office: { transit_min: 15 }, partner: { transit_min: 18 } },
    facilities: { laundromat: place(2), hawker: place(4), gym: place(8) }
  }
};

test("co-living operators are recognised from the listing text", () => {
  assert.equal(isColiving({ title: "Co-Living in Central" }), true);
  assert.equal(isColiving({ building: "Coliwoo 288 River Valley" }), true);
  assert.equal(isColiving({ title: "Spottiswoode 18" }), false);
});

test("weights are scaled to fill 100 with the bonuses", () => {
  const s = scoreListing(great, project);
  assert.equal(Math.round(s.parts.reduce((a, p) => a + p.max, 0)), 100);
  assert.equal(s.total, 100);
});

test("doubling every weight changes nothing", () => {
  const doubled = { ...project, criteria: project.criteria.map((c) => ({ ...c, weight: criterion(c).weight * 2 })) };
  const partial = { ...great, price: 3300, enrichment: { ...great.enrichment, commute: { office: { transit_min: 35 }, partner: { transit_min: 28 } } } };
  assert.equal(scoreListing(partial, doubled).total, scoreListing(partial, project).total);
});

test("ticking every must-have earns the bonus; missing one loses all of it", () => {
  const all = scoreListing(great, project);
  assert.equal(all.boxesTicked, all.boxes.length);
  const far = { ...great, enrichment: { ...great.enrichment, commute: { office: { transit_min: 45 }, partner: { transit_min: 18 } } } };
  const s = scoreListing(far, project);
  assert.equal(s.parts.find((p) => p.key === "all_boxes").points, 0);
  assert.match(s.parts.find((p) => p.key === "all_boxes").detail, /Office ≤35 min/);
});

test("size and move-in are scored but are not must-haves by default", () => {
  const s = scoreListing(great, project);
  assert.ok(!s.boxes.some((b) => b.key === "size" || b.key === "move_in"));
  assert.ok(s.chips.some((c) => c.key === "size" && c.ok === null));
});

test("unknown furnishing or lease does not fail a box, unfurnished does", () => {
  const unknown = scoreListing({ ...great, furnishing: null, lease: null }, project);
  assert.equal(unknown.boxesTicked, unknown.boxes.length);
  const bare = scoreListing({ ...great, furnishing: "Unfurnished" }, project);
  assert.equal(bare.boxes.find((b) => b.key === "furnishing").ok, false);
});

test("a chip per criterion, with its icon and a short value", () => {
  const chips = scoreListing(great, project).chips;
  assert.deepEqual(chips.map((c) => c.key), project.criteria.map((c) => c.key));
  assert.deepEqual(chips.find((c) => c.key === "mrt"), { key: "mrt", label: "MRT", icon: "train-front", value: "4m", ok: true, detail: "4 min walk", box: "MRT ≤15 min (walk <1 km or bus)" });
  assert.equal(chips.find((c) => c.key === "office").icon, "briefcase");
});

test("station: walk must be within the limit and under the distance", () => {
  const c = criterion({ type: "station" });
  assert.equal(stationAccess({ enrichment: { mrt: [{ walk_min: 12, walk_m: 950 }] } }, c).ok, true);
  assert.equal(stationAccess({ enrichment: { mrt: [{ walk_min: 12, walk_m: 1050 }] } }, c).ok, false);
  assert.equal(stationAccess({ enrichment: { mrt: [{ walk_min: 16, walk_m: 900 }] } }, c).ok, false);
});

test("station: a bus within the limit rescues a long walk, unless buses are off", () => {
  const listing = { enrichment: { mrt: [{ walk_min: 22, walk_m: 1700, transit_min: 12, transit_summary: "8:30 AM–8:42 AM bus 63" }] } };
  assert.deepEqual(stationAccess(listing, criterion({ type: "station" })).mode, "bus");
  assert.equal(stationAccess(listing, criterion({ type: "station", allowBus: false })).ok, false);
});

test("station: Google's walk-only answer to a transit query is not a bus", () => {
  const listing = { enrichment: { mrt: [{ walk_min: 18, walk_m: 1400, transit_min: 14, transit_summary: "14 min walk" }] } };
  assert.equal(stationAccess(listing, criterion({ type: "station" })).ok, false);
});

test("missing data scores half, not zero; nothing found nearby scores zero", () => {
  const s = scoreListing({ price: 2700 }, project);
  const office = s.parts.find((p) => p.key === "office");
  assert.equal(office.points, office.max / 2);
  assert.equal(office.missing, true);
  const none = scoreListing({ ...great, enrichment: { ...great.enrichment, facilities: { ...great.enrichment.facilities, gym: [] } } }, project);
  assert.equal(none.parts.find((p) => p.key === "gym").points, 0);
});

test("a close, cheap, well-connected unit outscores a far, pricey one", () => {
  const far = {
    price: 3450, sqft: 400, furnishing: "Unfurnished",
    enrichment: { mrt: [{ walk_min: 20, walk_m: 1600 }], commute: { office: { transit_min: 48 }, partner: { transit_min: 45 } }, facilities: { laundromat: place(14), hawker: place(18), gym: [] } }
  };
  assert.ok(scoreListing(great, project).total > scoreListing(far, project).total + 40);
});
