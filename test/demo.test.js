import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store } from "../src/db.js";
import { sameListing } from "../src/dedupe.js";
import { seedDemo } from "../src/demo.js";

test("the demo's fictional flats are fingerprinted and never match each other", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ssw-demo-"));
  await seedDemo(dir);
  const store = new Store(path.join(dir, "sg-stay-where.sqlite"));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const listings = store.listListings();
  assert.ok(listings.every((l) => l.photo_hashes?.length === l.photos.length), "nothing left for the browser to fingerprint");
  for (const a of listings) for (const b of listings) if (a.id < b.id) assert.equal(sameListing(a, b), false, `${a.building} / ${b.building}`);
});
