#!/usr/bin/env node
// Pages同居bundleの配置、receipt、subpath URL、サイズ予算を検査する。
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng } from '../png.mjs';
import {
  cacheControlForPages, checkPagesLayout, pagesManifestUrl, stagePages,
} from './stage-pages.mjs';

const root = await mkdtemp(join(tmpdir(), 'earth-pages-layout-'));
try {
  const staged = await stagePages({ outputRoot: root, maxBytes: 4 * 1024 * 1024 });
  const checked = await checkPagesLayout(root, staged.datasetId);
  assert.equal(checked.bytes, staged.totalBytes);
  const climate = decodePng(await readFile(join(staged.target, 'climate/01.png')));
  assert.deepEqual({ width: climate.width, height: climate.height, channels: climate.channels },
    { width: 1024, height: 512, channels: 4 });
  let cloudMin = 255;
  let cloudMax = 0;
  let landMin = 255;
  let landMax = 0;
  for (let index = 0; index < climate.data.length; index += 4) {
    const cloud = climate.data[index + 1];
    const land = climate.data[index + 3];
    cloudMin = Math.min(cloudMin, cloud);
    cloudMax = Math.max(cloudMax, cloud);
    landMin = Math.min(landMin, land);
    landMax = Math.max(landMax, land);
  }
  assert.ok(cloudMin < cloudMax);
  assert.ok(cloudMax > 0);
  assert.ok(landMin < landMax);
  assert.equal(pagesManifestUrl('/dive-into-tepui/', staged.datasetId), 'dive-into-tepui/earth-surface/earth-pages-fixture/earth-surface.json');
  assert.equal(cacheControlForPages('earth-surface.json'), 'public, max-age=60, must-revalidate');
  assert.equal(cacheControlForPages('tiles/0/0/0.bin.gz'), 'public, max-age=31536000, immutable');
  await assert.rejects(() => stagePages({ outputRoot: root, maxBytes: 1 }), /byte budget/);
  console.log('earth-surface Pages layout fixtures: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
