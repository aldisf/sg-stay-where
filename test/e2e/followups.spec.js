import { test, expect } from './fixtures.js';
import { Store } from '../../src/db.js';
import path from 'node:path';

test.use({ seedData: async ({}, use) => { await use(async dir => {
  const store = new Store(path.join(dir, 'sg-stay-where.sqlite'));
  const now = Math.floor(Date.now() / 1000);
  for (const [status, building, text] of [
    ['replied', 'Follow-up House', 'Sorry, the owner declined your application.'],
    ['viewing_scheduled', 'Cancelled Viewing House', 'Sorry, the viewing has been cancelled. We can arrange another day.'],
  ]) {
    const listing = store.listListings().find(l => l.status === status);
    store.updateListing(listing.id, { building });
    const jid = store.chatsForListing(listing.id)[0].jid;
    store.addMessages(jid, [{ id: `test-${status}`, fromMe: false, ts: now, text }]);
  }
  // Two readings of one home's chat, the newer one superseding the older.
  const busy = store.listListings().find(l => l.status === 'contacted');
  store.updateListing(busy.id, { building: 'Busy House' });
  const jid = store.chatsForListing(busy.id)[0].jid;
  store.addMessages(jid, [{ id: 'busy-1', fromMe: false, ts: now - 3000, text: 'Hi, when can you move in?' }]);
  let { token } = store.followup(busy.id);
  store.recordFollowup(busy.id, { token, outcome: 'none', summary: { text: 'Agent asked for the move-in date.', next: 'Tell the agent your move-in date.' }, evidence: { chat_jid: jid, msg_id: 'busy-1' } });
  store.db.prepare('UPDATE listing_updates SET created_at = ? WHERE listing_id = ?').run(new Date((now - 2000) * 1000).toISOString(), busy.id);
  store.addMessages(jid, [{ id: 'busy-2', fromMe: false, ts: now - 100, text: 'Owner can also do a 2-year lease.' }]);
  ({ token } = store.followup(busy.id));
  store.recordFollowup(busy.id, { token, outcome: 'none', summary: { text: 'Owner accepts a 2-year lease; agent still needs the move-in date.', next: 'Reply with the move-in date.' }, evidence: { chat_jid: jid, msg_id: 'busy-2' } });
  store.close();
}); } });

async function review(page, name, outcome, text) {
  const state = await (await page.request.get('/api/state')).json();
  const listing = state.listings.find(l => l.building === name);
  const snapshot = await (await page.request.get(`/api/listings/${listing.id}/follow-up`)).json();
  const evidence = snapshot.messages.filter(m => !m.from_me).at(-1);
  const response = await page.request.put(`/api/listings/${listing.id}/summary`, { data: {
    token: snapshot.token, outcome, summary: { text }, evidence: { chat_jid: evidence.chat_jid, msg_id: evidence.msg_id },
  } });
  expect(response.ok(), await response.text()).toBe(true);
  return listing.id;
}

const unit = (page, name) => page.locator('.enq-row').filter({ hasText: name });

