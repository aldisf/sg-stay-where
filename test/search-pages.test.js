import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.js';
import { ProjectFiles, newProject } from '../src/projects.js';
import { applyTemplate } from '../src/searches.js';

process.env.SSW_PORT = '0';
const { startServer } = await import('../src/server.js');

test('the template form shows the pages per poll its searches really use', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ssw-pages-'));
  const store = new Store(':memory:');
  const projects = new ProjectFiles(path.join(dataDir, 'projects'));
  projects.save(applyTemplate(newProject({ title: 'Home' }), 'main', { filters: { minPrice: 2000, maxPrice: 3000, bedrooms: [1], wholeUnit: true, districts: [] } }));
  const server = await startServer({ root: fileURLToPath(new URL('../', import.meta.url)), dataDir, store, projects, log: () => {} });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, route, data) => {
    const res = await fetch(origin + route, { method, headers: { 'content-type': 'application/json', origin }, body: data == null ? undefined : JSON.stringify(data) });
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  };
  assert.equal((await api('PATCH', '/api/projects/home/searches/main-propertyguru', { pages: 1 })).pages, 1);
  assert.equal((await api('GET', '/api/state?project=home')).templateDraft.pages, 1);
});

test('how much a poll reads is the user\'s setting, within limits', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ssw-limits-'));
  const store = new Store(':memory:');
  const projects = new ProjectFiles(path.join(dataDir, 'projects'));
  projects.save(newProject({ title: 'Home' }));
  const server = await startServer({ root: fileURLToPath(new URL('../', import.meta.url)), dataDir, store, projects, log: () => {} });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, data) => {
    const res = await fetch(origin + route, { method, headers: { 'content-type': 'application/json', origin }, body: data == null ? undefined : JSON.stringify(data) });
    return { status: res.status, body: await res.json() };
  };
  const filters = { minPrice: 2000, maxPrice: 3000, bedrooms: [1], wholeUnit: true, districts: [] };

  const { pollLimits } = (await call('GET', '/api/state?project=home')).body;
  assert.deepEqual(pollLimits, { pages: { default: 2, max: 5 }, listings: { default: 40, max: 150 } });

  assert.equal((await call('PUT', '/api/projects/home/templates/main', { filters, pages: 5 })).body.searches[0].pages, 5);
  assert.equal((await call('PUT', '/api/projects/home/templates/main', { filters, pages: 6 })).status, 400);
  const added = await call('POST', '/api/projects/home/searches', { title: 'Deep', url: 'https://www.propertyguru.com.sg/property-for-rent?minPrice=2100', pages: 4 });
  assert.equal(added.body.pages, 4);
  assert.equal((await call('POST', '/api/projects/home/searches', { title: 'Too deep', url: 'https://www.propertyguru.com.sg/property-for-rent?minPrice=2200', pages: 9 })).status, 400);
  assert.equal((await call('PATCH', '/api/projects/home/searches/deep', { pages: 6 })).status, 400);

  assert.equal((await call('PATCH', '/api/projects/home', { poll: { listings: 150 } })).body.poll.listings, 150);
  assert.equal((await call('PATCH', '/api/projects/home', { poll: { listings: 151 } })).status, 400);
  assert.equal((await call('PATCH', '/api/projects/home', { poll: { listings: 0 } })).status, 400);
});
