// GOES acquisition selector and local file inventory checks use tiny synthetic files.
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from '../harness';

interface AcquisitionStep {
  readonly args: readonly string[];
}

const CASE_ID = 'marine-cell-california-2024-05-15';
const ACQUIRE_SCRIPT = resolve(process.cwd(), 'tools/cloud-reference/acquire.mjs');

function withDirectory<T>(action: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-reference-acquisition-'));
  try {
    return action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function acquisitionSteps(directory: string): readonly AcquisitionStep[] {
  return JSON.parse(execFileSync(process.execPath, [
    ACQUIRE_SCRIPT, '--dry-run', CASE_ID, directory,
  ], { encoding: 'utf8' })) as readonly AcquisitionStep[];
}

function formatNoaaTimestamp(epochMilliseconds: number): string {
  const date = new Date(epochMilliseconds);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = String(Math.floor((date.getTime() - yearStart) / 86_400_000) + 1).padStart(3, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const secondsTenths = `${String(date.getUTCSeconds()).padStart(2, '0')}${Math.floor(date.getUTCMilliseconds() / 100)}`;
  return `${year}${dayOfYear}${hour}${minute}${secondsTenths}`;
}

function writeSelectedFiles(directory: string, steps: readonly AcquisitionStep[]): readonly string[] {
  const relativeFiles: string[] = [];
  for (const step of steps) {
    const outputDirectory = step.args[3]!;
    const productDirectory = relative(directory, outputDirectory);
    for (let index = 0; index < step.args.length; index += 1) {
      if (step.args[index] !== '--include') continue;
      const selector = step.args[index + 1]!;
      const slotMatch = /_s(\d{11})\*\.nc$/.exec(selector);
      assert.ok(slotMatch, `unexpected NOAA include selector: ${selector}`);
      const [, slotText] = slotMatch;
      const year = Number(slotText.slice(0, 4));
      const dayOfYear = Number(slotText.slice(4, 7));
      const hour = Number(slotText.slice(7, 9));
      const minute = Number(slotText.slice(9, 11));
      const slotMilliseconds = Date.UTC(year, 0, dayOfYear, hour, minute);
      const filename = selector.replace('*.nc', [
        formatNoaaTimestamp(slotMilliseconds + 20_800).slice(-3),
        `e${formatNoaaTimestamp(slotMilliseconds + 9 * 60_000 + 51_600)}`,
        `c${formatNoaaTimestamp(slotMilliseconds + 9 * 60_000 + 56_400)}.nc`,
      ].join('_'));
      const relativePath = join(productDirectory, filename);
      const target = join(directory, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'synthetic test bytes');
      relativeFiles.push(relativePath);
    }
  }
  return relativeFiles;
}

function runLocalVerification(directory: string): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const child = spawnSync(process.execPath, [ACQUIRE_SCRIPT, '--verify-local', CASE_ID, directory], {
    encoding: 'utf8',
  });
  assert.equal(child.error, undefined);
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

function installAwsStub(directory: string): string {
  const binDirectory = join(directory, 'bin');
  mkdirSync(binDirectory);
  const awsPath = join(binDirectory, 'aws');
  writeFileSync(awsPath, `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const args = process.argv.slice(2);
const outputDirectory = args[3];
function timestamp(milliseconds) {
  const date = new Date(milliseconds);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const day = String(Math.floor((date.getTime() - yearStart) / 86400000) + 1).padStart(3, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0') + Math.floor(date.getUTCMilliseconds() / 100);
  return year + day + hour + minute + seconds;
}
for (let index = 0; index < args.length; index += 1) {
  if (args[index] !== '--include') continue;
  const selector = args[index + 1];
  const match = /_s(\\d{4})(\\d{3})(\\d{2})(\\d{2})\\*\\.nc$/.exec(selector);
  if (!match) throw new Error('unexpected include selector: ' + selector);
  const [, year, day, hour, minute] = match;
  const slot = Date.UTC(Number(year), 0, Number(day), Number(hour), Number(minute));
  const suffix = timestamp(slot + 20800).slice(-3)
    + '_e' + timestamp(slot + 9 * 60000 + 51600)
    + '_c' + timestamp(slot + 9 * 60000 + 56400);
  const filename = selector.replace('*', suffix);
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, basename(filename)), 'stub aws bytes');
}
`);
  chmodSync(awsPath, 0o755);
  return binDirectory;
}

export function register(): void {
  test('cloud reference acquisition: exact planned file inventory verifies without inspecting NetCDF contents', () => {
    withDirectory((directory) => {
      const steps = acquisitionSteps(directory);
      const files = writeSelectedFiles(directory, steps);
      assert.equal(files.length, 37 * 6);
      const result = runLocalVerification(directory);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /verified 222 planned NetCDF files; file contents were not inspected/);
    });
  });

  test('cloud reference acquisition: successful stubbed AWS run writes checksums for the exact planned inventory', () => {
    withDirectory((directory) => {
      const binDirectory = installAwsStub(directory);
      const outputDirectory = join(directory, 'acquired');
      const child = spawnSync(process.execPath, [ACQUIRE_SCRIPT, CASE_ID, outputDirectory], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH ?? ''}` },
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, child.stderr);
      const receipt = readFileSync(join(outputDirectory, 'SHA256SUMS'), 'utf8').trim().split('\n');
      assert.equal(receipt.length, 37 * 6);
      const expectedHash = createHash('sha256').update('stub aws bytes').digest('hex');
      assert.ok(receipt.every((line) => line.startsWith(`${expectedHash}  `)));
    });
  });

  test('cloud reference acquisition: existing symbolic entries fail before AWS writes', () => {
    withDirectory((directory) => {
      const binDirectory = installAwsStub(directory);
      const outputDirectory = join(directory, 'acquired');
      const outsideFile = join(directory, 'outside.nc');
      mkdirSync(outputDirectory);
      writeFileSync(outsideFile, 'leave this file unchanged');
      symlinkSync(outsideFile, join(outputDirectory, 'linked.nc'));
      const child = spawnSync(process.execPath, [ACQUIRE_SCRIPT, CASE_ID, outputDirectory], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH ?? ''}` },
      });
      assert.equal(child.error, undefined);
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, /symbolic link prevents NetCDF inventory/);
      assert.equal(readFileSync(outsideFile, 'utf8'), 'leave this file unchanged');
    });
  });

  test('cloud reference acquisition: a missing scan product fails local inventory verification', () => {
    withDirectory((directory) => {
      const files = writeSelectedFiles(directory, acquisitionSteps(directory));
      unlinkSync(join(directory, files[0]!));
      const result = runLocalVerification(directory);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /missing NetCDF file for selector/);
    });
  });

  test('cloud reference acquisition: an unplanned NetCDF file fails local inventory verification', () => {
    withDirectory((directory) => {
      writeSelectedFiles(directory, acquisitionSteps(directory));
      writeFileSync(join(directory, 'unexpected.nc'), 'synthetic extra file');
      const result = runLocalVerification(directory);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unexpected NetCDF file: unexpected.nc/);
    });
  });

  test('cloud reference acquisition: two files for one product and scan slot fail inventory verification', () => {
    withDirectory((directory) => {
      const files = writeSelectedFiles(directory, acquisitionSteps(directory));
      const firstPath = files[0]!;
      const duplicatePath = firstPath.replace('c20241361609564.nc', 'c20241361609599.nc');
      writeFileSync(join(directory, duplicatePath), 'synthetic duplicate scan');
      const result = runLocalVerification(directory);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /duplicate NetCDF files for selector/);
    });
  });

  test('cloud reference acquisition: malformed NOAA filename suffixes do not satisfy a scan selector', () => {
    withDirectory((directory) => {
      const files = writeSelectedFiles(directory, acquisitionSteps(directory));
      const validPath = files[0]!;
      const malformedPath = validPath.replace(/208_e.*\.nc$/, 'garbage.nc');
      unlinkSync(join(directory, validPath));
      writeFileSync(join(directory, malformedPath), 'malformed synthetic filename');
      const result = runLocalVerification(directory);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unexpected NetCDF file/);
      assert.match(result.stderr, /missing NetCDF file for selector/);
    });
  });

  test('cloud reference acquisition: out-of-order NOAA start, end, or creation timestamps fail inventory verification', () => {
    const invalidSuffixes = [
      '208_e20241361600150_c20241361600200.nc',
      '208_e20241361609516_c20241361609500.nc',
    ];
    for (const invalidSuffix of invalidSuffixes) {
      withDirectory((directory) => {
        const files = writeSelectedFiles(directory, acquisitionSteps(directory));
        const validPath = files[0]!;
        const invalidPath = validPath.replace(/208_e.*\.nc$/, invalidSuffix);
        unlinkSync(join(directory, validPath));
        writeFileSync(join(directory, invalidPath), 'out-of-order synthetic filename');
        const result = runLocalVerification(directory);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /unexpected NetCDF file/);
        assert.match(result.stderr, /missing NetCDF file for selector/);
      });
    }
  });

  test('cloud reference acquisition: symbolic NetCDF files cannot escape the output directory', () => {
    withDirectory((temporaryRoot) => {
      const directory = join(temporaryRoot, 'data');
      mkdirSync(directory);
      const files = writeSelectedFiles(directory, acquisitionSteps(directory));
      const outsideFile = join(temporaryRoot, 'outside.nc');
      writeFileSync(outsideFile, 'not part of the output directory');
      unlinkSync(join(directory, files[0]!));
      symlinkSync(outsideFile, join(directory, files[0]!));
      const result = runLocalVerification(directory);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /symbolic link prevents NetCDF inventory/);
    });
  });

  test('cloud reference acquisition: symbolic directories cannot escape the output directory', () => {
    withDirectory((temporaryRoot) => {
      const directory = join(temporaryRoot, 'data');
      const outsideDirectory = join(temporaryRoot, 'outside');
      mkdirSync(directory);
      mkdirSync(outsideDirectory);
      writeSelectedFiles(directory, acquisitionSteps(directory));
      symlinkSync(outsideDirectory, join(directory, 'linked-directory'));
      const result = runLocalVerification(directory);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /symbolic link prevents NetCDF inventory/);
    });
  });

  test('cloud reference acquisition: a symbolic output root is rejected', () => {
    withDirectory((temporaryRoot) => {
      const outsideDirectory = join(temporaryRoot, 'outside');
      const outputLink = join(temporaryRoot, 'data-link');
      mkdirSync(outsideDirectory);
      symlinkSync(outsideDirectory, outputLink);
      const result = runLocalVerification(outputLink);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /acquisition output must be a directory/);
    });
  });

  test('cloud reference acquisition: a symbolic checksum path is rejected before receipt writes', () => {
    withDirectory((temporaryRoot) => {
      const directory = join(temporaryRoot, 'data');
      mkdirSync(directory);
      writeSelectedFiles(directory, acquisitionSteps(directory));
      const outsideReceipt = join(temporaryRoot, 'outside-receipt.txt');
      writeFileSync(outsideReceipt, 'leave this file unchanged');
      symlinkSync(outsideReceipt, join(directory, 'SHA256SUMS'));
      const result = runLocalVerification(directory);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /SHA256SUMS must be a regular file/);
      assert.equal(readFileSync(outsideReceipt, 'utf8'), 'leave this file unchanged');
    });
  });
}
