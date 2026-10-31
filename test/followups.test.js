import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function setup(t, status = 'replied') {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const listing = store.upsertListing({ source: 'propertyguru', source_id: '500000123', url: 'https://www.propertyguru.com.sg/listing/500000123', project_id: 'home' }).listing;
  store.updateListing(listing.id, { status });
  const jid = '6580000001@s.whatsapp.net';
  store.flagChat(jid, { reason: 'test' });
  store.linkChat(jid, listing.id, 'url');
  store.addMessages(jid, [
    { id: 'intro', ts: 1, fromMe: true, text: `Interested in ${listing.url}` },
    { id: 'reply', ts: 2, fromMe: false, text: 'Sorry, the owner has declined your application.' },
  ]);
  const input = (outcome = 'declined') => ({ token: store.followup(listing.id).token, outcome, summary: { text: 'Owner declined this enquiry.', next: 'Continue with other homes.' }, evidence: { chat_jid: jid, msg_id: 'reply' } });
  return { store, listing, jid, input };
}

test('refusals close followed homes once and preserve an update with its reason', t => {
  const { store, listing, input } = setup(t, 'viewed');
  const request = input();
  assert.equal(store.recordFollowup(listing.id, request).listing.status, 'closed');
  assert.equal(store.recordFollowup(listing.id, request).applied, false);
  const feed = store.updates('home');
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].kind, 'declined');
  assert.equal(feed.unread, 1);
  store.readUpdates('home', feed.items.map(u => u.key));
  assert.equal(store.updates('home').unread, 0);
  assert.equal(store.updates('other').items.length, 0);
  assert.throws(() => store.recordFollowup(listing.id, { ...request, summary: { text: 'Different decision' } }), /already reviewed/);
});

test('manual restoration fences old evidence, even with a freshly fetched snapshot', t => {
  const { store, listing, jid, input } = setup(t);
  const old = input();
  store.recordFollowup(listing.id, old);
  store.updateListing(listing.id, { status: 'shortlisted' });
  store.refreshLead(listing.id);
  assert.notEqual(store.getListing(listing.id).status, 'closed');
  assert.throws(() => store.recordFollowup(listing.id, input()), /predates/);
  store.addMessages(jid, [{ id: 'new-refusal', ts: 3, fromMe: false, text: 'Owner has confirmed they cannot proceed.' }]);
  const request = input('ended');
  request.evidence.msg_id = 'new-refusal';
  assert.equal(store.recordFollowup(listing.id, request).listing.status, 'closed');
});

test('a manual status choice never invents a summary and drops only the old appointment from a real one', t => {
  const { store, listing } = setup(t, 'new');
  store.updateListing(listing.id, { status: 'shortlisted' });
  store.updateListing(listing.id, { status: 'rejected' });
  store.updateListing(listing.id, { status: 'viewing_scheduled' });
  assert.equal(store.getListing(listing.id).summary, null);
  store.setSummary(listing.id, { text: 'Viewing booked', decision: 'viewing', viewing: { at: '2026-11-01T19:00:00+08:00', confirmed: true } });
  store.updateListing(listing.id, { status: 'replied' });
  const summary = store.getListing(listing.id).summary;
  assert.equal(summary.text, 'Viewing booked');
  assert.equal(summary.viewing, null);
  assert.equal(summary.decision, undefined);
});

test('reopening a database clears placeholder summaries left by earlier versions', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ssw-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'db.sqlite');
  let store = new Store(file);
  const { listing } = store.upsertListing({ source: 'propertyguru', source_id: '500000321', url: 'https://www.propertyguru.com.sg/listing/500000321', project_id: 'home' });
  store.db.prepare('UPDATE listings SET summary = ? WHERE id = ?').run(JSON.stringify({ viewing: null, decision: 'maybe', manually_adjusted: true }), listing.id);
  store.close();
  store = new Store(file);
  t.after(() => store.close());
  assert.equal(store.getListing(listing.id).summary, null);
});

test('same-second arrivals and edits invalidate the conversation token', t => {
  const { store, listing, jid, input } = setup(t);
  const old = input();
  store.addMessages(jid, [{ id: 'correction', ts: 2, fromMe: false, text: 'Correction: the owner agrees.' }]);
  assert.throws(() => store.recordFollowup(listing.id, old), /changed/);
  const second = input();
  store.editMessage(jid, 'correction', 'Correction: the owner would like to speak.');
  assert.throws(() => store.recordFollowup(listing.id, second), /changed/);
});

test('cancellation returns to Watching and summary-only reviews cannot restore its appointment', t => {
  const { store, listing, input } = setup(t, 'viewing_scheduled');
  const viewing = { at: '2026-11-01T19:00:00+08:00', place: 'Lobby', confirmed: true };
  store.setSummary(listing.id, { text: 'Viewing booked', viewing });
  store.recordFollowup(listing.id, input('viewing_cancelled'));
  assert.equal(store.getListing(listing.id).status, 'replied');
  assert.equal(store.getListing(listing.id).summary.viewing, null);
  const summaryOnly = input('none');
  summaryOnly.summary.viewing = viewing;
  store.recordFollowup(listing.id, summaryOnly);
  assert.equal(store.getListing(listing.id).summary.viewing, null);
});

