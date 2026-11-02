import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDemo } from '../../src/demo.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

export const test = base.extend({
  seedData: [null, { option: true }],
  // Every test owns its database, media and process, including retries.
  baseURL: async ({ seedData }, use, testInfo) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ssw-e2e-'));
    const port = Number(process.env.SSW_E2E_PORT || 17432) + testInfo.parallelIndex;
    let child;
    try {
      await seedDemo(dir);
      await seedData?.(dir);
      child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'src/cli.js', 'serve', '--no-whatsapp'], {
        cwd: root,
        // Poll now runs a stand-in, never a real agent.
        env: { ...process.env, SSW_PORT: String(port), SSW_DATA_DIR: dir, SSW_POLL_COMMAND: `${process.execPath} -e setTimeout(()=>{},1500)` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Test server did not start: ${output}`)), 15000);
        const read = chunk => {
          output += chunk;
          if (output.includes(`sg-stay-where on http://127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); }
        };
        child.stdout.on('data', read);
        child.stderr.on('data', read);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Test server exited ${code}: ${output}`)); });
      });
      await use(`http://127.0.0.1:${port}`);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await stopped;
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
  page: async ({ page, baseURL }, use) => {
    const errors = [];
    // WebKit reports a same-origin request cancelled by a reload as an access-control
    // failure from the old page, even though the app catches it. Same-origin requests
    // never need access control, so this message can only mean that cancellation.
    const cancelledByNavigation = message => message.includes(`${new URL(baseURL).host}/`) && message.endsWith('due to access control checks.');
    page.on('pageerror', error => { if (!cancelledByNavigation(error.message)) errors.push(error.message); });
    // Keep the real MapLibre renderer and all app/API requests. Only third-party
    // content is replaced so the suite works offline and never visits portals.
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(baseURL + '/') || !/^https?:/.test(url)) return route.continue();
      if (process.env.SSW_LIVE_MAP && new URL(url).hostname.endsWith('.openfreemap.org')) return route.continue();
      if (url.startsWith('https://tiles.openfreemap.org/styles/')) {
        return route.fulfill({ json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f1f1ed' } }] } });
      }
      return route.fulfill({ status: 200, contentType: route.request().resourceType() === 'stylesheet' ? 'text/css' : 'text/plain', body: '' });
    });
    await use(page);
    expect(errors, 'uncaught browser errors').toEqual([]);
  },
});

export { expect };
