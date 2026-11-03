import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.js';
import { ProjectFiles, newProject } from '../src/projects.js';

process.env.SSW_PORT = '0';
const { startServer } = await import('../src/server.js');

test('imports reject unsupported Maps payloads without recording a successful poll', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ssw-import-payload-'));
  const store = new Store(':memory:');
  const projects = new ProjectFiles(path.join(dir, 'projects'));
  projects.save(newProject({ title: 'Home' }));
  const server = await startServer({ root: fileURLToPath(new URL('../', import.meta.url)), dataDir: dir, store, projects, log: () => {} });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(origin + '/api/import', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const body of [null, [], {}, { listings: {} }, { enrichment: { 1: {} } }, { listings: [], enrichment: {}, poll: 'bad payload' }]) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    const error = (await response.json()).error;
    assert.match(error, body && 'enrichment' in body ? /PUT \/api\/listings\/<id>\/enrichment/ : /listings array/);
  }
  assert.equal(store.recentPolls(10).length, 0);
  assert.equal(store.listListings().length, 0);
  const empty = await post({ listings: [], project: 'home', poll: 'empty search' });
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).imported, 0);
  assert.equal(store.recentPolls(1)[0].search, 'empty search');
});

test('a result page whose oldest card is new asks for the next page', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ssw-import-next-'));
  const store = new Store(':memory:');
  const projects = new ProjectFiles(path.join(dir, 'projects'));
  projects.save(newProject({ title: 'Home' }));
  const server = await startServer({ root: fileURLToPath(new URL('../', import.meta.url)), dataDir: dir, store, projects, log: () => {} });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async body => (await fetch(origin + '/api/import', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const card = id => ({ source: 'propertyguru', source_id: String(id), url: `https://www.propertyguru.com.sg/listing/for-rent-flat-${id}`, title: `Flat ${id}`, price: 3000 + id, bedrooms: 2 });
  const page = ids => ({ project: 'home', found_by: 'poll', poll: 'PG', listings: ids.map(card) });

  assert.equal((await post(page([5, 4, 3]))).readNext, true, 'first page, nothing seen before');
  assert.equal((await post(page([7, 6, 5]))).readNext, false, 'reached the last poll');
  assert.equal((await post(page([9, 8]))).readNext, true, 'new all the way down: a gap');
  assert.equal((await post(page([]))).readNext, false, 'no cards, nothing further');
  assert.equal((await post({ project: 'home', listings: [card(10)] })).readNext, false, 'not a poll');
});