test('a confirmed viewing needs evidence and a valid time; silence never closes', t => {
  const { store, listing, input } = setup(t);
  assert.throws(() => store.recordFollowup(listing.id, input('viewing_scheduled')), /confirmed time/);
  const request = input('viewing_scheduled');
  request.summary.viewing = { at: '2026-11-01T19:00:00+08:00', confirmed: true };
  assert.equal(store.recordFollowup(listing.id, request).listing.status, 'viewing_scheduled');
  assert.throws(() => store.recordFollowup(listing.id, { ...input(), evidence: { chat_jid: 'wrong', msg_id: 'reply' } }), /stored incoming/);
});

test('rejected listings and outgoing or portal messages cannot be closure evidence', t => {
  const { store, listing, jid, input } = setup(t);
  assert.throws(() => store.recordFollowup(listing.id, { ...input(), evidence: { chat_jid: jid, msg_id: 'intro' } }), /stored incoming/);
  store.updateListing(listing.id, { status: 'rejected' });
  assert.throws(() => store.recordFollowup(listing.id, input('none')), /Hidden/);
  assert.equal(store.updates('home').items.length, 0);
});

test('a different flat in the same chat does not leak into this listing or project', t => {
  const { store, listing, jid, input } = setup(t);
  const b = store.upsertListing({ source: 'propertyguru', source_id: '500000456', url: 'https://www.propertyguru.com.sg/listing/500000456', project_id: 'other' }).listing;
  store.updateListing(b.id, { status: 'replied' });
  store.linkChat(jid, b.id, 'url');
  store.addMessages(jid, [
    { id: 'b-link', ts: 3, fromMe: true, text: b.url },
    { id: 'b-reply', ts: 4, fromMe: false, text: 'This other flat is taken.' },
  ]);
  assert.equal(store.listingMessages(listing.id).at(-1).msg_id, 'reply');
  assert.equal(store.listingMessages(b.id).at(-1).msg_id, 'b-reply');
  assert.ok(store.updates('home').items.every(u => !u.text.includes('other flat')));
  assert.throws(() => store.recordFollowup(listing.id, { ...input(), evidence: { chat_jid: jid, msg_id: 'b-reply' } }), /stored incoming/);
});

test('ambiguous multi-flat links cannot close either listing', t => {
  const { store, listing, jid, input } = setup(t);
  store.addMessages(jid, [
    { id: 'mixed', ts: 3, fromMe: true, text: `${listing.url} https://www.propertyguru.com.sg/listing/599999999` },
    { id: 'ambiguous', ts: 4, fromMe: false, text: 'Taken.' },
  ]);
  assert.throws(() => store.recordFollowup(listing.id, { ...input(), evidence: { chat_jid: jid, msg_id: 'ambiguous' } }), /stored incoming/);
});

test('ignoring a chat erases summaries and decisions, including merged copies', t => {
  const { store, listing, jid, input } = setup(t);
  store.recordFollowup(listing.id, input());
  const keep = store.upsertListing({ source: 'propertyguru', source_id: '500000789', url: 'https://www.propertyguru.com.sg/listing/500000789', project_id: 'home' }).listing;
  store.mergeListing(listing.id, keep.id, 'same flat');
  // An older installation may have left a summary on its merged copy.
  store.setSummary(listing.id, { text: 'private old summary' });
  store.ignoreChat(jid);
  assert.equal(store.getListing(listing.id).summary, null);
  assert.equal(store.getListing(keep.id).summary, null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM listing_updates').get().n, 0);
  assert.equal(store.updates('home').items.length, 0);
});

test('merge and split invalidate old snapshots; alias resolution preserves closed choices', t => {
  const { store, listing, input } = setup(t);
  const old = input();
  const keep = store.upsertListing({ source: 'propertyguru', source_id: '500000789', url: 'https://www.propertyguru.com.sg/listing/500000789', project_id: 'home' }).listing;
  store.mergeListing(listing.id, keep.id, 'same');
  store.splitListing(listing.id);
  assert.throws(() => store.recordFollowup(listing.id, old), /changed/);
  store.updateListing(keep.id, { status: 'closed' });
  const stub = store.upsertListing({ source: '99co', source_id: 'e-abc', url: 'https://www.99.co/e/abc', project_id: 'home' }).listing;
  store.mergeAlias(stub.listing_key, keep.id);
  assert.equal(store.getListing(keep.id).status, 'closed');
});

test('deleted messages remove their copied interpretations; new row IDs do not reuse the manual fence', t => {
  const { store, listing, jid, input } = setup(t);
  store.recordFollowup(listing.id, input());
  store.updateListing(listing.id, { status: 'shortlisted' });
  store.deleteMessage(jid, 'reply');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM listing_updates').get().n, 0);
  store.addMessages(jid, [{ id: 'later', ts: 5, fromMe: false, text: 'Still declined.' }]);
  const request = input(); request.evidence.msg_id = 'later';
  assert.equal(store.recordFollowup(listing.id, request).listing.status, 'closed');
});

test('restoring a home or sending a message does not label the old agent reply as new', t => {
  const { store, listing, jid, input } = setup(t);
  store.recordFollowup(listing.id, input());
  store.updateListing(listing.id, { status: 'shortlisted' });
  assert.ok(store.updates('home').items.every(u => u.kind !== 'reply'));
  store.addMessages(jid, [{ id: 'thanks', ts: 4, fromMe: true, text: 'Thank you.' }]);
  assert.ok(store.updates('home').items.every(u => u.kind !== 'reply'));
});
