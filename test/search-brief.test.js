import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject } from '../src/projects.js';
import { applyTemplate } from '../src/searches.js';
import { projectVersion, requestSearchBrief, resolveSearchBrief } from '../src/search-brief.js';
const filters = { minPrice: 2000, maxPrice: 3500, bedrooms: [0, 1], wholeUnit: true, districts: ['D03'] };
const plan = p => ({ revision: p.searchBrief.revision, projectVersion: projectVersion(p), filters, pages: 2, sites: ['propertyguru', '99co'], explanation: 'Whole studio or 1BR in D03, up to S$3,500. Commute remains a scoring criterion.' });

test('a brief resolves into both portals, preserves switches and applies explicit scoring changes together', () => {
  let p = applyTemplate(newProject({ title: 'Home' }), 'main', { filters });
  p.searches[1].active = false;
  p = requestSearchBrief(p, 'Whole studio or 1BR in D03, max $3500');
  const resolved = resolveSearchBrief(p, { ...plan(p), project: { budget: { min: 2000, max: 3300, stretchMax: 3500 }, message: { name: 'Must not overwrite' } } });
  assert.equal(resolved.searchBrief.status, 'applied');
  assert.equal(resolved.searches.length, 2);
  assert.equal(resolved.searches[1].active, false);
  assert.equal(resolved.budget.stretchMax, 3500);
  assert.deepEqual(resolved.message, p.message);
  assert.equal(resolved.searches[1].pages, 2);
});

test('newer briefs or project edits reject old interpretations', () => {
  const p = requestSearchBrief(newProject({ title: 'Home' }), 'Near work');
  const old = plan(p);
  assert.throws(() => resolveSearchBrief(requestSearchBrief(p, 'Actually near school'), old), /changed/);
  assert.throws(() => resolveSearchBrief({ ...p, budget: { min: 3000, max: 4000 } }, old), /changed/);
  const applied = resolveSearchBrief(p, old);
  assert.throws(() => resolveSearchBrief(applied, old), /changed/);
});

test('ambiguity asks for detail without changing searches; invalid plans cannot apply', () => {
  const p = requestSearchBrief(newProject({ title: 'Home' }), 'Near work');
  const response = resolveSearchBrief(p, { ...plan(p), question: 'Which office address should I use?' });
  assert.equal(response.searchBrief.status, 'needs_input');
  assert.deepEqual(response.searches, p.searches);
  assert.throws(() => resolveSearchBrief(p, { ...plan(p), filters: { ...filters, maxPrice: '3500' } }), /numbers/);
  assert.throws(() => resolveSearchBrief(p, { ...plan(p), sites: [] }), /at least one/);
  assert.throws(() => resolveSearchBrief(p, { ...plan(p), pages: 6 }), /between 1 and 5/);
});
