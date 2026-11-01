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
