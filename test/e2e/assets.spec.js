import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { test, expect } from './fixtures.js';

const get = (url, headers = {}) => new Promise((resolve, reject) => {
  http.get(url, { headers }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

test('static transfer budget, revalidation and private API headers', async ({ baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'HTTP behavior is independent of viewport');
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const raw = await get(`${baseURL}/vendor/maplibre-gl.mjs`);
    const gzip = await get(`${baseURL}/vendor/maplibre-gl.mjs`, { 'accept-encoding': 'gzip' });
    expect(raw.status).toBe(200);
    expect(gzip.status).toBe(200);
    expect(gzip.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gzip.body).equals(raw.body)).toBe(true);
    expect(gzip.body.length).toBeLessThan(raw.body.length * 0.4);
    const cached = await get(`${baseURL}/vendor/maplibre-gl.mjs`, { 'if-none-match': gzip.headers.etag });
    expect(cached.status).toBe(304);
    expect(cached.body.length).toBe(0);
    runs.push({ rawBytes: raw.body.length, gzipBytes: gzip.body.length, revalidatedBytes: cached.body.length });
  }
  const state = await get(`${baseURL}/api/state`);
  expect(state.status).toBe(200);
  expect(state.headers['cache-control']).toBe('no-store');
  expect(JSON.parse(state.body).listings.length).toBeGreaterThan(0);
  await testInfo.attach('transfer-bytes.json', { body: JSON.stringify({ runs, failures: 0, measures: 'HTTP response bodies only; no latency claim' }, null, 2), contentType: 'application/json' });
});
