import { test, expect } from './fixtures.js';

test('review, watch, undo and hide persist through a reload', async ({ page }) => {
  await page.goto('/#/review');
  const card = page.locator('.swipe-card.top');
  await expect(card).toBeVisible();
  const name = await card.locator('.item-name').innerText();
  await page.getByRole('button', { name: 'Interested', exact: true }).click();
  await page.getByRole('dialog', { name: 'Message the agent?' }).getByRole('button', { name: 'Just watch' }).click();
  await expect(page.locator('#toast')).toContainText(`Watching: ${name}`);
  await page.getByRole('button', { name: 'Watching', exact: true }).click();
  await expect(page.locator('#side-list')).toContainText(name);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Back to review');
  await page.getByRole('button', { name: /^Review/ }).click();
  await expect(card.locator('.item-name')).toHaveText(name);
  await page.locator('.deck-actions').getByRole('button', { name: 'Not interested', exact: true }).click();
  await expect(page.locator('#toast')).toContainText(`Hidden: ${name}`);
  await page.reload();
  await expect(card).toBeVisible();
  await expect(page.locator('#deck')).not.toContainText(name);
});

test('captures review and watching layouts', async ({ page }, testInfo) => {
  await page.goto('/#/review');
  await expect(page.locator('.swipe-card.top')).toBeVisible();
  await expect(page.locator('.pin').first()).toBeVisible();
  if (process.env.SSW_LIVE_MAP) await page.waitForLoadState('networkidle');
  await page.screenshot({ path: testInfo.outputPath('review-viewport.png') });
  await page.screenshot({ path: testInfo.outputPath('review.png'), fullPage: true });
  await page.getByRole('button', { name: 'Watching', exact: true }).click();
  await expect(page.locator('#side-list .item').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('watching.png'), fullPage: true });
});

test('narrow phones support dark mode, reduced motion and every tab without overflow', async ({ page, isMobile }, testInfo) => {
  test.skip(!isMobile, 'phone layout');
  await page.setViewportSize({ width: 360, height: 780 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/#/review');
  await expect(page.locator('.swipe-card.top')).toBeVisible();
  for (const name of ['Watching', 'Enquiries', 'Searches', 'Project', 'Review']) {
    await page.locator('.tabs').getByRole('button', { name: new RegExp(`^${name}`) }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name).toBe(true);
  }
  await page.locator('.deck-actions .more').click();
  await expect(page.locator('#detail .detail-title')).toBeVisible();
  expect(await page.locator('#detail').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('narrow-dark-detail.png') });
});

test('swiping right shows the intro before anything is sent, and Cancel puts the card back', async ({ page }) => {
  await page.goto('/#/review');
  const card = page.locator('.swipe-card.top');
  const id = await card.getAttribute('data-id');
  const sends = [];
  page.on('request', request => { if (request.url().endsWith('/send')) sends.push(request.postDataJSON()); });
  await page.keyboard.press('ArrowRight');
  const dialog = page.getByRole('dialog', { name: 'Message the agent?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Message to agent' })).toHaveValue(/I'm interested in your listing/);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(card).toHaveAttribute('data-id', id);
  await expect(card).toHaveCSS('opacity', '1');

  await page.keyboard.press('ArrowRight');
  const text = dialog.getByRole('textbox', { name: 'Message to agent' });
  await text.fill('Hi, is this still available?');
  await expect(dialog.getByRole('link', { name: 'Open in WhatsApp' })).toHaveAttribute('href', /^https:\/\/wa\.me\/\d+\?text=Hi%2C%20is%20this%20still%20available%3F$/);
  expect(sends).toEqual([]);
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(dialog).toContainText('Not sent: demo data: sending is switched off');
  expect(sends).toEqual([{ text: 'Hi, is this still available?' }]);
});

test('without WhatsApp, Copy message puts the edited intro on the clipboard and watches the home', async ({ page, context, browserName }) => {
  const readable = browserName === 'chromium';
  if (readable) await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/api/state*', async route => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, whatsapp: { state: 'unlinked', linked: false } } });
  });
  const sends = [];
  page.on('request', request => { if (request.url().endsWith('/send')) sends.push(request.url()); });
  await page.goto('/#/review');
  const card = page.locator('.swipe-card.top');
  const id = Number(await card.getAttribute('data-id'));
  const name = await card.locator('.item-name').innerText();
  await page.getByRole('button', { name: 'Interested', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Message the agent?' });
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeHidden();
  await expect(dialog).toContainText('opens the chat (the app, or WhatsApp Web) with this message ready');
  await expect(dialog.getByRole('link', { name: 'Open in WhatsApp' })).not.toHaveClass(/ghost/);
  await expect(dialog.getByRole('button', { name: 'Copy message' })).toHaveClass(/ghost/);
  await dialog.getByRole('textbox', { name: 'Message to agent' }).fill('Hi, is this still available?');
  await dialog.getByRole('button', { name: 'Copy message' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toast')).toContainText(`Message copied · Watching: ${name}`);
  if (readable) expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Hi, is this still available?');
  const state = await (await page.request.get('/api/state')).json();
  expect(state.listings.find(l => l.id === id).status).toBe('shortlisted');
  expect(sends).toEqual([]);
});

test('watching a home does not invent a chat reading', async ({ page }) => {
  await page.goto('/#/review');
  const id = await page.locator('.swipe-card.top').getAttribute('data-id');
  await page.getByRole('button', { name: 'Interested', exact: true }).click();
  await page.getByRole('dialog', { name: 'Message the agent?' }).getByRole('button', { name: 'Just watch' }).click();
  await page.getByRole('button', { name: 'Watching', exact: true }).click();
  const row = page.locator(`#side-list .item[data-id="${id}"]`);
  await expect(row.locator('.lead')).toHaveText('Not contacted');
  await row.locator('.item-open').click();
  await expect(page.locator('#detail-body')).toContainText('No chat yet.');
  await expect(page.locator('#detail-body')).not.toContainText("Your agent's read of the chat");
});

test('arrow keys decide in Review right after clicking its tab', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard');
  await page.goto('/#/listings');
  await page.getByRole('button', { name: /^Review/ }).click();
  const card = page.locator('.swipe-card.top');
  const name = await card.locator('.item-name').innerText();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#toast')).toContainText(`Hidden: ${name}`);
});

test('without WhatsApp, Open in WhatsApp shows even before the intro profile is complete', async ({ page }) => {
  await page.route('**/api/state*', async route => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, whatsapp: { state: 'disabled', linked: false }, project: { ...json.project, message: {} } } });
  });
  await page.goto('/#/review');
  await page.getByRole('button', { name: 'Interested', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Message the agent?' });
  await expect(dialog).toContainText("Your intro isn't set up yet");
  await expect(dialog.getByRole('link', { name: 'Open in WhatsApp' })).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Open in WhatsApp' })).toHaveAttribute('href', /^https:\/\/wa\.me\/\d+\?text=/);
});
