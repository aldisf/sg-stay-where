import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/db.js";

const PG = "https://www.propertyguru.com.sg/listing/500000202";

function fresh() {
  return new Store(":memory:");
}

test("messages are refused for a chat that is not a property chat", () => {
  const s = fresh();
  assert.throws(() => s.addMessages("6591234567@s.whatsapp.net", [{ id: "a", fromMe: false, ts: 1, text: "hi" }]), /unflagged/);
});

test("ignoring a chat deletes its messages and moves auto statuses back", () => {
  const s = fresh();
  const { listing } = s.upsertListing({ source: "propertyguru", source_id: "500000202", url: PG });
  const jid = "6591234567@s.whatsapp.net";
  s.flagChat(jid, { reason: PG, phone: "6591234567" });
  s.addMessages(jid, [{ id: "1", fromMe: true, ts: 1, text: `interested ${PG}` }, { id: "2", fromMe: false, ts: 2, text: "yes" }]);
  s.linkChat(jid, listing.id, "url");
  s.refreshLead(listing.id);
  assert.equal(s.getListing(listing.id).status, "replied");
  s.ignoreChat(jid, "personal");
  assert.equal(s.chatMessages(jid).length, 0);
  assert.equal(s.isFlagged(jid), false);
  assert.equal(s.getListing(listing.id).status, "shortlisted");
  s.flagChat(jid, { reason: PG });
  assert.equal(s.isFlagged(jid), false, "an ignored chat cannot be flagged again");
});

test("portal bot chats only contribute your enquiry, never a reply", () => {
  const s = fresh();
  const { listing } = s.upsertListing({ source: "propertyguru", source_id: "500000202", url: PG });
  const bot = "6530000000@s.whatsapp.net";
  s.flagChat(bot, { reason: PG });
  s.addMessages(bot, [
    { id: "q", fromMe: true, ts: 1, text: `Hi PropertyGuru, I am interested in: 81 Commonwealth Close URL: ${PG}` },
    { id: "r", fromMe: false, ts: 2, text: "Thank you for your enquiry. WhatsApp the agent directly here: https://www.propertyguru.com.sg/contact-agent/x" }
  ]);
  assert.equal(s.classifyChat(bot), "portal");
  s.linkChat(bot, listing.id, "url");
  const msgs = s.listingMessages(listing.id);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].from_me, 1);
  s.refreshLead(listing.id);
  assert.equal(s.getListing(listing.id).status, "contacted");
});

test("a short link folds into the real listing and fills the agent phone from the chat", () => {
  const s = fresh();
  const stub = s.upsertListing({ source: "99co", source_id: "e-Ex4mPl3Z", url: "https://www.99.co/e/Ex4mPl3Z" }).listing;
  const jid = "6580000077@s.whatsapp.net";
  s.flagChat(jid, { reason: "99", phone: "6580000077" });
  s.addMessages(jid, [{ id: "1", fromMe: true, ts: 1, text: "https://www.99.co/e/Ex4mPl3Z" }, { id: "2", fromMe: false, ts: 2, text: "details pls" }]);
  s.linkChat(jid, stub.id, "url");
  const real = s.upsertListing({ source: "99co", source_id: "Ex4mpleL1st1ngIdAbCdEf", url: "https://www.99.co/singapore/rent/property/example-condo-Ex4mpleL1st1ngIdAbCdEf", price: 2900 }).listing;
  s.mergeAlias("99co:e-Ex4mPl3Z", real.id);
  s.refreshLead(real.id);
  assert.equal(s.getListing(stub.id), null);
  assert.equal(s.findListingByKey("99co:e-Ex4mPl3Z").id, real.id);
  assert.equal(s.listingMessages(real.id).length, 2);
  assert.equal(s.getListing(real.id).agent_phone, "6580000077");
  assert.equal(s.getListing(real.id).status, "replied");
});

test("a search-card re-import only updates price and availability of a detailed listing", () => {
  const s = fresh();
  const { listing } = s.upsertListing({ source: "propertyguru", source_id: "500000202", url: PG, building: "81 Commonwealth Close", facts: ["Fully furnished", "2 years lease"], price: 2899, details_at: "2026-10-25T00:00:00Z" });
  const card = s.upsertListing({ source: "propertyguru", source_id: "500000202", url: PG, building: "81 Commonwealth Close · HDB", facts: ["1", "1", "495 sqft"], price: 2800, availability: "Ready to move" }).listing;
  assert.equal(card.id, listing.id);
  assert.equal(card.price, 2800);
  assert.equal(card.availability, "Ready to move");
  assert.equal(card.building, "81 Commonwealth Close");
  assert.deepEqual(card.facts, ["Fully furnished", "2 years lease"]);
});

