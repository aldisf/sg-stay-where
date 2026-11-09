import assert from "node:assert/strict";
import { test } from "node:test";
import { isPortalBotMessage, leadSignals } from "../src/leads.js";
import { advanceStatus } from "../src/lifecycle.js";

const me = (ts, text) => ({ from_me: 1, ts, text });
const agent = (ts, text) => ({ from_me: 0, ts, text });

test("contacted and replied come from who spoke when", () => {
  const s = leadSignals([me(100, "is this unit still available?"), agent(200, "Yes, available")], 300);
  assert.equal(s.contactedAt, 100);
  assert.equal(s.repliedAt, 200);
  assert.equal(s.awaitingReply, false);
});

test("our own intro asking for a viewing is not a viewing signal", () => {
  const s = leadSignals([me(100, "Could we arrange a viewing?")]);
  assert.equal(s.viewing, null);
  assert.equal(s.awaitingReply, true);
});

test("a viewing time after the agent replies is picked up", () => {
  const s = leadSignals([me(100, "hi"), agent(200, "Please provide details"), agent(300, "You can come view on Tuesday 6.30pm")]);
  assert.equal(s.viewing.withTime, true);
});

test("follow-up flag after two days of silence", () => {
  const s = leadSignals([me(0, "hello is this unit still available?")], 3 * 86400);
  assert.equal(s.followUp, true);
});

test("taken phrases are hints; only an evidence-bound review closes the listing", () => {
  for (const text of ["Sorry taken.", "Taken", "Sorry the unit is taken", "Sorry this owner has just rec’d deposit. Pending for tenant to sign"]) {
    const s = leadSignals([me(1, "hi"), agent(2, text)]);
    assert.ok(s.unavailable, text);
    assert.equal(advanceStatus("replied", s), "replied", text);
  }
  for (const text of ["I have taken note of your details", "Yes, it's available for viewing"]) {
    assert.equal(leadSignals([me(1, "hi"), agent(2, text)]).unavailable, null, text);
  }
});

test("PropertyGuru and 99.co enquiry bots are recognised; agents are not", () => {
  assert.ok(isPortalBotMessage(agent(1, "*✅ Thank you for your enquiry. WhatsApp the agent directly here:* 👉 https://www.propertyguru.com.sg/contact-agent/abc")));
  assert.ok(isPortalBotMessage(agent(1, "Thank you for your enquiry. The agent will be in touch with you very soon!")));
  assert.ok(!isPortalBotMessage(agent(1, "Hi, I'm Esther Zhou. I received your enquiry from PropertyGuru")));
  assert.ok(!isPortalBotMessage(me(1, "Thank you for your enquiry. WhatsApp the agent directly")));
});
