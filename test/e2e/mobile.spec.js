import { test, expect } from './fixtures.js';

async function pointerSwipe(page, dx, dy = 0, cancel = false) {
  const photo = page.locator('.swipe-card.top .sc-photo');
  await photo.scrollIntoViewIfNeeded();
  const box = await photo.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const event = { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true };
  await photo.dispatchEvent('pointerdown', event);
  await photo.dispatchEvent('pointermove', { ...event, clientX: x + dx, clientY: y + dy });
  await photo.dispatchEvent(cancel ? 'pointercancel' : 'pointerup', { ...event, clientX: x + dx, clientY: y + dy });
}

test('card gestures decide once; vertical, short and cancelled gestures do not', async ({ page }) => {
  await page.addInitScript(() => {
    window.vibrations = [];
    Object.defineProperty(navigator, 'vibrate', { value: duration => { window.vibrations.push(duration); return true; } });
  });
  await page.goto('/#/review');
  await expect(page.locator('.swipe-card.top')).toBeVisible();
  const name = await page.locator('.swipe-card.top .item-name').innerText();
  const id = await page.locator('.swipe-card.top').getAttribute('data-id');
  for (const [x, y, cancel] of [[0, 120, false], [25, 0, false], [180, 0, true]]) {
    await pointerSwipe(page, x, y, cancel);
    await expect(page.locator('.swipe-card.top')).toHaveAttribute('data-id', id);
    await expect(page).toHaveURL(/#\/review$/);
  }
  expect(await page.evaluate(() => window.vibrations)).toEqual([]);
  const writes = [];
  page.on('request', request => { if (request.method() === 'PATCH') writes.push(request.url()); });
  await pointerSwipe(page, 180);
  await page.getByRole('dialog', { name: 'Message the agent?' }).getByRole('button', { name: 'Just watch' }).click();
  await expect(page.locator('#toast')).toContainText(`Watching: ${name}`);
  expect(writes).toHaveLength(1);
  expect(await page.evaluate(() => window.vibrations)).toEqual([12]);
  await expect(page).toHaveURL(/#\/review$/);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.swipe-card.top')).toHaveAttribute('data-id', id);
  await pointerSwipe(page, -180);
  await expect(page.locator('#toast')).toContainText(`Hidden: ${name}`);
  expect(await page.evaluate(() => window.vibrations)).toEqual([12, 12]);
  await expect(page).toHaveURL(/#\/review$/);
});

test('toast label and long property name share a baseline without squeezing Undo', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/review');
  const card = page.locator('.swipe-card.top');
  await expect(card).toBeVisible();
  const id = await card.getAttribute('data-id');
  await page.request.patch(`/api/listings/${id}`, { data: { building: 'A very long property name near Commonwealth Crescent with extra details' } });
  await page.reload();
  await page.getByRole('button', { name: 'Not interested', exact: true }).click();
  await expect(page.locator('#toast')).toBeVisible();
  const geometry = await page.evaluate(() => {
    const label = document.querySelector('.toast-label').getBoundingClientRect();
    const name = document.querySelector('.toast-name').getBoundingClientRect();
    const undo = document.querySelector('#toast-undo').getBoundingClientRect();
    return { baseline: Math.abs(label.bottom - name.bottom), undo: undo.width, right: undo.right, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(geometry.baseline).toBeLessThan(1);
  expect(geometry.undo).toBeGreaterThan(55);
  expect(geometry.right).toBeLessThanOrEqual(320);
  expect(geometry.overflow).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('toast-alignment.png') });
});

test('mobile scroll keeps pins inside the map and behind dialogs', async ({ page, isMobile }, testInfo) => {
  test.skip(!isMobile, 'phone layout');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/review');
  await expect(page.locator('.pin.focus')).toBeVisible();
  const positions = () => page.evaluate(() => ({
    map: document.querySelector('.map-wrap').getBoundingClientRect().top,
    pin: document.querySelector('.pin.focus').getBoundingClientRect().top,
    scroll: window.scrollY,
  }));
  const before = await positions();
  await page.evaluate(() => window.scrollBy(0, 120));
  const after = await positions();
  expect(after.scroll).toBeGreaterThan(before.scroll);
  expect(Math.abs((after.pin - before.pin) - (after.map - before.map))).toBeLessThan(2);
  await page.locator('.tabs').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => {
    const tabs = document.querySelector('.tabs').getBoundingClientRect();
    const hit = document.elementFromPoint(tabs.left + 30, tabs.top + 25);
    return !!hit.closest('.tabs');
  })).toBe(true);
  await page.locator('.deck-actions .more').click();
  await expect(page.locator('#detail .detail-title')).toBeVisible();
  expect(await page.evaluate(() => !!document.elementFromPoint(80, 180).closest('#detail'))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('phone-detail.png') });
  await page.keyboard.press('Escape');
  await expect(page.locator('#detail')).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('real touch swipes preserve page history and vertical scrolling', async ({ page, browserName, isMobile, context }) => {
  test.skip(browserName !== 'chromium' || !isMobile, 'CDP touch input requires mobile Chromium');
  await page.goto('/#/listings');
  await page.getByRole('button', { name: /^Review/ }).click();
  const photo = page.locator('.swipe-card.top .sc-photo');
  await photo.scrollIntoViewIfNeeded();
  const session = await context.newCDPSession(page);
  const swipe = async (dx, dy) => {
    const box = await photo.boundingBox();
    const x = dx > 0 ? box.x + 65 : box.x + box.width - 65;
    const y = Math.min(box.y + box.height / 2, 500);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 10; i++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / 10, y: y + dy * i / 10 }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const name = await page.locator('.swipe-card.top .item-name').innerText();
  const scroll = await page.evaluate(() => window.scrollY);
  await swipe(0, -150);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scroll);
  await expect(page.locator('.swipe-card.top .item-name')).toHaveText(name);
  await photo.scrollIntoViewIfNeeded();
  await swipe(200, 0);
  await page.getByRole('dialog', { name: 'Message the agent?' }).getByRole('button', { name: 'Just watch' }).click();
  await expect(page.locator('#toast')).toContainText(`Watching: ${name}`);
  await expect(page).toHaveURL(/#\/review$/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/listings$/);
  await session.detach();
});

async function rowDrag(page, row, dx, { pause = 0 } = {}) {
  const box = await row.boundingBox();
  const x = box.x + box.width - 20;
  const y = box.y + box.height / 2;
  const event = { pointerId: 2, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true };
  await row.dispatchEvent('pointerdown', event);
  for (let i = 1; i <= 8; i++) await row.dispatchEvent('pointermove', { ...event, clientX: x + dx * i / 8 });
  if (pause) await page.waitForTimeout(pause);
  return () => row.dispatchEvent('pointerup', { ...event, clientX: x + dx });
}

const cardOffset = row => row.locator('.item-card').evaluate(el => getComputedStyle(el).transform);

test('Watching rows show their status and are removed only by a full swipe left', async ({ page, isMobile }) => {
  await page.goto('/#/listings');
  const contacted = page.locator('#side-list .item').filter({ hasText: 'Outram Hill' });
  await expect(contacted.locator('.pill')).toHaveText('Contacted');
  const row = page.locator('#side-list .item').filter({ hasText: 'Queenstown Heights' });
  await expect(row.locator('.pill')).toHaveText('Watching');
  await expect(row.locator('.hide-btn')).toHaveCount(0);
  await expect(row.getByRole('button')).toHaveText(['Queenstown Heights']);
  await row.scrollIntoViewIfNeeded();
  const patches = [];
  page.on('request', request => { if (request.method() === 'PATCH') patches.push(request.postDataJSON()); });
  const width = (await row.boundingBox()).width;

  let release = await rowDrag(page, row, -110);
  await expect(row.locator('.swipe-trash .ic')).toBeVisible();
  await expect(row.locator('.swipe-trash span')).toBeHidden();
  await release();
  await expect.poll(() => cardOffset(row)).toBe('none');
  await expect(row.locator('.swipe-trash')).toBeHidden();
  release = await rowDrag(page, row, -width * 0.6, { pause: 150 });
  await release();
  await expect.poll(() => cardOffset(row)).toBe('none');
  await page.waitForTimeout(500);
  expect(patches).toEqual([]);
  await expect(row).toBeVisible();

  if (isMobile) {
    release = await rowDrag(page, row, -width * 0.85);
    await expect(row).toHaveClass(/armed/);
    await expect(row.locator('.swipe-trash span')).toHaveText('Not interested');
    await release();
  } else {
    const box = await row.boundingBox();
    await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2, { steps: 12 });
    await expect(row).toHaveClass(/armed/);
    await page.mouse.up();
  }
  await expect(page.locator('#toast')).toContainText('Hidden: Queenstown Heights');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(patches).toEqual([{ status: 'rejected' }]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(row).toHaveCount(1);
  await expect(row.locator('.pill')).toHaveText('Watching');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await row.scrollIntoViewIfNeeded();
  release = await rowDrag(page, row, -width * 0.85);
  await release();
  await expect(page.locator('#toast')).toContainText('Hidden: Queenstown Heights');
  await expect(row).toHaveCount(0);
});

test('a fast fling past the trash zone removes a Watching row', async ({ page }) => {
  await page.goto('/#/listings');
  const row = page.locator('#side-list .item').filter({ hasText: 'Queenstown Heights' });
  await row.scrollIntoViewIfNeeded();
  // One synchronous burst: half the row's width within a few milliseconds.
  await row.evaluate(el => {
    const box = el.getBoundingClientRect();
    const x = box.right - 20;
    const y = box.top + box.height / 2;
    const fire = (type, clientX) => el.dispatchEvent(new PointerEvent(type, { pointerId: 3, pointerType: 'touch', isPrimary: true, clientX, clientY: y, bubbles: true }));
    fire('pointerdown', x);
    for (let i = 1; i <= 8; i++) fire('pointermove', x - box.width * 0.5 * i / 8);
    fire('pointerup', x - box.width * 0.5);
  });
  await expect(page.locator('#toast')).toContainText('Hidden: Queenstown Heights');
});
