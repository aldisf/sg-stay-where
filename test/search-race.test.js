import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.js';
import { ProjectFiles, newProject } from '../src/projects.js';
import { applyTemplate } from '../src/searches.js';

process.env.SSW_PORT = '0';
const { startServer } = await import('../src/server.js');
const filters = { minPrice: 2000, maxPrice: 3000, bedrooms: [1], wholeUnit: true, districts: [] };

test('slow project/search edits preserve a sourcing plan applied while their body was arriving', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ssw-race-'));
  const store = new Store(':memory:');
  const projects = new ProjectFiles(path.join(dataDir, 'projects'));
  projects.save(applyTemplate(newProject({ title: 'Home' }), 'main', { filters }));
  const server = await startServer({ root: fileURLToPath(new URL('../', import.meta.url)), dataDir, store, projects, log: () => {} });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const begin = (method, route) => {
    let req;
    const result = new Promise((resolve, reject) => {
      req = http.request(origin + route, { method, headers: { 'content-type': 'application/json' }, agent: false }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
      });
      req.on('error', reject);
    });
    return { req, result };
  };
  const api = async (method, route, data) => {
    const { req, result } = begin(method, route);
    req.end(data == null ? undefined : JSON.stringify(data));
    const response = await result;
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  };
  for (const [method, route, patch] of [
    ['PATCH', '/api/projects/home/searches/main-propertyguru', { active: false }],
    ['PATCH', '/api/projects/home', { title: 'New title' }],
    ['POST', '/api/projects/home/searches', { title: 'Extra search', url: 'https://www.propertyguru.com.sg/property-for-rent?minPrice=2100', pages: 1 }],
  ]) {
    await api('PUT', '/api/projects/home/search-brief', { text: 'Raise max price to 3500' });
    const slow = begin(method, route);
    await new Promise(resolve => slow.req.write('{', resolve));
    // A later read gives the server an opportunity to enter the slow handler.
    const state = await api('GET', '/api/state?project=home');
    await api('PUT', '/api/projects/home/search-plan', { revision: state.project.searchBrief.revision, projectVersion: state.projectVersion, filters: { ...filters, maxPrice: 3500 }, explanation: 'Raised maximum to S$3500.' });
    slow.req.end(JSON.stringify(patch).slice(1));
    assert.equal((await slow.result).status, 200);
    const after = await api('GET', '/api/state?project=home');
    assert.equal(after.project.searchBrief.status, 'applied', route);
    assert.equal(after.project.templates.main.filters.maxPrice, 3500, route);
    assert.match(after.project.searches.find(s => s.id === 'main-propertyguru').url, /maxPrice=3500/, route);
  }
  const after = await api('GET', '/api/state?project=home');
  assert.equal(after.project.searches.find(s => s.id === 'main-propertyguru').active, false);
  assert.equal(after.project.title, 'New title');
  assert.ok(after.project.searches.some(s => s.title === 'Extra search'));
});