test("re-importing a listing keeps the user's status and notes", () => {
  const s = fresh();
  const { listing } = s.upsertListing({ source: "propertyguru", source_id: "500000202", url: PG, price: 2899 });
  s.updateListing(listing.id, { status: "viewed", notes: "nice light" });
  const again = s.upsertListing({ source: "propertyguru", source_id: "500000202", url: PG, price: 2800, status: "new", notes: "x" });
  assert.equal(again.created, false);
  assert.equal(again.listing.price, 2800);
  assert.equal(again.listing.status, "viewed");
  assert.equal(again.listing.notes, "nice light");
});

test("merging a copy points its link, chats and key at the listing kept", () => {
  const s = new Store(":memory:");
  const keep = s.upsertListing({ source: "propertyguru", source_id: "500000909", url: "https://www.propertyguru.com.sg/listing/500000909", price: 3000 }).listing;
  const copy = s.upsertListing({ source: "99co", source_id: "Ex4mpleCopyIdAbCdEfGhIj", url: "https://www.99.co/singapore/rent/property/x-condo-Ex4mpleCopyIdAbCdEfGhIj", price: 3000 }).listing;
  const jid = "6580000099@s.whatsapp.net";
  s.flagChat(jid, { reason: "99", phone: "6580000099" });
  s.addMessages(jid, [{ id: "m1", fromMe: true, ts: 10, text: `Hi, is this available? ${copy.url}` }]);
  s.linkChat(jid, copy.id, "url");
  s.mergeListing(copy.id, keep.id, "Auto-skipped: same flat as #1");
  const after = s.getListing(copy.id);
  assert.equal(after.status, "rejected");
  assert.equal(after.merged_into, keep.id);
  assert.deepEqual(s.getListing(keep.id).also.map((a) => a.source), ["99co"]);
  assert.equal(s.findListingByKey(copy.listing_key).id, keep.id);
  assert.deepEqual(s.chatsForListing(keep.id).map((c) => c.jid), [jid]);
  assert.equal(s.chatsForListing(copy.id).length, 0);
  // The kept listing reads the chat as its own (the copy's id counts as a mention).
  assert.equal(s.listingMessages(keep.id).length, 1);
});

test("a split puts the copy back as it was and keeps the pair apart", () => {
  const s = new Store(":memory:");
  const a = s.upsertListing({ source: "propertyguru", source_id: "500000911", url: "https://www.propertyguru.com.sg/listing/500000911", price: 3000 }).listing;
  const b = s.upsertListing({ source: "99co", source_id: "Ex4mpleSplitIdAbCdEfGhIj", url: "https://www.99.co/singapore/rent/property/y-condo-Ex4mpleSplitIdAbCdEfGhIj", price: 3000 }).listing;
  s.updateListing(b.id, { status: "shortlisted", notes: "nice" });
  s.mergeListing(b.id, a.id, "Merged by you");
  s.splitListing(b.id);
  const back = s.getListing(b.id);
  assert.equal(back.status, "shortlisted");
  assert.equal(back.notes, "nice");
  assert.equal(back.merged_into, null);
  assert.deepEqual(s.getListing(a.id).also, []);
  assert.equal(s.findListingByKey(b.listing_key).id, b.id);
  assert.equal(s.isDistinct(a.id, b.id), true);
});

test("merging a card that has copies moves them to the card kept", () => {
  const s = new Store(":memory:");
  const mk = (n) => s.upsertListing({ source: "propertyguru", source_id: `50000092${n}`, url: `https://www.propertyguru.com.sg/listing/50000092${n}`, price: 3000 }).listing;
  const [a, b, c] = [mk(1), mk(2), mk(3)];
  s.mergeListing(c.id, b.id, "x");
  s.mergeListing(b.id, a.id, "y");
  assert.equal(s.getListing(c.id).merged_into, a.id);
  assert.deepEqual(s.getListing(a.id).also.map((x) => x.id).sort(), [b.id, c.id].sort());
  assert.equal(s.findListingByKey(c.listing_key).id, a.id);
});
