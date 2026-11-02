import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../browser/99co.js', import.meta.url), 'utf8');
for (const deal of ['rent', 'sale']) test(`99.co ${deal} details use postal district instead of geographic region`, () => {
  const product = { '@type': 'Product', name: 'Twin VEW', address: { addressRegion: 'West Region', addressLocality: '93 West Coast Vale 126756, Singapore' }, offers: { price: 3800 } };
  const document = {
    body: { innerText: 'Twin VEW' }, scripts: [],
    querySelector: () => ({ textContent: 'Twin VEW' }),
    querySelectorAll: selector => selector === 'script[type="application/ld+json"]' ? [{ textContent: JSON.stringify(product) }] : []
  };
  const result = runInNewContext(`${source}; n99Extract()`, { document, location: { origin: 'https://www.99.co', pathname: `/singapore/${deal}/property/twin-vew-condo-abc123` }, URL });
  assert.equal(result.listings[0].postal, '126756');
  assert.equal(result.listings[0].district, 'D05');
});
