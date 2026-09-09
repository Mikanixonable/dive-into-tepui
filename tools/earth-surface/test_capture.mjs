// T5 capture のファイル契約をブラウザなしで検査する。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
await execFileAsync(process.execPath, ['tools/render-lab-earth-surface.mjs', '--contract'], { cwd: root });
const file = path.join(root, '.earth-surface/verification/capture/metrics.json');
const document = JSON.parse(await readFile(file, 'utf8'));

assert.equal(document.schemaVersion, 2);
assert.deepEqual(document.viewport, { width: 1920, height: 1080 });
assert.equal(document.framesPerCase, 300);
assert.deepEqual(document.replayScenarios.map((entry) => entry.id), [
  'out-of-order-arrival', 'http-404', 'http-408-429-5xx', 'network-failure',
  '128-layer-capacity', 'dispose-and-generation', 'mipmap-disabled',
]);
assert.ok(document.replayScenarios.every((entry) => entry.status === 'covered-by-tests'));
assert.equal(document.cases.length, 15);
assert.equal(new Set(document.cases.map((entry) => entry.caseName)).size, 15);
for (const entry of document.cases) {
  assert.equal(entry.status, 'unavailable');
  assert.equal(entry.frames, 300);
  for (const buffer of [entry.color, entry.normal, entry.depth]) {
    assert.equal(buffer.status, 'unavailable');
    assert.equal(buffer.path, null);
    assert.ok(buffer.reason.length > 0);
  }
  for (const field of ['datasetId', 'selectedZ', 'errorPx', 'fallbackRate', 'httpDecodeWaitMs',
    'gpuLayers', 'pageTableUpdates', 'encodedBytes', 'payloadBytes', 'gpuP95Ms']) {
    assert.equal(entry[field], null, `${entry.caseName}.${field}`);
  }
}
console.log('earth-surface capture contract: ok');
