import assert from "node:assert/strict";
import { test } from "node:test";
import { findPropertyLinks, hasPropertyLink, parseListingUrl } from "../src/links.js";

test("PropertyGuru listing URLs in every shape seen in chats", () => {
  for (const [href, id] of [
    ["https://www.propertyguru.com.sg/listing/hdb-for-rent-1-example-street-500000101", "500000101"],
    ["https://www.propertyguru.com.sg/listing/500000202", "500000202"],
    ["https://www.propertyguru.com.sg/l/19000303", "19000303"],
    ["propertyguru.com.sg/listing/for-rent-example-park-19000303?utm_source=x", "19000303"]
  ]) {
    const p = parseListingUrl(href);
    assert.equal(p.source, "propertyguru");
    assert.equal(p.sourceId, id, href);
    assert.equal(p.listingKey, `propertyguru:${id}`);
    assert.ok(!p.url.includes("?"), "canonical URL drops the query");
  }
});

test("99.co listing and short enquiry links", () => {
  assert.equal(parseListingUrl("https://www.99.co/singapore/rent/property/example-condo-Ex4mpleL1st1ngIdAbCdEf").listingKey, "99co:Ex4mpleL1st1ngIdAbCdEf");
  assert.equal(parseListingUrl("https://www.99.co/e/Ex4mPl3Z").listingKey, "99co:e-Ex4mPl3Z");
});

test("property-site links that are not listings are still property links", () => {
  const [contact] = findPropertyLinks("WhatsApp the agent here: https://www.propertyguru.com.sg/contact-agent/0a1b2c3d");
  assert.equal(contact.listingKey, null);
  assert.ok(hasPropertyLink("see https://www.propertyguru.com.sg/property-for-rent?freetext=Bukit"));
});

test("other links and plain text are not property links", () => {
  assert.equal(hasPropertyLink("dinner at https://maps.google.com/?q=maxwell"), false);
  assert.equal(hasPropertyLink("is the unit still available?"), false);
  assert.equal(hasPropertyLink(""), false);
});

test("one message mentioning a listing twice yields one link", () => {
  const text = "Hi, interested: https://www.propertyguru.com.sg/l/500000202 Property URL: https://www.propertyguru.com.sg/listing/500000202.";
  assert.equal(findPropertyLinks(text).length, 1);
});

test("a Carousell link counts only for a listing the tracker holds", () => {
  const sofa = "selling my sofa https://www.carousell.sg/p/ikea-sofa-1234567890/ cheap";
  assert.deepEqual(findPropertyLinks(sofa), []);
  assert.equal(hasPropertyLink(sofa), false);
  const flat = "Hi, is this available? https://www.carousell.sg/p/3-1-whole-unit-for-rent-1468612437/";
  assert.deepEqual(findPropertyLinks(flat, { isTracked: (key) => key === "carousell:1468612437" }).map((l) => l.listingKey), ["carousell:1468612437"]);
  assert.deepEqual(parseListingUrl("https://carousell.sg/p/3-1-whole-unit-for-rent-1468612437?t=1"), {
    source: "carousell", sourceId: "1468612437", listingKey: "carousell:1468612437",
    url: "https://www.carousell.sg/p/3-1-whole-unit-for-rent-1468612437/"
  });
});
