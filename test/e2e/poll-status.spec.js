import { test, expect } from './fixtures.js';

for (const scenario of ['all blocked', 'partly blocked', 'no matches']) test(`poll header distinguishes ${scenario} from a successful search`, async ({ page }) => {
  await page.route('**/api/state*', async route => {
    const response = await route.fetch();
    const json = await response.json();
    const searches = [
      { id: 'one', title: 'First search', active: true },
      { id: 'two', title: 'Second search', active: true },
      { id: 'off', title: 'Disabled search', active: false }
    ];
    const searchLast = Object.fromEntries(searches.map((s, i) => [s.title, { added: 0, seen: 0, note: scenario === 'all blocked' || (scenario === 'partly blocked' && i === 0) ? 'skipped: browser unavailable' : null }]));
    await route.fulfill({ response, json: { ...json, project: { ...json.project, searches }, searchLast, poll: { running: false, scheduled: true, lastAt: new Date().toISOString() } } });
  });
  await page.goto('/#/review');
  const button = page.locator('#poll-now');
  if (scenario === 'all blocked') {
    await expect(button).toContainText('Searches blocked');
    await expect(button).toHaveAttribute('title', /First search: skipped: browser unavailable/);
    await expect(button).toHaveClass(/stalled/);
  } else if (scenario === 'partly blocked') {
    await expect(button).toContainText('1 skipped');
    await expect(button).not.toContainText('Searches blocked');
  } else {
    await expect(button).toContainText('Polled');
    await expect(button).not.toContainText('blocked');
    await expect(button).not.toContainText('skipped');
  }
});
