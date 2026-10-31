import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFirstName, budgetRange, composeIntro } from "../src/intro.js";

const budget = { min: 2500, max: 3300, stretchMax: 3500, spread: 300, roundTo: 50 };

test("budget range is listing price ± spread (the user's 2.8k -> 2.5–3.1k example)", () => {
  assert.deepEqual(budgetRange(2800, budget), { low: 2500, high: 3100, text: "S$2,500–3,100", overBudget: false });
});

test("budget range never goes above the stretch ceiling", () => {
  const r = budgetRange(3499, budget);
  assert.equal(r.high, 3500);
  assert.equal(r.low, 3200);
  const over = budgetRange(3950, budget);
  assert.equal(over.text, "S$3,200–3,500");
  assert.equal(over.overBudget, true);
});

test("agent first name skips licence numbers and non-names", () => {
  assert.equal(agentFirstName("Susan Zheng"), "Susan");
  assert.equal(agentFirstName("(R012345A) Alvin Tan"), "Alvin");
  assert.equal(agentFirstName("PropNex Realty"), "PropNex");
  assert.equal(agentFirstName(null), "");
});

test("intro uses 'Details:' and drops lines for empty profile fields", () => {
  const profile = { name: "Alex", household: "Married couple", residency: "", lifestyle: ["Non-smokers", "No pets"], moveIn: "Dec 2026", lease: "1 year", budget, closing: "Thanks!" };
  const listing = { source: "propertyguru", price: 2800, bedrooms: 1, building: "Example Suites", url: "https://www.propertyguru.com.sg/listing/500000404", agent_name: "Sam Tan" };
  const text = composeIntro(profile, listing);
  assert.match(text, /^Hi Sam, I'm Alex\./);
  assert.match(text, /\nDetails:\n/);
  assert.doesNotMatch(text, /A bit about us/);
  assert.match(text, /- Budget: S\$2,500–3,100\/month/);
  assert.doesNotMatch(text, /- \n/, "no empty bullet for the blank residency");
  assert.match(text, /https:\/\/www\.propertyguru\.com\.sg\/listing\/500000404/);
});
