import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkProject, newProject, ProjectFiles, slugify } from "../src/projects.js";

const example = JSON.parse(readFileSync(new URL("../examples/2026-rent.project.json", import.meta.url), "utf8"));

test("the shipped example project is valid", () => {
  assert.deepEqual(checkProject(example), []);
});

test("check explains what is wrong", () => {
  const bad = {
    ...example,
    id: "Bad Id",
    criteria: [...example.criteria, { type: "commute", key: "office" }, { type: "teleport" }],
    searches: [{ id: "x", title: "x", url: "https://example.com/" }]
  };
  const errors = checkProject(bad).join("\n");
  assert.match(errors, /id "Bad Id"/);
  assert.match(errors, /"office" is used twice/);
  assert.match(errors, /needs label/);
  assert.match(errors, /"teleport" is not one of/);
  assert.match(errors, /PropertyGuru, 99.co or Carousell search URL/);
});

test("slugs are filesystem-safe", () => {
  assert.equal(slugify("2026 Rent"), "2026-rent");
  assert.equal(slugify("  Buy: HDB near Mum's! "), "buy-hdb-near-mum-s");
});

test("a copied project keeps its criteria but starts with its searches off", () => {
  const copy = newProject({ title: "2027 Rent", copyFrom: example });
  assert.equal(copy.id, "2027-rent");
  assert.deepEqual(copy.criteria, example.criteria);
  assert.ok(copy.searches.every((s) => s.active === false));
});

test("project files: create picks a free id and refuses invalid saves", () => {
  const files = new ProjectFiles(mkdtempSync(path.join(tmpdir(), "ssw-")));
  files.save({ ...example });
  const second = files.create({ title: example.title, copyFrom: example.id });
  assert.equal(second.id, `${example.id}-2`);
  assert.equal(files.list().length, 2);
  assert.throws(() => files.save({ ...example, criteria: [{ type: "nope" }] }), /invalid project/);
});

test("an icon that is not downloaded yet fails the check with the command to add it", () => {
  const project = { id: "p", title: "P", budget: { min: 1000, max: 2000 }, criteria: [{ type: "nearby", key: "piano", label: "Piano studio", search: "piano studio", icon: "piano-not-shipped" }], searches: [] };
  const errors = checkProject(project);
  assert.ok(errors.some((e) => e.includes('"piano-not-shipped" is not in public/icons') && e.includes("curl -o public/icons/piano-not-shipped.svg")), errors.join("\n"));
});

test("the intro profile is complete only with the facts its deal needs", async () => {
  const { newProject, profileMissing } = await import("../src/projects.js");
  assert.deepEqual(profileMissing(newProject({ title: "Rent" })), ["first name", "household", "residency", "move-in", "lease"]);
  const rent = { ...newProject({ title: "Rent" }), message: { name: "Alex", household: "Couple", residency: "Citizens", moveIn: "Dec", lease: "1 year" } };
  assert.deepEqual(profileMissing(rent), []);
  const buy = { ...newProject({ title: "Buy", deal: "buy" }), message: { name: "Alex", household: "Couple", residency: "Citizens", moveIn: " " } };
  assert.deepEqual(profileMissing(buy), ["financing", "timeline"]);
});
