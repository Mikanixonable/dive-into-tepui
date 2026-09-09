#!/usr/bin/env node
// Pages同居bundleの配置、receipt、subpath URL、サイズ予算を検査する。
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cacheControlForPages, checkPagesLayout, pagesManifestUrl, stagePages,
} from './stage-pages.mjs';

const root = await mkdtemp(join(tmpdir(), 'earth-pages-layout-'));
try {
  const staged = await stagePages({ outputRoot: root, maxBytes: 128 * 1024 });
  const checked = await checkPagesLayout(root, staged.datasetId);
  assert.equal(checked.bytes, staged.totalBytes);
  assert.equal(pagesManifestUrl('/dive-into-tepui/', staged.datasetId), 'dive-into-tepui/earth-surface/earth-pages-fixture/earth-surface.json');
  assert.equal(cacheControlForPages('earth-surface.json'), 'public, max-age=60, must-revalidate');
  assert.equal(cacheControlForPages('tiles/0/0/0.bin.gz'), 'public, max-age=31536000, immutable');
  await assert.rejects(() => stagePages({ outputRoot: root, maxBytes: 1 }), /byte budget/);
  console.log('earth-surface Pages layout fixtures: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
