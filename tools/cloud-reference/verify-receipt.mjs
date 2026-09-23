// 取得ディレクトリ内の全 NetCDF と SHA256SUMS の対応・内容を検証する。
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RECEIPT_NAME = 'SHA256SUMS';
const NETCDF_SUFFIX = '.nc';

function result(status, errors = [], netcdfFileCount = 0) {
  return { status, netcdfFileCount, errors };
}

function listNetcdfFiles(directory, relativeDirectory = '') {
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = relativeDirectory === ''
      ? entry.name
      : `${relativeDirectory}/${entry.name}`;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`symbolic link prevents a complete file inventory: ${relativePath}`);
    }
    if (entry.name.endsWith(NETCDF_SUFFIX)) {
      if (!entry.isFile()) throw new Error(`NetCDF entry is not a regular file: ${relativePath}`);
      files.push(relativePath);
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...listNetcdfFiles(absolutePath, relativePath));
    }
  }
  return files;
}

function safeReceiptPath(relativePath, sourceDirectory) {
  const canonicalPath = path.sep === '\\' ? relativePath.replaceAll('\\', '/') : relativePath;
  if (canonicalPath.includes('\0') || (path.sep !== '\\' && canonicalPath.includes('\\'))
    || path.posix.isAbsolute(canonicalPath) || path.win32.isAbsolute(relativePath)
    || path.win32.parse(relativePath).root !== '') {
    throw new Error(`unsafe receipt path: ${JSON.stringify(relativePath)}`);
  }
  const segments = canonicalPath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    || path.posix.normalize(canonicalPath) !== canonicalPath) {
    throw new Error(`non-canonical receipt path: ${JSON.stringify(relativePath)}`);
  }
  if (!canonicalPath.endsWith(NETCDF_SUFFIX)) {
    throw new Error(`receipt path is not a NetCDF file: ${JSON.stringify(relativePath)}`);
  }
  const absolutePath = path.resolve(sourceDirectory, ...segments);
  const fromRoot = path.relative(sourceDirectory, absolutePath);
  if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error(`receipt path escapes the source directory: ${JSON.stringify(relativePath)}`);
  }
  return { canonicalPath, absolutePath };
}

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function parseReceipt(contents, sourceDirectory) {
  if (contents.trim().length === 0) throw new Error('checksum receipt is empty');
  const checksums = new Map();
  const lines = contents.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
    const match = /^([a-fA-F0-9]{64}) {2}(.+)$/.exec(line);
    if (match === null) throw new Error(`malformed checksum line ${index + 1}`);
    const relativePath = match[2];
    const safePath = safeReceiptPath(relativePath, sourceDirectory);
    if (checksums.has(safePath.canonicalPath)) {
      throw new Error(`duplicate receipt path: ${safePath.canonicalPath}`);
    }
    checksums.set(safePath.canonicalPath, {
      digest: match[1].toLowerCase(),
      absolutePath: safePath.absolutePath,
    });
  }
  if (checksums.size === 0) throw new Error('checksum receipt contains no entries');
  return checksums;
}

/** 指定ディレクトリ内の NetCDF 一覧とレシートを照合し、欠測を状態として返す。 */
export async function verifyReceipt(sourceDirectory, expectedReceiptDigest = undefined) {
  const absoluteDirectory = path.resolve(sourceDirectory);
  let directoryInfo;
  try {
    directoryInfo = lstatSync(absoluteDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') return result('blocked', ['source directory is absent']);
    return result('failed', [error.message]);
  }
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    return result('failed', ['source path is not a regular directory']);
  }

  const receiptPath = path.join(absoluteDirectory, RECEIPT_NAME);
  let receiptInfo;
  try {
    receiptInfo = lstatSync(receiptPath);
  } catch (error) {
    if (error.code === 'ENOENT') return result('blocked', ['SHA256SUMS receipt is absent']);
    return result('failed', [error.message]);
  }
  if (receiptInfo.isSymbolicLink() || !receiptInfo.isFile()) {
    return result('failed', ['SHA256SUMS is not a regular file']);
  }
  if (expectedReceiptDigest === null) {
    return result('blocked', ['manifest SHA256SUMS digest has not been recorded']);
  }
  if (expectedReceiptDigest !== undefined) {
    if (typeof expectedReceiptDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedReceiptDigest)) {
      return result('failed', ['manifest SHA256SUMS digest is malformed']);
    }
    if (await sha256(receiptPath) !== expectedReceiptDigest) {
      return result('failed', ['manifest SHA256SUMS digest mismatch']);
    }
  }

  try {
    const netcdfFiles = listNetcdfFiles(absoluteDirectory).sort();
    if (netcdfFiles.length === 0) throw new Error('source directory contains no NetCDF files');
    const checksums = parseReceipt(readFileSync(receiptPath, 'utf8'), absoluteDirectory);
    const inventory = new Set(netcdfFiles);
    const missing = netcdfFiles.filter((filename) => !checksums.has(filename));
    const extra = [...checksums.keys()].filter((filename) => !inventory.has(filename));
    if (missing.length > 0 || extra.length > 0) {
      const errors = [];
      if (missing.length > 0) errors.push(`NetCDF files missing from receipt: ${missing.join(', ')}`);
      if (extra.length > 0) errors.push(`receipt entries without NetCDF files: ${extra.join(', ')}`);
      return result('failed', errors, netcdfFiles.length);
    }

    for (const [relativePath, entry] of checksums) {
      const segments = relativePath.split('/');
      let parent = absoluteDirectory;
      for (const segment of segments.slice(0, -1)) {
        parent = path.join(parent, segment);
        const parentInfo = lstatSync(parent);
        if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
          throw new Error(`receipt path traverses a non-directory or symbolic link: ${relativePath}`);
        }
      }
      const fileInfo = lstatSync(entry.absolutePath);
      if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
        throw new Error(`receipt path is not a regular NetCDF file: ${relativePath}`);
      }
      if (await sha256(entry.absolutePath) !== entry.digest) {
        throw new Error(`SHA-256 mismatch: ${relativePath}`);
      }
    }
    return result('verified', [], netcdfFiles.length);
  } catch (error) {
    return result('failed', [error.message]);
  }
}

function usage() {
  return 'usage: node tools/cloud-reference/verify-receipt.mjs [--case <case-id>|--sha256 <digest>] <acquisition-directory>';
}

if (process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 && !(args.length === 3 && (args[0] === '--case' || args[0] === '--sha256'))) {
    console.error(usage());
    process.exitCode = 1;
  } else {
    let expectedReceiptDigest;
    if (args[0] === '--sha256') {
      expectedReceiptDigest = args[1];
    } else if (args.length === 3) {
      const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const referenceCase = manifest.cases.find((entry) => entry.id === args[1]);
      if (referenceCase?.source?.provider !== 'NOAA') {
        throw new Error(`case is not a NOAA GOES reference: ${args[1]}`);
      }
      expectedReceiptDigest = referenceCase.source.checksum.value;
    }
    const verification = await verifyReceipt(args.at(-1), expectedReceiptDigest);
    console.log(JSON.stringify(verification, null, 2));
    if (verification.status === 'blocked') process.exitCode = 2;
    if (verification.status === 'failed') process.exitCode = 1;
  }
}