test('the old Updates address opens Enquiries, with one row per home however many updates it has', async ({ page }) => {
  await page.goto('/#/updates');
  await expect(page).toHaveURL(/#\/enquiries$/);
  await expect(page.locator('.tabs button.active')).toHaveText(/^Enquiries/);
  const busy = unit(page, 'Busy House');
  await expect(busy).toHaveCount(1);
  await expect(busy.locator('.enq-new')).toHaveText('New');
  await expect(busy).toContainText('Owner accepts a 2-year lease; agent still needs the move-in date.');
  await expect(busy).not.toContainText('Agent asked for the move-in date.');
  await expect(page.locator('#enquiries-count')).toHaveText('3');
  const attention = page.locator('.enq-section').filter({ hasText: 'Needs your attention' });
  await expect(attention.locator('.enq-row')).toHaveCount(3);
});

test('a home with two chat readings shows one latest-state block, and opening it clears its unread count', async ({ page }) => {
  await page.goto('/#/enquiries');
  const busy = unit(page, 'Busy House');
  await busy.locator('.enq-name').click();
  const latest = page.locator('#detail .latest');
  await expect(latest).toHaveCount(1);
  await expect(latest.locator('h3')).toHaveText('Latest New');
  await expect(latest).toContainText('Owner accepts a 2-year lease; agent still needs the move-in date.');
  await expect(latest).toContainText('Next: Reply with the move-in date.');
  await expect(latest).toContainText("Your agent's read of the chat");
  await expect(page.locator('#detail')).not.toContainText('Agent asked for the move-in date.');
  await expect(page.locator('#detail')).not.toContainText('Tell the agent your move-in date.');
  await page.locator('#detail-close').click();
  await expect(busy.locator('.enq-new')).toHaveCount(0);
  await expect(page.locator('#enquiries-count')).toHaveText('2');
  await page.reload();
  await expect(page.locator('#enquiries-count')).toHaveText('2');
  await expect(page.locator('.enq-section').filter({ hasText: 'In progress' })).toContainText('Busy House');
});

test('a closed enquiry moves to the collapsed Ended section, and Watch again restores it', async ({ page }, testInfo) => {
  await page.goto('/#/chats');
  await expect(page).toHaveURL(/#\/enquiries$/);
  await expect(unit(page, 'Follow-up House')).toContainText('the owner declined');
  const id = await review(page, 'Follow-up House', 'declined', 'Owner declined this enquiry.');
  await page.reload();
  const row = unit(page, 'Follow-up House');
  await expect(row).toContainText('Enquiry declined');
  await expect(row).toContainText('Owner declined this enquiry.');
  await expect(row).toContainText('Enquiry ended');
  await row.locator('.enq-name').click();
  const latest = page.locator('#detail .latest');
  await expect(latest).toHaveCount(1);
  await expect(latest.locator('.decision')).toHaveText('Enquiry declined');
  await expect(latest).toContainText('Owner declined this enquiry.');
  await page.locator('#detail-close').click();
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.locator('#enquiries-count')).toBeHidden();
  const ended = page.locator('details.enq-ended');
  await expect(ended).not.toHaveAttribute('open');
  await expect(ended.locator('summary')).toContainText('Ended · 1');
  await expect(row).toBeHidden();
  await ended.locator('summary').click();
  await expect(row).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('enquiries.png'), fullPage: true });
  await row.getByRole('button', { name: 'Watch again' }).click();
  await expect(page.locator('#toast')).toContainText('Watching: Follow-up House');
  const after = await (await page.request.get('/api/state')).json();
  expect(after.listings.find(l => l.id === id).status).toBe('shortlisted');
  await row.locator('.enq-name').click();
  await expect(page.locator('#detail .latest')).toContainText('Owner declined this enquiry.');
  await expect(page.locator('#detail .latest .decision')).toHaveCount(0);
  await page.locator('#detail-close').click();
  const stale = await (await page.request.get(`/api/listings/${id}/follow-up`)).json();
  const message = stale.messages.at(-1);
  const replay = await page.request.put(`/api/listings/${id}/summary`, { data: { token: stale.token, outcome: 'declined', summary: { text: 'Old refusal again' }, evidence: { chat_jid: message.chat_jid, msg_id: message.msg_id } } });
  expect(replay.status()).toBe(409);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a cancelled viewing leaves Upcoming viewings and the header count', async ({ page }) => {
  await page.goto('/#/viewings');
  await expect(page).toHaveURL(/#\/enquiries$/);
  const row = unit(page, 'Cancelled Viewing House');
  await expect(row.locator('.enq-viewing')).toContainText('Viewing');
  await row.locator('.enq-name').click();
  const latest = page.locator('#detail .latest');
  await expect(latest).toContainText('The agent confirmed the unit is available');
  await expect(latest.locator('.latest-reply')).toContainText('Agent, since then');
  await expect(latest.locator('.latest-reply')).toContainText('Sorry, the viewing has been cancelled.');
  await page.locator('#detail-close').click();
  await expect(page.locator('#counts')).toContainText('1 upcoming viewing');
  await review(page, 'Cancelled Viewing House', 'viewing_cancelled', 'Viewing cancelled; waiting for another time.');
  await page.reload();
  await expect(row).toContainText('Viewing cancelled');
  await expect(row.locator('.enq-viewing')).toHaveCount(0);
  await expect(page.locator('#counts')).toContainText('0 upcoming viewings');
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.locator('.enq-section').filter({ hasText: 'Upcoming viewings' })).toHaveCount(0);
});

test("a home's sheet can drop its chat as not an agent", async ({ page }) => {
  await page.goto('/#/enquiries');
  await unit(page, 'Busy House').locator('.enq-name').click();
  const sheet = page.locator('#detail');
  await expect(sheet.locator('.thread')).toContainText('Owner can also do a 2-year lease.');
  await sheet.getByRole('button', { name: 'Not an agent' }).click();
  await sheet.getByRole('button', { name: 'Click again: delete and block' }).click();
  await expect(sheet.locator('.thread')).toContainText('No messages.');
  await expect(sheet.getByRole('button', { name: 'Not an agent' })).toHaveCount(0);
});

test('blur mode hides names, agents and chat text on Enquiries', async ({ page }) => {
  await page.goto('/?blur=1#/enquiries');
  const row = unit(page, 'Busy House');
  for (const part of ['.enq-name', '.enq-agent', '.enq-text']) {
    await expect(row.locator(part), part).toHaveCSS('filter', /blur/);
  }
});

test('the plain-language brief becomes portal filters, with stale-plan protection', async ({ page }) => {
  await page.goto('/#/searches');
  await page.getByLabel('What would make a home work for you?').fill('Whole studio or 1BR in D03, max S$3500.');
  await page.getByRole('button', { name: 'Send to sourcing agent' }).click();
  await expect(page.locator('#search-brief-status')).toContainText('Waiting for the next agent run');
  const state = await (await page.request.get('/api/state')).json();
  const plan = {
    projectVersion: state.projectVersion, revision: state.project.searchBrief.revision,
    filters: { minPrice: 2000, maxPrice: 3500, bedrooms: [0, 1], districts: ['D03'], wholeUnit: true },
    project: { criteria: state.project.criteria.map(c => c.type === 'commute' ? { ...c, departAt: '09:00' } : c) },
    sites: ['propertyguru', '99co'], pages: 2, explanation: 'Whole studio or 1BR in D03, within S$3500. Commute stays in scoring.',
  };
  const route = `/api/projects/${state.project.id}/search-plan`;
  expect((await page.request.put(route, { data: plan })).ok()).toBe(true);
  await page.reload();
  await expect(page.locator('#search-brief-status')).toContainText('Applied to searches');
  await expect(page.locator('#template-form input[name=maxPrice]')).toHaveValue('3500');
  await expect(page.locator('#template-form input[name=bed][value="2"]')).not.toBeChecked();
  expect((await page.request.put(route, { data: plan })).status()).toBe(409);
  const updated = await (await page.request.get('/api/state')).json();
  expect(updated.listings.every(l => l.needsMaps && l.enrichment === null)).toBe(true);
});
