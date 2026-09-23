import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from '../harness';

interface ReceiptVerification {
  readonly status: 'verified' | 'blocked' | 'failed';
  readonly netcdfFileCount: number;
  readonly errors: readonly string[];
}

const VERIFY_SCRIPT = resolve(process.cwd(), 'tools/cloud-reference/verify-receipt.mjs');

function digest(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function withDirectory<T>(action: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-reference-receipt-'));
  try {
    return action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeNetcdf(directory: string, relativePath: string, contents: string): void {
  const filename = join(directory, relativePath);
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, contents);
}

function runVerifier(directory: string): { readonly code: number; readonly result: ReceiptVerification } {
  const child = spawnSync(process.execPath, [VERIFY_SCRIPT, directory], { encoding: 'utf8' });
  assert.equal(child.error, undefined);
  assert.notEqual(child.stdout, '', child.stderr);
  return {
    code: child.status ?? -1,
    result: JSON.parse(child.stdout) as ReceiptVerification,
  };
}

function writeReceipt(directory: string, files: Readonly<Record<string, string>>): void {
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
  writeFileSync(join(directory, 'SHA256SUMS'), `${entries.map(
    ([filename, contents]) => `${digest(contents)}  ${filename}`,
  ).join('\n')}\n`);
}

export function register(): void {
  test('cloud reference receipt: nested NetCDF files with spaces verify by SHA-256', () => {
    withDirectory((directory) => {
      const files = {
        'ABI-L1b-RadF/frame one.nc': 'radiance bytes',
        'ABI-L2-ACHAF/cloud-height.nc': 'height bytes',
      };
      for (const [filename, contents] of Object.entries(files)) writeNetcdf(directory, filename, contents);
      writeReceipt(directory, files);
      const result = runVerifier(directory);
      assert.equal(result.code, 0);
      assert.deepEqual(result.result, { status: 'verified', netcdfFileCount: 2, errors: [] });
    });
  });

  test('cloud reference receipt: missing receipt is blocked rather than passed', () => {
    withDirectory((directory) => {
      writeNetcdf(directory, 'frame.nc', 'data');
      const result = runVerifier(directory);
      assert.equal(result.code, 2);
      assert.equal(result.result.status, 'blocked');
      assert.match(result.result.errors.join(' '), /receipt is absent/);
    });
  });

  test('cloud reference receipt: empty receipts, malformed digests, and mismatches fail', () => {
    withDirectory((directory) => {
      writeNetcdf(directory, 'frame.nc', 'data');
      writeFileSync(join(directory, 'SHA256SUMS'), '  \n');
      assert.match(runVerifier(directory).result.errors.join(' '), /receipt is empty/);

      writeFileSync(join(directory, 'SHA256SUMS'), `not-a-digest  frame.nc\n`);
      assert.match(runVerifier(directory).result.errors.join(' '), /malformed checksum line/);

      writeFileSync(join(directory, 'SHA256SUMS'), `${'0'.repeat(64)}  frame.nc\n`);
      assert.match(runVerifier(directory).result.errors.join(' '), /SHA-256 mismatch/);
    });
  });

  test('cloud reference receipt: traversal and duplicate receipt paths fail', () => {
    withDirectory((directory) => {
      writeNetcdf(directory, 'frame.nc', 'data');
      const validDigest = digest('data');
      writeFileSync(join(directory, 'SHA256SUMS'), `${validDigest}  ../outside.nc\n`);
      assert.match(runVerifier(directory).result.errors.join(' '), /unsafe receipt path|non-canonical receipt path/);

      writeFileSync(join(directory, 'SHA256SUMS'), `${validDigest}  frame.nc\n${validDigest}  frame.nc\n`);
      assert.match(runVerifier(directory).result.errors.join(' '), /duplicate receipt path/);
    });
  });

  test('cloud reference receipt: missing and extra NetCDF inventory entries fail', () => {
    withDirectory((directory) => {
      const files = { 'one.nc': 'one', 'two.nc': 'two' };
      for (const [filename, contents] of Object.entries(files)) writeNetcdf(directory, filename, contents);
      writeFileSync(join(directory, 'SHA256SUMS'), `${digest('one')}  one.nc\n`);
      assert.match(runVerifier(directory).result.errors.join(' '), /NetCDF files missing from receipt: two.nc/);

      writeFileSync(join(directory, 'SHA256SUMS'), `${digest('one')}  one.nc\n${digest('ghost')}  ghost.nc\n${digest('two')}  two.nc\n`);
      assert.match(runVerifier(directory).result.errors.join(' '), /receipt entries without NetCDF files: ghost.nc/);

      writeReceipt(directory, files);
      writeNetcdf(directory, 'unexpected.nc', 'extra');
      assert.match(runVerifier(directory).result.errors.join(' '), /NetCDF files missing from receipt: unexpected.nc/);
    });
  });

  test('cloud reference receipt: symbolic links cannot make the inventory escape its source', () => {
    withDirectory((directory) => {
      writeNetcdf(directory, 'frame.nc', 'data');
      writeReceipt(directory, { 'frame.nc': 'data' });
      const linked = join(directory, 'linked.nc');
      try {
        // 別名を含む取得ディレクトリは一覧を確定できないため検証を失敗させる。
        symlinkSync(join(directory, 'frame.nc'), linked);
        assert.match(runVerifier(directory).result.errors.join(' '), /symbolic link prevents/);
      } finally {
        rmSync(linked, { force: true });
      }
    });
  });

  test('cloud reference receipt: a non-regular NetCDF entry fails on FIFO-capable platforms', () => {
    if (process.platform === 'win32') return;
    withDirectory((directory) => {
      writeNetcdf(directory, 'frame.nc', 'data');
      writeReceipt(directory, { 'frame.nc': 'data' });
      const fifoPath = join(directory, 'special.nc');
      const fifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
      if (fifo.error !== undefined) {
        if (fifo.error.message.includes('ENOENT')) return;
        throw fifo.error;
      }
      assert.equal(fifo.status, 0, fifo.stderr);
      assert.match(runVerifier(directory).result.errors.join(' '), /NetCDF entry is not a regular file/);
    });
  });
}
