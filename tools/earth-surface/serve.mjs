#!/usr/bin/env node
// 地表配信物だけを返す検証用静的サーバー。親ディレクトリへの脱出を拒否する。
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const MIME = {
  '.bin': 'application/octet-stream', '.gz': 'application/gzip', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.json': 'application/json', '.png': 'image/png',
};

function cacheControl(relative) {
  return relative.endsWith('earth-surface.json') || relative.endsWith('receipt.json') || relative.endsWith('tile-index.json')
    ? 'public, max-age=60, must-revalidate'
    : 'public, max-age=31536000, immutable';
}

function corsHeaders(origin, allowedOrigins) {
  if (allowedOrigins.includes('*')) return { 'Access-Control-Allow-Origin': '*' };
  if (origin !== undefined && allowedOrigins.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  return allowedOrigins.length === 0 ? { 'Access-Control-Allow-Origin': '*' } : {};
}

export function earthSurfaceServer(root, port = 8084, options = {}) {
  const base = resolve(root);
  const allowedOrigins = options.allowedOrigins ?? [];
  return createServer(async (request, response) => {
    const origin = request.headers.origin;
    const cors = corsHeaders(origin, allowedOrigins);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        ...cors,
        Allow: 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      });
      response.end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD, OPTIONS', ...cors });
      response.end();
      return;
    }
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
      const file = resolve(join(base, relative));
      if (file !== base && !file.startsWith(`${base}${sep}`)) { response.writeHead(403); response.end(); return; }
      const info = await stat(file);
      if (!info.isFile()) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': cacheControl(relative),
        ...cors,
      });
      if (request.method === 'HEAD') { response.end(); return; }
      createReadStream(file).pipe(response);
    } catch { response.writeHead(404); response.end(); }
  }).listen(port, '127.0.0.1');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const root = process.argv[2] ?? '.earth-surface/distribution';
  const port = Number(process.argv[3] ?? 8084);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  const allowedOrigins = process.argv.slice(4).flatMap((value, index, values) =>
    value === '--allowed-origin' && values[index + 1] !== undefined ? [values[index + 1]] : []);
  earthSurfaceServer(root, port, { allowedOrigins });
  console.log(`earth-surface:serve: http://127.0.0.1:${port}/ (${resolve(root)})`);
}
