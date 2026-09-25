// Acquire every GOES ABI frame and matching cloud product needed by one manifest case.
// The command intentionally keeps source NetCDF files; spatial cropping belongs to the
// observation operator so checksum receipts continue to identify NOAA's originals.
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  acquisitionPlan, matchesSelectorKey, plannedNetcdfSelectors, PRODUCTS,
} from './selection.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const manifestPath = path.join(import.meta.dirname, 'manifest.json');

function usage() {
  throw new Error('usage: node tools/cloud-reference/acquire.mjs [--dry-run|--verify-local] <case-id> <output-directory>');
}

function filesBelow(directory) {
  const directoryStatus = lstatSync(directory);
  if (directoryStatus.isSymbolicLink()) throw new Error(`symbolic link prevents NetCDF inventory: ${directory}`);
  if (!directoryStatus.isDirectory()) throw new Error(`NetCDF inventory path is not a directory: ${directory}`);
  const files = [];
  for (const entry of readdirSync(directory)) {
    const candidate = path.join(directory, entry);
    const status = lstatSync(candidate);
    if (status.isSymbolicLink()) throw new Error(`symbolic link prevents NetCDF inventory: ${candidate}`);
    if (status.isDirectory()) files.push(...filesBelow(candidate));
    else if (status.isFile()) files.push(candidate);
    else throw new Error(`non-regular entry prevents NetCDF inventory: ${candidate}`);
  }
  return files;
}

function assertDirectoryPathSafe(directory, label, allowMissing) {
  // Ancestors are part of the caller-selected path (macOS /var is itself a
  // symlink); the acquisition root and its existing contents must not be.
  try {
    const status = lstatSync(directory);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error(`${label} must be a directory, not a symbolic link or file: ${directory}`);
    }
    return true;
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return false;
    throw error;
  }
}

function assertReceiptTargetSafe(outputDirectory, allowMissingDirectory = false) {
  if (!assertDirectoryPathSafe(outputDirectory, 'acquisition output', allowMissingDirectory)) return;
  const receiptPath = path.join(outputDirectory, 'SHA256SUMS');
  try {
    const status = lstatSync(receiptPath);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new Error(`SHA256SUMS must be a regular file, not a symbolic link or special entry: ${receiptPath}`);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}

function validateLocalInventory(referenceCase, outputDirectory) {
  const selectors = plannedNetcdfSelectors(referenceCase);
  const matchedFiles = selectors.map(() => []);
  const errors = [];
  const netcdfFiles = filesBelow(outputDirectory).filter((filename) => filename.endsWith('.nc')).sort();

  for (const filename of netcdfFiles) {
    const relativePath = path.relative(outputDirectory, filename).split(path.sep).join('/');
    const [productPrefix] = relativePath.split('/');
    const basename = path.basename(filename);
    const matchingIndexes = selectors.flatMap((selector, index) => (
      selector.productPrefix === productPrefix && matchesSelectorKey(selector, relativePath) ? [index] : []
    ));
    if (matchingIndexes.length === 0) {
      errors.push(`unexpected NetCDF file: ${relativePath}`);
      continue;
    }
    if (matchingIndexes.length > 1) {
      errors.push(`NetCDF file matches multiple planned selectors: ${relativePath}`);
      continue;
    }
    const selectorIndex = matchingIndexes[0];
    matchedFiles[selectorIndex].push(relativePath);
    const expectedPath = `${selectors[selectorIndex].productPrefix}/${basename}`;
    if (relativePath !== expectedPath) errors.push(`unexpected NetCDF path: ${relativePath}`);
  }

  for (const [index, files] of matchedFiles.entries()) {
    const selector = selectors[index];
    const description = `${selector.productPrefix}/${selector.filenamePrefix}*.nc`;
    if (files.length === 0) errors.push(`missing NetCDF file for selector: ${description}`);
    if (files.length > 1) errors.push(`duplicate NetCDF files for selector ${description}: ${files.join(', ')}`);
  }
  return { fileCount: netcdfFiles.length, files: netcdfFiles, errors };
}

async function checksum(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeChecksumReceipt(referenceCase, outputDirectory) {
  assertReceiptTargetSafe(outputDirectory);
  const inventory = validateLocalInventory(referenceCase, outputDirectory);
  if (inventory.errors.length > 0) {
    throw new Error(`download NetCDF inventory failed:\n${inventory.errors.join('\n')}`);
  }
  const lines = [];
  for (const filename of inventory.files) {
    lines.push(`${await checksum(filename)}  ${path.relative(outputDirectory, filename)}`);
  }
  writeFileSync(path.join(outputDirectory, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

const args = process.argv.slice(2);
const dryRun = args[0] === '--dry-run';
const verifyLocal = args[0] === '--verify-local';
if (dryRun || verifyLocal) args.shift();
if (args.length !== 2) usage();
const [caseId, outputArgument] = args;
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const referenceCase = manifest.cases.find((candidate) => candidate.id === caseId);
if (referenceCase === undefined) throw new Error(`unknown cloud reference case: ${caseId}`);
const outputDirectory = path.resolve(root, outputArgument);
const plan = acquisitionPlan(referenceCase, outputDirectory);
if (dryRun) {
  console.log(JSON.stringify(plan, null, 2));
} else if (verifyLocal) {
  assertReceiptTargetSafe(outputDirectory);
  const inventory = validateLocalInventory(referenceCase, outputDirectory);
  if (inventory.errors.length > 0) {
    throw new Error(`local NetCDF inventory failed:\n${inventory.errors.join('\n')}`);
  }
  console.log(`verified ${inventory.fileCount} planned NetCDF files; file contents were not inspected`);
} else {
  const outputExists = assertDirectoryPathSafe(outputDirectory, 'acquisition output', true);
  if (outputExists) filesBelow(outputDirectory);
  for (const product of PRODUCTS) {
    assertDirectoryPathSafe(path.join(outputDirectory, product.prefix), `${product.prefix} output`, true);
  }
  assertReceiptTargetSafe(outputDirectory, true);
  for (const step of plan) {
    const result = spawnSync(step.command, step.args, { stdio: 'inherit' });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) throw new Error(`AWS CLI failed with status ${result.status}`);
  }
  await writeChecksumReceipt(referenceCase, outputDirectory);
}
