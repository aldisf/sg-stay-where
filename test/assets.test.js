import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { assetServer } from '../src/assets.js';

test('assets compress, revalidate, update, and keep media private', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ssw-assets-'));
  const file = path.join(dir, 'app.js');
  const original = 'export const value = "hello";\n'.repeat(100);
  await writeFile(file, original);
  const serve = assetServer();
  const server = http.createServer((req, res) => serve(req, res, file, { privateMedia: req.url === '/media' }).catch(error => {
    res.writeHead(error.status ?? 500);
    res.end(error.message);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const get = (headers = {}, url = '/') => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: server.address().port, path: url, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const plain = await get();
  assert.equal(plain.status, 200);
  assert.equal(plain.body.toString(), original);
  const compressed = await get({ 'accept-encoding': 'gzip' });
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.ok(compressed.body.length < plain.body.length);
  assert.equal(gunzipSync(compressed.body).toString(), original);
  const fresh = await get({ 'if-none-match': plain.headers.etag });
  assert.equal(fresh.status, 304);
  assert.equal(fresh.body.length, 0);
  const refused = await get({ 'accept-encoding': 'br, gzip;q=0' });
  assert.equal(refused.headers['content-encoding'], undefined);
  assert.equal(refused.body.toString(), original);
  await writeFile(file, 'export const value = "updated";');
  const changed = await get({ 'if-none-match': plain.headers.etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, plain.headers.etag);
  assert.equal(changed.body.toString(), 'export const value = "updated";');
  const media = await get({ 'if-none-match': changed.headers.etag }, '/media');
  assert.equal(media.status, 200);
  assert.equal(media.headers['cache-control'], 'no-store');
  assert.equal(media.headers.etag, undefined);
  await rm(file);
  assert.equal((await get()).status, 404);
});
