import { test, expect } from './fixtures.js';

const tabBoxes = page => page.locator('.tabs button').evaluateAll(buttons => buttons.map(b => {
  const r = b.getBoundingClientRect();
  return [b.textContent.trim(), Math.round(r.left), Math.round(r.right)];
}));

for (const width of [1280, 1440]) {
  test(`every tab is visible at ${width}px and stays put when the counts arrive`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop panel');
    await page.setViewportSize({ width, height: 720 });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/state*', async route => { await held; await route.continue(); });
    await page.goto('/#/listings');
    await expect(page.locator('.tabs button')).toHaveCount(5);
    const before = await tabBoxes(page);
    release();
    await expect(page.locator('#review-count')).toHaveText('6');
    const after = await tabBoxes(page);
    expect(after.map(([, l, r]) => [l, r])).toEqual(before.map(([, l, r]) => [l, r]));
    const strip = await page.locator('.tabs').boundingBox();
    for (const [name, left, right] of after) {
      expect(left, name).toBeGreaterThanOrEqual(Math.floor(strip.x));
      expect(right, name).toBeLessThanOrEqual(Math.ceil(strip.x + strip.width));
    }
  });
}

test('the sheet close button never covers the score column', async ({ page, isMobile }) => {
  test.skip(isMobile, 'phones give the close button its own bar above the content');
  await page.goto('/#/listings');
  await page.locator('#side-list .item-open').first().click();
  const sheet = page.locator('#detail');
  await expect(sheet.locator('table.breakdown')).toBeVisible();
  for (const row of await sheet.locator('table.breakdown tr').all()) {
    await row.evaluate(el => {
      const close = document.querySelector('#detail-close').getBoundingClientRect();
      const box = el.getBoundingClientRect();
      el.closest('dialog').scrollTop += box.top + box.height / 2 - (close.top + close.height / 2);
    });
    const covered = await row.evaluate(el => {
      const cell = el.lastElementChild.getBoundingClientRect();
      const hit = document.elementFromPoint(cell.right - 4, cell.top + cell.height / 2);
      return !el.contains(hit);
    });
    expect(covered, await row.innerText()).toBe(false);
  }
});

test('the review card shows its price and name above the decision buttons on first view', async ({ page, isMobile }) => {
  await page.setViewportSize(isMobile ? { width: 390, height: 844 } : { width: 1280, height: 720 });
  await page.goto('/#/review');
  const card = page.locator('.swipe-card.top');
  await expect(card).toBeVisible();
  const buttons = await page.locator('.deck-actions').boundingBox();
  for (const part of ['.price', '.item-name']) {
    const box = await card.locator(part).first().boundingBox();
    expect(box.y, part).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, part).toBeLessThanOrEqual(buttons.y);
  }
});
