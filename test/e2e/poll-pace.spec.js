import { test, expect } from './fixtures.js';

test('Browsing pace saves RPM and removes the legacy count cap', async ({ page }) => {
  await page.goto('/#/searches');
  const pace = page.getByRole('spinbutton', { name: 'Page navigations per minute, per site' });
  await expect(pace).toHaveValue('10');
  await pace.fill('8');
  await pace.press('Tab');
  await expect.poll(async () => (await (await page.request.get('/api/state')).json()).project.poll).toEqual({ rpm: 8 });
  await page.reload();
  await expect(pace).toHaveValue('8');
  await expect(page.locator('#poll-form')).toContainText('no listing-count cap');
});
