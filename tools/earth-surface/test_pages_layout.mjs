#!/usr/bin/env node
// Pages同居bundleの配置、receipt、subpath URL、サイズ予算を検査する。
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  assert.ok(checked.capacity.measuredBytes > checked.bytes);
  assert.equal(checked.capacity.measuredBytes, staged.capacity.measuredBytes);
  assert.equal(staged.maxLod, 0);
  assert.equal(staged.declaredMaxLod, 7);
  assert.equal(staged.tileCount, 1);
  assert.deepEqual(staged.missingManifest, []);
  assert.equal(staged.capacity.withinBudget, true);
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
  await assert.rejects(() => checkPagesLayout(root, staged.datasetId, { maxBytes: 1 }), /byte budget/);

  const partialInput = join(root, 'partial-input');
  await cp(staged.target, partialInput, { recursive: true });
  const partialManifestPath = join(partialInput, 'earth-surface.json');
  const partialManifest = JSON.parse(await readFile(partialManifestPath, 'utf8'));
  partialManifest.coverage = { kind: 'complete', maxZoom: 7, expectedTiles: 43690 };
  await writeFile(partialManifestPath, `${JSON.stringify(partialManifest)}\n`);
  await assert.rejects(
    () => stagePages({ inputRoot: partialInput, outputRoot: join(root, 'partial-output'), maxBytes: 4 * 1024 * 1024 }),
    /partial production coverage.*1 tiles.*43690/,
  );

  const missingInput = join(root, 'missing-input');
  await assert.rejects(
    () => stagePages({ inputRoot: missingInput, outputRoot: join(root, 'missing-output'), maxBytes: 4 * 1024 * 1024 }),
    /missing manifest.*earth-surface\.json/,
  );
  console.log('earth-surface Pages layout fixtures: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
