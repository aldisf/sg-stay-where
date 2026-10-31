import { test, expect } from './fixtures.js';

test('search, reset filters and sort keep the list and map in sync', async ({ page, isMobile }) => {
  await page.goto('/#/listings');
  const items = page.locator('#side-list .item');
  await expect(items).toHaveCount(6);
  if (isMobile) await page.locator('#filter-options summary').click();
  await page.getByRole('searchbox', { name: 'Search listings' }).fill('queenstown');
  await expect(items).toHaveCount(1);
  await expect(items).toContainText('Queenstown Heights');
  await expect(page.locator('.pin')).toHaveCount(1);
  await expect(page.locator('#filter-note')).toHaveText('1 of 6 shown');
  await page.getByRole('searchbox', { name: 'Search listings' }).fill('no such building');
  await expect(page.locator('#side-list')).toContainText('No listings match');
  await expect(page.locator('#active-filters')).toHaveText('· 1 on');
  await page.getByText('No co-living').click();
  await expect(page.locator('#active-filters')).toHaveText('· 2 on');
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await expect(items).toHaveCount(6);
  await expect(page.locator('#filter-coliving')).toBeChecked();
  await expect(page.locator('#active-filters')).toHaveText('');
  await expect(page.getByRole('button', { name: 'Reset filters' })).toBeHidden();
  await page.getByLabel('Sort', { exact: true }).selectOption('price');
  await expect(items.first()).toContainText('Outram Hill');
  await page.getByLabel('Status', { exact: true }).selectOption('*');
  await expect(page.locator('#side-list')).not.toContainText('Bukit Merah View');
  await page.getByLabel('Status', { exact: true }).selectOption('rejected');
  await expect(items).toHaveCount(1);
  await expect(items).toContainText('Bukit Merah View');
  await page.getByLabel('Status', { exact: true }).selectOption('applied');
  await expect(page.locator('#side-list')).toContainText('No listings are at “Applied / offer”.');
});

test('details and photo dialogs contain focus and restore history', async ({ page }) => {
  await page.goto('/#/listings');
  const opener = page.getByRole('button', { name: 'Queenstown Heights', exact: true });
  await opener.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Queenstown Heights', exact: true });
  await expect(sheet).toBeVisible();
  await expect(page.locator('#detail-close')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => !!document.activeElement.closest('#detail'))).toBe(true);
  await page.getByRole('link', { name: 'Open full screen' }).click();
  await expect(page.getByRole('dialog', { name: 'Image viewer' })).toBeVisible();
  await page.getByRole('button', { name: 'Next image' }).click();
  await expect(page.locator('#lb-caption')).toContainText('2 / 3');
  await page.keyboard.press('Escape');
  await expect(page.locator('#lightbox')).not.toBeVisible();
  await expect(sheet).toBeVisible();
  await page.getByRole('textbox', { name: 'Listing notes' }).fill('Ask about the afternoon sun.');
  await page.getByRole('textbox', { name: 'Listing notes' }).press('Tab');
  await page.keyboard.press('Escape');
  await expect(sheet).not.toBeVisible();
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(page.getByRole('textbox', { name: 'Listing notes' })).toHaveValue('Ask about the afternoon sun.');
  await page.goBack();
  await expect(page.locator('#detail')).not.toBeVisible();
  await page.goForward();
  await expect(sheet).toBeVisible();
});

test('a slow detail request cannot reopen a dismissed sheet', async ({ page }) => {
  await page.goto('/#/listings');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/listings/*/messages', async route => { await held; await route.continue(); });
  await page.getByRole('button', { name: 'Queenstown Heights', exact: true }).click();
  await expect(page.locator('#detail')).toContainText('Loading listing');
  await page.locator('#detail-close').click();
  await expect(page.locator('#detail')).not.toBeVisible();
  const response = page.waitForResponse(/\/messages$/);
  release();
  await response;
  await expect(page.locator('#detail')).not.toBeVisible();
  await expect(page).toHaveURL(/#\/listings$/);
});

test('connection failures offer recovery without discarding the app', async ({ page }) => {
  await page.route('**/api/state*', route => route.fulfill({ status: 503, json: { error: 'Offline' } }), { times: 1 });
  await page.goto('/#/review');
  await expect(page.locator('#connection-status')).toContainText('Could not connect');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.swipe-card.top')).toBeVisible();
  await expect(page.locator('#connection-status')).not.toBeVisible();
});

