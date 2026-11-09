import assert from "node:assert/strict";
import { test } from "node:test";
import { pickPrimary, sameListing, sameUnit } from "../src/dedupe.js";

const rv = (id, over = {}) => ({ id, building: "Example Suites", price: 3300, bedrooms: 1, sqft: 366, lat: 1.29487, lng: 103.82812, ...over });

test("the same flat from another agent is a repeat", () => {
  assert.equal(sameUnit(rv(60), rv(96, { agent_name: "Agent B" })), true);
});

test("a different unit type in the same building is not", () => {
  assert.equal(sameUnit(rv(60), rv(83, { sqft: 420, price: 3350 })), false, "420 vs 366 sqft");
  assert.equal(sameUnit(rv(60), rv(99, { price: 3800 })), false, "S$500 apart");
});

test("names that differ but describe one building still match", () => {
  const a = { id: 84, building: "336 River Valley", price: 2500, sqft: 136, lat: 1.29618, lng: 103.83856 };
  const b = { id: 46, building: "RESIDE | 336 River Valley | Co-living", price: 2800, sqft: 136, lat: 1.29576, lng: 103.83857 };
  assert.equal(sameUnit(a, b), true);
});

test("far apart is never a repeat", () => {
  assert.equal(sameUnit(rv(60), rv(97, { building: "Other", lat: 1.31, lng: 103.85 })), false);
});

test("the same advert on two sites is one listing; a similar unit is not", () => {
  const pg = { id: 1, source: "propertyguru", building: "Parc Haven", price: 3000, bedrooms: 0, sqft: 452 };
  assert.equal(sameListing(pg, { id: 2, source: "99co", building: "Parc Haven", price: 3000, bedrooms: 0, sqft: 452 }), true);
  assert.equal(sameListing(pg, { id: 3, building: "Parc Haven", price: 3200, bedrooms: 0, sqft: 452 }), false);
  assert.equal(sameListing(pg, { id: 4, building: "Parc Haven", price: 3000, bedrooms: 1, sqft: 560 }), false);
  assert.equal(sameListing(pg, { id: 5, building: "Parc Haven", price: 3000, bedrooms: null, sqft: null }), true);
});

test("shared photos make two adverts one flat, even under different names", () => {
  const photos = ["0e9ed6a6badda8a9", "06e676849eb4f66e", "377f8c8cd89e518f"];
  const pg = { id: 1, building: "Blk 334 Clementi", price: 3600, bedrooms: 1, sqft: 721, photo_hashes: photos };
  const n99 = { id: 2, building: "334 Clementi Avenue 2, 120334", price: 3550, bedrooms: 1, sqft: 721, photo_hashes: photos };
  assert.equal(sameListing(pg, n99), true);
  // One shared pool shot in the same condo is not enough.
  assert.equal(sameListing({ ...pg, building: "Park Colonial", photo_hashes: photos.slice(0, 1) }, { ...n99, building: "Park Colonial", price: 3400, sqft: 463, photo_hashes: photos.slice(0, 1) }), false);
  // Different bedrooms are never the same flat.
  assert.equal(sameListing(pg, { ...n99, bedrooms: 2 }), false);
});

test("another block of the same condo is another flat, unless the photos say otherwise", () => {
  const blk45 = { id: 1, source: "propertyguru", building: "Normanton Park", address: "Normanton Park, 45 Normanton Park, Singapore 119001", price: 4200, bedrooms: 2, sqft: 667, lat: 1.2843, lng: 103.7987 };
  const blk49 = { id: 2, source: "99co", building: "Normanton Park", address: "49 Normanton Park, 119005", price: 4250, bedrooms: 2, sqft: 667, lat: 1.2845, lng: 103.7989 };
  assert.equal(sameListing(blk45, blk49), false, "block 45 vs 49");
  assert.equal(sameUnit(blk45, blk49), false, "hiding block 45 does not hide block 49");
  assert.equal(sameListing({ ...blk45, address: null, postal: "119001" }, { ...blk49, address: null, postal: "119005" }), false, "postal codes differ");
  assert.equal(sameListing({ ...blk45, building: "Whistler Grand", address: "Blk 107 West Coast Vale" }, { ...blk49, building: "Whistler Grand", address: "109 West Coast Vale" }), false, "Blk 107 vs 109");
  assert.equal(sameListing(blk45, { ...blk49, address: "45 Normanton Park, 119001" }), true, "same block");
  assert.equal(sameListing(blk45, { ...blk49, address: null }), true, "one block unknown");
  const photos = ["0e9ed6a6badda8a9", "06e676849eb4f66e", "377f8c8cd89e518f"];
  assert.equal(sameListing({ ...blk45, photo_hashes: photos }, { ...blk49, photo_hashes: photos }), true, "three shared photos");
});

test("the advert you've acted on is kept; otherwise the more complete, then the first", () => {
  const a = { id: 1, status: "new", details_at: "x", enriched_at: "x", created_at: "2026-10-26T10:00:00Z" };
  const b = { id: 2, status: "shortlisted", created_at: "2026-10-26T12:00:00Z" };
  assert.deepEqual(pickPrimary(a, b).map((l) => l.id), [2, 1]);
  assert.deepEqual(pickPrimary(a, { ...b, status: "new" }).map((l) => l.id), [1, 2]);
  assert.deepEqual(pickPrimary({ ...a, details_at: null, enriched_at: null }, { ...b, status: "new" }).map((l) => l.id), [1, 2]);
});

test("sale prices match the same flat by share of the price, not by rent-sized gaps", () => {
  const photos = ["0e9ed6a6badda8a9", "06e676849eb4f66e", "377f8c8cd89e518f"];
  const hdb = (id, over = {}) => ({ id, building: "238 Compassvale Walk", price: 670000, bedrooms: 3, sqft: 1087, lat: 1.39082, lng: 103.89849, ...over });
  assert.equal(sameListing(hdb(1, { photo_hashes: photos }), hdb(2, { building: "Blk 238 Compassvale Walk", price: 675000, photo_hashes: photos })), true, "same photos, S$5k apart");
  assert.equal(sameListing(hdb(1), hdb(2, { price: 671000 })), true, "same block and size, S$1k apart");
  assert.equal(sameListing(hdb(1), hdb(2, { price: 690000 })), false, "S$20k apart without photos");
  assert.equal(sameUnit(hdb(1), hdb(2, { price: 672000 })), true, "a repeat from another agent");
  assert.equal(sameUnit(hdb(1), hdb(2, { price: 700000 })), false, "S$30k apart");
});
