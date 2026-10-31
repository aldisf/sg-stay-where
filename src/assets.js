import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';

const compress = promisify(gzip);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

function acceptsGzip(header = '') {
  return header.split(',').some(part => {
    const [encoding, ...params] = part.trim().split(';');
    const quality = params.find(p => p.trim().startsWith('q='));
    return encoding.toLowerCase() === 'gzip' && (!quality || Number(quality.trim().slice(2)) > 0);
  });
}

export function assetServer() {
  const cache = new Map();
  return async function serveFile(req, res, file, { privateMedia = false } = {}) {
    let info;
    try { info = await stat(file); } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw Object.assign(new Error('not found'), { status: 404 });
      throw error;
    }
    if (!info.isFile()) throw Object.assign(new Error('not found'), { status: 404 });
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    // Photos and screenshots contain private data. Never cache them here or in a browser.
    if (privateMedia) {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': data.length });
      res.end(data);
      return;
    }
    const version = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    let entry = cache.get(file);
    if (entry?.version !== version) {
      const promise = readFile(file).then(async data => ({
        data,
        zipped: data.length > 1024 && /(?:text\/|json|svg)/.test(type) ? await compress(data) : null,
        etag: `W/"${createHash('sha256').update(data).digest('hex')}"`,
      }));
      entry = { version, promise };
      if (info.size <= 2_000_000) {
        cache.delete(file);
        cache.set(file, entry);
        if (cache.size > 32) cache.delete(cache.keys().next().value);
      }
    }
    let asset;
    try { asset = await entry.promise; } catch (error) { cache.delete(file); throw error; }
    const headers = { 'content-type': type, 'cache-control': 'private, no-cache', etag: asset.etag, vary: 'Accept-Encoding' };
    const matches = (req.headers['if-none-match'] ?? '').split(',').map(tag => tag.trim().replace(/^W\//, ''));
    if (matches.includes('*') || matches.includes(asset.etag.replace(/^W\//, ''))) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const zipped = asset.zipped && acceptsGzip(req.headers['accept-encoding']);
    const data = zipped ? asset.zipped : asset.data;
    if (zipped) headers['content-encoding'] = 'gzip';
    res.writeHead(200, { ...headers, 'content-length': data.length });
    res.end(data);
  };
}