test('a rejected decision restores the card even if refresh is offline', async ({ page }) => {
  await page.goto('/#/review');
  const card = page.locator('.swipe-card.top');
  await expect(card).toBeVisible();
  const id = await card.getAttribute('data-id');
  await page.route('**/api/listings/*', route => route.fulfill({ status: 503, json: { error: 'Try again later' } }));
  await page.route('**/api/state*', route => route.fulfill({ status: 503, json: { error: 'Offline' } }));
  await page.getByRole('button', { name: 'Interested', exact: true }).click();
  await page.getByRole('dialog', { name: 'Message the agent?' }).getByRole('button', { name: 'Just watch' }).click();
  await expect(page.locator('#toast')).toContainText('Not saved: Try again later');
  await expect(card).toHaveAttribute('data-id', id);
  await expect(page.locator('#connection-status')).toContainText('Updates paused');
});

test('detail actions keep Undo reachable inside the modal', async ({ page }) => {
  await page.goto('/#/listings');
  await page.getByRole('button', { name: 'Queenstown Heights', exact: true }).click();
  await page.getByRole('button', { name: 'Same flat as…', exact: true }).click();
  await expect(page.locator('.dup-row').first()).toBeVisible();
  await page.locator('.dup-row').first().getByRole('button', { name: 'Same flat', exact: true }).click();
  await expect(page.locator('#detail #toast')).toContainText('Merged into');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Split again: two listings.');
});

test('refresh preserves map markers and leaves hidden views unrendered', async ({ page }) => {
  await page.goto('/#/review');
  await expect(page.locator('.pin').first()).toBeVisible();
  await Promise.all([
    page.waitForResponse('**/api/state*'),
    page.evaluate(() => {
      window.savedPins = [...document.querySelectorAll('.pin')];
      document.dispatchEvent(new Event('visibilitychange'));
    }),
  ]);
  await expect.poll(() => page.evaluate(() => window.savedPins.every(pin => pin.isConnected))).toBe(true);
  await expect(page.locator('#side-list .item')).toHaveCount(0);
  await expect(page.locator('#searches > li')).toHaveCount(0);
  await page.getByRole('button', { name: 'Watching', exact: true }).click();
  await expect(page.locator('#side-list .item')).toHaveCount(6);
});

test('searches save and new projects stay separate', async ({ page }) => {
  await page.goto('/#/searches');
  const toggle = page.locator('[data-toggle-search]').first();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).toBeEnabled();
  await page.reload();
  await expect(toggle).not.toBeChecked();
  await page.locator('#project-button').click();
  await page.getByRole('menuitem', { name: 'New project…' }).click();
  const dialog = page.locator('#new-project');
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill('Next home');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('#project-title')).toHaveText('Next home');
  await page.getByRole('button', { name: /^Review/ }).click();
  await expect(page.locator('#deck')).toContainText("You're all caught up");
  await page.locator('#project-button').click();
  await page.getByRole('menuitem', { name: /2026 Rent/ }).click();
  await expect(page.locator('.swipe-card.top')).toBeVisible();
});

