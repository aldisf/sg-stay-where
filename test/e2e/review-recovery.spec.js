import { test, expect } from './fixtures.js';

test('an empty filtered Review can show completed cards without changing decisions', async ({ page }) => {
  await page.route('**/api/state*', async route => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, listings: json.listings.map(l => ({ ...l, station: { ok: false } })) } });
  });
  await page.goto('/#/review');
  await expect(page.locator('#deck')).toContainText('hidden by your filters');
  const before = (await (await page.request.get('/api/state')).json()).listings.map(l => [l.id, l.status]);
  await page.getByRole('button', { name: 'Show all completed listings', exact: true }).click();
  await expect(page.locator('.swipe-card.top')).toBeVisible();
  await expect(page.locator('#filter-station')).not.toBeChecked();
  await page.reload();
  await expect(page.locator('.swipe-card.top')).toBeVisible();
  expect((await (await page.request.get('/api/state')).json()).listings.map(l => [l.id, l.status])).toEqual(before);
});

test('unfinished listings are described as waiting when no poll is running', async ({ page }) => {
  await page.route('**/api/state*', async route => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, poll: { ...json.poll, running: false }, listings: json.listings.map(l => ({ ...l, needsMaps: true })) } });
  });
  await page.goto('/#/review');
  await expect(page.locator('#deck')).toContainText('Listings are waiting for checks.');
  await expect(page.locator('#deck')).not.toContainText('Listings are being checked.');
});
