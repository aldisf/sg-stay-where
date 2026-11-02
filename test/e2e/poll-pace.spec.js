import { test, expect } from './fixtures.js';

test('the Searches tab saves listing pages per poll and page loads per minute', async ({ page }) => {
  await page.goto('/#/searches');
  const listings = page.getByRole('spinbutton', { name: 'Listing pages opened per poll' });
  const pace = page.getByRole('spinbutton', { name: 'Page loads per minute, per site' });
  await expect(listings).toHaveValue('40');
  await expect(pace).toHaveValue('10');
  await pace.fill('8');
  await pace.press('Tab');
  await expect.poll(async () => (await (await page.request.get('/api/state')).json()).project.poll).toEqual({ listings: 40, rpm: 8 });
  await listings.fill('60');
  await listings.press('Tab');
  await expect.poll(async () => (await (await page.request.get('/api/state')).json()).project.poll).toEqual({ listings: 60, rpm: 8 });
  await page.reload();
  await expect(pace).toHaveValue('8');
  await expect(listings).toHaveValue('60');
});
