import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actedOn, advanceStatus, clearsViewing, decisionFor, detailDue, foldStatus, followupStatus, hiddenByUser, IN_ENQUIRIES, INACTIVE,
  mapsDue, needsRecheck, pollMaySetStatus, PROGRESS, rank, RECHECK_AFTER_MS, stage, STATUSES, unlinkedStatus
} from "../src/lifecycle.js";
import { leadSignals } from "../src/leads.js";

const me = (ts, text) => ({ from_me: 1, ts, text });
const agent = (ts, text) => ({ from_me: 0, ts, text });

test("the groups partition the statuses", () => {
  assert.equal(new Set(STATUSES).size, STATUSES.length);
  for (const s of STATUSES) assert.equal(rank(s) >= 0 || INACTIVE.has(s), true, `${s} is progress or inactive`);
  assert.deepEqual([...IN_ENQUIRIES].sort(), STATUSES.filter((s) => s !== "new" && s !== "rejected").sort());
  assert.deepEqual(PROGRESS, ["new", "shortlisted", "contacted", "replied", "viewing_scheduled", "viewed", "applied"]);
});

test("the chat moves a listing forward, never past replied, never out of a chosen status", () => {
  const replied = leadSignals([me(1, "hi"), agent(2, "yes")]);
  assert.equal(advanceStatus("new", replied), "replied");
  assert.equal(advanceStatus("shortlisted", replied), "replied");
  assert.equal(advanceStatus("viewing_scheduled", replied), "viewing_scheduled");
  assert.equal(advanceStatus("rejected", replied), "rejected");
  assert.equal(advanceStatus("closed", replied), "closed");
  assert.equal(advanceStatus("contacted", leadSignals([me(1, "hi")])), "contacted");
  assert.equal(unlinkedStatus("replied"), "shortlisted");
  assert.equal(unlinkedStatus("viewed"), "viewed");
});

test("chat outcomes follow one table", () => {
  assert.equal(followupStatus("replied", "none"), "replied");
  assert.equal(followupStatus("new", "unavailable"), "unavailable");
  assert.equal(followupStatus("viewed", "unavailable"), "unavailable");
  assert.throws(() => followupStatus("closed", "unavailable"), /Cannot apply unavailable to a closed/);
  assert.equal(followupStatus("replied", "declined"), "closed");
  assert.equal(followupStatus("applied", "ended"), "closed");
  assert.throws(() => followupStatus("new", "declined"), /Cannot apply/);
  assert.equal(followupStatus("viewing_scheduled", "viewing_cancelled"), "replied");
  assert.throws(() => followupStatus("replied", "viewing_cancelled"), /Cannot apply/);
  assert.equal(followupStatus("shortlisted", "viewing_scheduled"), "viewing_scheduled");
  assert.throws(() => followupStatus("viewed", "viewing_scheduled"), /Cannot apply/);
  assert.equal(followupStatus("viewing_scheduled", "viewed"), "viewed");
  assert.throws(() => followupStatus("replied", "viewed"), /Cannot apply/);
  assert.throws(() => followupStatus("replied", "bogus"), /Cannot apply bogus/);
});

test("an ending or a cancellation drops the appointment; the decision follows the status", () => {
  assert.equal(clearsViewing("viewing_cancelled", "replied"), true);
  assert.equal(clearsViewing("none", "closed"), true, "a summary of a closed enquiry keeps no appointment");
  assert.equal(clearsViewing("none", "viewing_scheduled"), false);
  assert.equal(decisionFor("viewing_scheduled", "viewing_scheduled"), "viewing");
  assert.equal(decisionFor("viewed", "viewed"), "viewed");
  assert.equal(decisionFor("declined", "closed"), "not_viewing");
  assert.equal(decisionFor("none", "replied"), "maybe");
});

test("a poll's only direct status edit is an unavailable page", () => {
  assert.equal(pollMaySetStatus("replied", "viewing_scheduled"), false);
  assert.equal(pollMaySetStatus("new", "unavailable"), true);
  assert.equal(pollMaySetStatus("new", "shortlisted"), false);
  assert.equal(pollMaySetStatus("new", "rejected"), false);
  assert.equal(pollMaySetStatus("shortlisted", "new"), false);
  assert.equal(pollMaySetStatus("rejected", "unavailable"), false);
  assert.equal(pollMaySetStatus("rejected", "rejected"), true);
});

test("folding two records keeps the one further along; endings and hides win", () => {
  assert.equal(foldStatus("new", "replied"), "replied");
  assert.equal(foldStatus("replied", "shortlisted"), "replied");
  assert.equal(foldStatus("replied", "closed"), "closed");
  assert.equal(foldStatus("viewed", "rejected"), "rejected");
  assert.equal(foldStatus("closed", "replied"), "closed");
  assert.equal(foldStatus("unavailable", "closed"), "unavailable");
});

test("only the user's own hide hides repeats, and only a skip or merge is not acting on it", () => {
  assert.equal(hiddenByUser({ status: "rejected", hidden_by: "user" }), true);
  assert.equal(hiddenByUser({ status: "rejected", hidden_by: "skip" }), false);
  assert.equal(hiddenByUser({ status: "rejected", hidden_by: "repeat" }), false);
  assert.equal(hiddenByUser({ status: "new" }), false);
  assert.equal(actedOn({ status: "new" }), false);
  assert.equal(actedOn({ status: "shortlisted" }), true);
  assert.equal(actedOn({ status: "rejected", hidden_by: "user" }), true);
  assert.equal(actedOn({ status: "rejected", hidden_by: "skip" }), false);
  assert.equal(actedOn({ status: "rejected", hidden_by: "merge" }), false);
});

test("a listing owes its page, then Google Maps, then is ready; rechecks after 3 unseen days", () => {
  const now = Date.parse("2026-11-02T00:00:00Z");
  const day = 86_400_000;
  const ready = { status: "new", details_at: new Date(now - 10 * day).toISOString(), enriched_at: "x", seen_at: new Date(now - RECHECK_AFTER_MS - 1).toISOString(), lat: 1, lng: 103 };
  assert.equal(stage({}), "details");
  assert.equal(stage({ details_at: "x" }), "maps");
  assert.equal(stage(ready), "ready");
  assert.equal(detailDue(ready, now), true, "unseen for 3 days");
  assert.equal(detailDue({ ...ready, seen_at: new Date(now - day).toISOString() }, now), false, "a search card showed it lately");
  assert.equal(detailDue({ ...ready, details_at: null, seen_at: null }, now), true);
  for (const status of ["rejected", "closed", "unavailable"]) assert.equal(detailDue({ ...ready, details_at: null, status }, now), false);
  for (const status of ["contacted", "applied"]) assert.equal(detailDue({ ...ready, status }, now), false, "the chat says whether it is still available");
  assert.equal(detailDue({ ...ready, merged_into: 5 }, now), false);
  assert.equal(detailDue({ ...ready, status: "shortlisted" }, now), true);
  assert.equal(needsRecheck({ ...ready, enriched_at: null }, now), false, "Maps first");
  assert.equal(mapsDue({ ...ready, enriched_at: null }), true);
  assert.equal(mapsDue({ ...ready, enriched_at: null, lat: null }), false, "no position yet");
  assert.equal(mapsDue({ ...ready, enriched_at: null, details_at: null }), false, "its page first");
  assert.equal(mapsDue({ ...ready, enriched_at: null, status: "closed" }), false);
  assert.equal(mapsDue(ready), false);
});
