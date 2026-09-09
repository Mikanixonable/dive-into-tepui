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

export function earthSurfaceServer(root, port = 8084) {
  const base = resolve(root);
  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
      const file = resolve(join(base, relative));
      if (file !== base && !file.startsWith(`${base}${sep}`)) { response.writeHead(403); response.end(); return; }
      const info = await stat(file);
      if (!info.isFile()) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      });
      createReadStream(file).pipe(response);
    } catch { response.writeHead(404); response.end(); }
  }).listen(port, '127.0.0.1');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const root = process.argv[2] ?? '.earth-surface/distribution';
  const port = Number(process.argv[3] ?? 8084);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  earthSurfaceServer(root, port);
  console.log(`earth-surface:serve: http://127.0.0.1:${port}/ (${resolve(root)})`);
}