test('map pins stay on their location when hovered or focused', async ({ page, isMobile }) => {
  test.skip(isMobile, 'hover needs a mouse');
  await page.goto('/#/watching');
  await expect(page.locator('.pin').first()).toBeVisible();
  const offsets = () => page.evaluate(() => [...document.querySelectorAll('.pin')].map(el => {
    const r = el.getBoundingClientRect();
    const x = Number(el.style.transform.match(/translate\((-?[\d.]+)px/)[1]);
    return Math.abs(r.x + r.width / 2 - x);
  }));
  for (const offset of await offsets()) expect(offset).toBeLessThan(1);
  for (const pin of await page.locator('.pin').all()) {
    await pin.hover();
    for (const offset of await offsets()) expect(offset).toBeLessThan(1);
  }
});

test('the Review badge and header count the listings the deck will show with the current filters', async ({ page, isMobile }) => {
  const state = await (await page.request.get('/api/state')).json();
  const review = state.listings.filter(l => l.status === 'new' && !l.merged_into && !l.needsDetails && !l.needsMaps);
  await page.request.patch(`/api/listings/${review[0].id}`, { data: { price: 9900 } });
  await page.goto('/#/review');
  await expect(page.locator('#review-count')).toHaveText(String(review.length));
  if (isMobile) await page.locator('#filter-options summary').click();
  await page.getByText('≤ S$3.5k').click();
  const shown = review.length - 1;
  await expect(page.locator('#review-count')).toHaveText(String(shown));
  await expect(page.locator('#filter-note')).toHaveText(`${shown} of ${review.length} to review`);
  if (!isMobile) await expect(page.locator('#counts')).toHaveText(new RegExp(`^${shown} to review · 6 watching`));
  const seen = new Set();
  for (let i = 0; i < shown; i++) {
    const card = page.locator('.swipe-card.top');
    seen.add(await card.getAttribute('data-id'));
    await page.locator('.deck-actions').getByRole('button', { name: 'Not interested', exact: true }).click();
    await expect(page.locator('#review-count')).toHaveText(shown - i - 1 ? String(shown - i - 1) : '');
  }
  expect(seen.size).toBe(shown);
  expect(seen.has(String(review[0].id))).toBe(false);
  await expect(page.locator('#deck')).toContainText('No listings match these filters.');
  await expect(page.locator('#deck')).toContainText('1 listing is waiting.');
  await expect(page.locator('#review-count')).toBeHidden();
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await expect(page.locator('#review-count')).toHaveText('1');
  await expect(page.locator('.swipe-card.top')).toHaveAttribute('data-id', String(review[0].id));
});

test('toggling a search from the keyboard keeps focus on its switch', async ({ page }) => {
  await page.goto('/#/searches');
  const toggle = page.locator('[data-toggle-search]').first();
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeFocused();
});

test('a map pin drops its highlight when the mouse leaves the Watching list', async ({ page, isMobile }) => {
  test.skip(isMobile, 'hover needs a mouse');
  await page.goto('/#/listings');
  await page.locator('#side-list .item').first().hover();
  await expect(page.locator('.pin.hover')).toHaveCount(1);
  await page.mouse.move(300, 450);
  await expect(page.locator('.pin.hover')).toHaveCount(0);
});

test('switching to a project with nothing to show resets the map to Singapore', async ({ page }) => {
  await page.addInitScript(() => {
    let lib;
    Object.defineProperty(window, 'maplibregl', { configurable: true, get: () => lib, set: value => {
      lib = value;
      const Map = value.Map;
      value.Map = class extends Map { constructor(options) { super(options); window.testMap = this; } };
    } });
  });
  const view = () => page.evaluate(() => {
    const { lng, lat } = window.testMap.getCenter();
    return [Math.round(window.testMap.getZoom() * 10) / 10, Math.round(lng * 100) / 100, Math.round(lat * 100) / 100];
  });
  const singapore = [11.4, 103.82, 1.3];
  await page.goto('/#/listings');
  await expect(page.locator('.pin').first()).toBeVisible();
  await expect.poll(view).not.toEqual(singapore);
  await page.locator('#project-button').click();
  await page.getByRole('menuitem', { name: 'New project…' }).click();
  const dialog = page.locator('#new-project');
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill('Empty home');
  await dialog.getByRole('checkbox', { name: /Copy criteria/ }).uncheck();
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('#project-title')).toHaveText('Empty home');
  await page.getByRole('button', { name: 'Watching', exact: true }).click();
  await expect.poll(view).toEqual(singapore);
});

test('renaming a project saves when the field loses focus and Escape cancels', async ({ page }) => {
  await page.goto('/#/project');
  await page.locator('#project-rename').click();
  await page.getByRole('textbox', { name: 'Project title' }).fill('Renamed home');
  await page.locator('.project-head').locator('..').click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole('textbox', { name: 'Project title' })).toHaveCount(0);
  await expect(page.locator('#project-title')).toHaveText('Renamed home');
  await page.locator('#project-rename').click();
  await page.getByRole('textbox', { name: 'Project title' }).fill('Not this');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'Project title' })).toHaveCount(0);
  await expect(page.locator('#project-title')).toHaveText('Renamed home');
});

test('blur mode hides your own details on the Project tab', async ({ page }) => {
  await page.goto('/?blur=1#/project');
  const blurred = locator => expect(locator).toHaveCSS('filter', /blur/);
  for (const name of ['name', 'household', 'residency', 'lifestyle']) await blurred(page.locator(`#message-form input[name="${name}"]`));
  await blurred(page.locator('#message-preview'));
  await blurred(page.locator('#project-json'));
  for (const address of await page.locator('.criteria-list .private').all()) await blurred(address);
  await expect(page.locator('.criteria-list .private')).not.toHaveCount(0);
  await expect(page.locator('#message-form input[name="budget.max"]')).toHaveCSS('filter', 'none');
});

