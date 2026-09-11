#!/usr/bin/env node
// npm run dev の地表 static mount と manifest の URL 契約を検査する。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const webpack = require('webpack');
const WebpackDevServer = require('webpack-dev-server');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATASET_ID = 'earth-2026-09-09-a';
const BUNDLE_PUBLIC_PATH = `/earth/${DATASET_ID}/`;
const MANIFEST_URL = `earth/${DATASET_ID}/earth-surface.json`;

const R2_BASE_URL = 'https://assets.mikanixonable.net/earth/earth-2026-09-09-a/';
const R2_MANIFEST_URL = `${R2_BASE_URL}earth-surface.json`;

function webpackConfigWithEnvironment({ baseUrl, manifestUrl, localBundle = true } = {}) {
  const nodeFs = require('node:fs');
  const previousBase = process.env.EARTH_SURFACE_BASE_URL;
  const previousManifest = process.env.EARTH_SURFACE_MANIFEST_URL;
  const previousExistsSync = nodeFs.existsSync;
  if (baseUrl === undefined) delete process.env.EARTH_SURFACE_BASE_URL;
  else process.env.EARTH_SURFACE_BASE_URL = baseUrl;
  if (manifestUrl === undefined) delete process.env.EARTH_SURFACE_MANIFEST_URL;
  else process.env.EARTH_SURFACE_MANIFEST_URL = manifestUrl;
  if (!localBundle) {
    nodeFs.existsSync = (filePath) => filePath === join(ROOT, '.earth-surface/bundle/earth-surface.json')
      ? false : previousExistsSync(filePath);
  }
  try {
    delete require.cache[require.resolve('../../webpack.config.js')];
    return require('../../webpack.config.js');
  } finally {
    nodeFs.existsSync = previousExistsSync;
    if (previousBase === undefined) delete process.env.EARTH_SURFACE_BASE_URL;
    else process.env.EARTH_SURFACE_BASE_URL = previousBase;
    if (previousManifest === undefined) delete process.env.EARTH_SURFACE_MANIFEST_URL;
    else process.env.EARTH_SURFACE_MANIFEST_URL = previousManifest;
  }
}

function definePlugin(config) {
  return config.plugins.find((plugin) => plugin.constructor.name === 'DefinePlugin');
}

function assertConfigContract(config) {
  assert.equal(config.output.path, resolve(ROOT, 'docs'));
  assert.ok(Array.isArray(config.devServer.static));
  assert.equal(config.devServer.static.length, 2);

  const [docsMount, bundleMount] = config.devServer.static;
  assert.equal(docsMount.directory, resolve(ROOT, 'docs'));
  assert.equal(docsMount.publicPath, '/');
  assert.equal(bundleMount.directory, resolve(ROOT, '.earth-surface/bundle'));
  assert.equal(bundleMount.publicPath, BUNDLE_PUBLIC_PATH);
  assert.equal(bundleMount.watch, false);

  const definitions = definePlugin(config)?.definitions;
  assert.ok(definitions);
  assert.equal(JSON.parse(definitions.__EARTH_SURFACE_MANIFEST_URL__), MANIFEST_URL);
  assert.equal(BUNDLE_PUBLIC_PATH.slice(1) + 'earth-surface.json', MANIFEST_URL);
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'earth-surface-dev-delivery-'));
  const docs = join(root, 'docs');
  const bundle = join(root, 'bundle');
  await mkdir(docs, { recursive: true });
  await mkdir(bundle, { recursive: true });
  await writeFile(join(docs, 'index.html'), 'docs fixture');
  await writeFile(join(bundle, 'earth-surface.json'), JSON.stringify({ datasetId: DATASET_ID }));
  await writeFile(join(bundle, 'tile.bin.gz'), Buffer.from('fixture'));
  return { root, docs, bundle };
}

async function assertHttpDelivery(config) {
  const fixture = await createFixture();
  const entry = join(fixture.root, 'entry.js');
  const output = join(fixture.root, 'dist');
  await writeFile(entry, 'console.log("fixture");\n');
  const compiler = webpack({
    mode: 'development',
    entry,
    output: { path: output, filename: 'main.js' },
  });
  const staticMounts = config.devServer.static.map((mount) => ({
    ...mount,
    directory: mount.directory === resolve(ROOT, 'docs') ? fixture.docs : fixture.bundle,
  }));
  const server = new WebpackDevServer({
    ...config.devServer,
    static: staticMounts,
    port: 0,
    host: '127.0.0.1',
  }, compiler);
  try {
    await server.start();
    const address = server.server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const manifestResponse = await fetch(`${baseUrl}${BUNDLE_PUBLIC_PATH}earth-surface.json`);
    assert.equal(manifestResponse.status, 200);
    assert.deepEqual(await manifestResponse.json(), { datasetId: DATASET_ID });
    const compressedResponse = await fetch(`${baseUrl}${BUNDLE_PUBLIC_PATH}tile.bin.gz`);
    assert.equal(compressedResponse.status, 200);
    assert.equal(compressedResponse.headers.get('content-encoding'), null);
    assert.match(compressedResponse.headers.get('content-type') ?? '', /^application\/gzip(?:;|$)/);
  } finally {
    await server.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function run() {
  const localConfig = webpackConfigWithEnvironment({ manifestUrl: MANIFEST_URL });
  assertConfigContract(localConfig);
  await assertHttpDelivery(localConfig);

  const externalConfig = webpackConfigWithEnvironment({ baseUrl: R2_BASE_URL });
  const definitions = definePlugin(externalConfig)?.definitions;
  assert.equal(JSON.parse(definitions.__EARTH_SURFACE_BASE_URL__), R2_BASE_URL);
  assert.equal(JSON.parse(definitions.__EARTH_SURFACE_MANIFEST_URL__), R2_MANIFEST_URL);

  const defaultConfig = webpackConfigWithEnvironment({ localBundle: false });
  const defaultDefinitions = definePlugin(defaultConfig)?.definitions;
  assert.equal(JSON.parse(defaultDefinitions.__EARTH_SURFACE_MANIFEST_URL__), R2_MANIFEST_URL);
  console.log('earth-surface dev delivery contract: ok');
}

run().catch((error) => {
  console.error(`earth-surface dev delivery contract: ${error.message}`);
  process.exitCode = 1;
});