test('a pasted link with nothing known reads plainly and is not scored', async ({ page, isMobile }) => {
  await page.goto('/#/listings');
  await page.locator('#add-url').fill('https://www.propertyguru.com.sg/listing/for-rent-some-condo-12345678');
  await page.locator('#add-form button[type=submit]').click();
  const sheet = page.locator('#detail');
  await expect(sheet.locator('.eyebrow').first()).toHaveText('added just now');
  await expect(sheet).toContainText('Not scored yet.');
  await expect(sheet.locator('table.breakdown')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#map-caption')).toHaveText("6 listings you're watching");
  await page.locator('.tabs').getByRole('button', { name: 'Searches' }).click();
  await expect(page.locator('#map-caption')).toHaveText('6 followed listings on the map');
  if (!isMobile) await expect(page.locator('#counts')).toHaveText('6 to review · 7 watching · 1 upcoming viewing');
});

test('a link to a listing that is not here falls back to the tab address', async ({ page }) => {
  await page.goto('/#/listing-9999');
  await expect(page.locator('#toast')).toContainText("That listing isn't in this project.");
  await expect(page).not.toHaveURL(/listing-9999/);
  await expect(page.locator('#detail')).not.toBeVisible();
  await page.evaluate(() => { location.hash = '#/listing-9998'; });
  await expect(page.locator('#toast')).toContainText("That listing isn't in this project.");
  await expect(page).not.toHaveURL(/listing-9998/);
});

test('a note shows when the listing is reopened before its save returns', async ({ page }) => {
  await page.goto('/#/listings');
  await page.route('**/api/listings/*', async (route) => {
    if (route.request().method() === 'PATCH') await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  const opener = page.getByRole('button', { name: 'Queenstown Heights', exact: true });
  await opener.click();
  const notes = page.getByRole('textbox', { name: 'Listing notes' });
  await notes.fill('Check the west sun.');
  await notes.press('Tab');
  await page.keyboard.press('Escape');
  await opener.click();
  await expect(notes).toHaveValue('Check the west sun.', { timeout: 1000 });
});

test('the map starts Detailed, switches to Simple, and the choice is remembered', async ({ page }) => {
  const styles = [];
  page.on('request', request => {
    const match = request.url().match(/^https:\/\/tiles\.openfreemap\.org\/styles\/(\w+)/);
    if (match) styles.push(match[1]);
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/#/listings');
  await expect(page.locator('.pin')).toHaveCount(6);
  const toggle = page.getByRole('button', { name: 'Detailed', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => styles).toEqual(['liberty']);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => styles).toEqual(['liberty', 'positron']);
  await expect(page.locator('.pin')).toHaveCount(6);
  await page.reload();
  await expect(page.locator('.pin')).toHaveCount(6);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => styles).toEqual(['liberty', 'positron', 'positron']);
  await page.locator('#theme').click();
  await page.locator('#theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => styles.at(-1)).toBe('dark');
  await toggle.click();
  await expect.poll(() => styles.at(-1)).toBe('liberty');
  await expect(page.locator('.pin')).toHaveCount(6);
});

test('Poll now starts a poll from the header and shows it running', async ({ page }) => {
  await page.goto('/#/review');
  const button = page.locator('#poll-now');
  await expect(button).toHaveText(/^Polled /);
  await button.click();
  await expect(page.locator('.toast')).toContainText('Poll started');
  await expect(button).toHaveText('Polling…');
  await expect(button).toBeDisabled();
});

test('moving between photos on the Review card does not replay its entrance', async ({ page }) => {
  await page.goto('/#/review');
  const card = page.locator('#deck .swipe-card.top');
  await expect(card).toBeVisible();
  await card.hover();
  await page.locator('#deck .dk-next').click();
  await expect(page.locator('#deck .photo-count')).toHaveText(/^2 \//);
  await expect(page.locator('#deck .swipe-card.top')).toHaveCSS('animation-name', 'none');
});

test('a buying project quotes whole prices, asks for financing and builds searches by link', async ({ page }) => {
  await page.goto('/#/searches');
  await page.locator('#project-button').click();
  await page.getByRole('menuitem', { name: /Parents' HDB/ }).click();
  await expect(page.locator('#project-title')).toHaveText("Parents' HDB");
  await expect(page.locator('#buy-searches-note')).toBeVisible();
  await expect(page.locator('#template-form')).toBeHidden();
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await expect(page.locator('#message-form legend').first()).toHaveText('Budget (S$)');
  await page.getByRole('textbox', { name: 'Financing' }).fill('HDB loan, HFE letter ready');
  await page.getByRole('textbox', { name: 'Timeline' }).fill('Within 6 months');
  await page.getByRole('textbox', { name: 'Timeline' }).press('Tab');
  await expect(page.locator('#message-preview')).toContainText('(S$758,000)');
  await expect(page.locator('#message-preview')).toContainText('Financing: HDB loan, HFE letter ready');
  await expect(page.locator('#message-preview')).not.toContainText('/month');
});

test('Review says what the intro profile is missing until it is complete', async ({ page }) => {
  await page.goto('/#/review');
  await expect(page.locator('.profile-note')).toHaveCount(0);
  await page.locator('#project-button').click();
  await page.getByRole('menuitem', { name: 'New project…' }).click();
  const dialog = page.locator('#new-project');
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill('Fresh start');
  await dialog.getByRole('checkbox', { name: /Copy criteria/ }).uncheck();
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('#project-title')).toHaveText('Fresh start');
  await page.goto('/#/review');
  const note = page.locator('.profile-note');
  await expect(note).toContainText('Your intro is missing first name, household, residency, move-in, lease');
  await note.getByRole('link', { name: 'Complete your profile' }).click();
  await expect(page).toHaveURL(/#\/project$/);
});
