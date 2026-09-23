// Acquire every GOES ABI frame and matching cloud product needed by one manifest case.
// The command intentionally keeps source NetCDF files; spatial cropping belongs to the
// observation operator so checksum receipts continue to identify NOAA's originals.
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const manifestPath = path.join(import.meta.dirname, 'manifest.json');
const products = [
  { prefix: 'ABI-L1b-RadF', filenameProducts: ['L1b-RadF-M6C02', 'L1b-RadF-M6C13'] },
  { prefix: 'ABI-L2-CODF', filenameProducts: ['L2-CODF-M6'] },
  { prefix: 'ABI-L2-ACHAF', filenameProducts: ['L2-ACHAF-M6'] },
  { prefix: 'ABI-L2-ACTPF', filenameProducts: ['L2-ACTPF-M6'] },
  { prefix: 'ABI-L2-ACMF', filenameProducts: ['L2-ACMF-M6'] },
];

function usage() {
  throw new Error('usage: node tools/cloud-reference/acquire.mjs [--dry-run|--verify-local] <case-id> <output-directory>');
}

function utcScanSlotParts(date) {
  const year = date.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const dayOfYear = Math.floor((date.getTime() - yearStart) / 86_400_000) + 1;
  return {
    year: String(year),
    day: String(dayOfYear).padStart(3, '0'),
    hour: String(date.getUTCHours()).padStart(2, '0'),
    minute: String(date.getUTCMinutes()).padStart(2, '0'),
  };
}

function seriesScanSlots(series) {
  const startMs = Date.parse(series.start);
  const endMs = Date.parse(series.end);
  const intervalMinutes = series.intervalMinutes;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs
    || !Number.isInteger(intervalMinutes) || intervalMinutes <= 0
    || startMs % 60_000 !== 0 || endMs % 60_000 !== 0) {
    throw new Error('manifest case has an invalid UTC series');
  }
  const intervalMs = intervalMinutes * 60_000;
  if ((endMs - startMs) % intervalMs !== 0) {
    throw new Error('manifest case series end must align with its scan interval');
  }
  const slots = [];
  for (let slotMs = startMs; slotMs <= endMs; slotMs += intervalMs) {
    slots.push(utcScanSlotParts(new Date(slotMs)));
  }
  return slots;
}

function satelliteOf(referenceCase) {
  const satelliteMatch = /^GOES-(\d+) ABI /.exec(referenceCase.source.product);
  if (referenceCase.source.provider !== 'NOAA' || satelliteMatch === null) {
    throw new Error(`case ${referenceCase.id} is not a supported NOAA GOES ABI source`);
  }
  return `G${satelliteMatch[1]}`;
}

function scanMinutePrefix(slot) {
  return `${slot.year}${slot.day}${slot.hour}${slot.minute}`;
}

function parseNoaaTimestamp(value) {
  const match = /^(\d{4})(\d{3})(\d{2})(\d{2})(\d{3})$/.exec(value);
  if (match === null) return null;
  const [, yearText, dayText, hourText, minuteText, secondTenthsText] = match;
  const year = Number(yearText);
  const dayOfYear = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const secondTenths = Number(secondTenthsText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (year === 0 || dayOfYear < 1 || dayOfYear > (leapYear ? 366 : 365)
    || hour > 23 || minute > 59 || secondTenths > 599) return null;

  // NOAA's final three timestamp digits are seconds to tenths (for example, 208 = 20.8 s).
  const seconds = Math.floor(secondTenths / 10);
  const milliseconds = (secondTenths % 10) * 100;
  const date = new Date(0);
  date.setUTCFullYear(year, 0, 1);
  date.setTime(date.getTime() + (dayOfYear - 1) * 86_400_000);
  date.setUTCHours(hour, minute, seconds, milliseconds);
  const yearStart = new Date(0);
  yearStart.setUTCFullYear(year, 0, 1);
  const actualDayOfYear = Math.floor((date.getTime() - yearStart.getTime()) / 86_400_000) + 1;
  if (date.getUTCFullYear() !== year || actualDayOfYear !== dayOfYear) return null;
  return date.getTime();
}

function plannedNetcdfSelectors(referenceCase) {
  const satellite = satelliteOf(referenceCase);
  return seriesScanSlots(referenceCase.series).flatMap((slot) => products.flatMap((product) => (
    product.filenameProducts.map((name) => ({
      productPrefix: product.prefix,
      filenamePrefix: `OR_ABI-${name}_${satellite}_s${scanMinutePrefix(slot)}`,
    }))
  )));
}

function acquisitionPlan(referenceCase, outputDirectory) {
  const satellite = satelliteOf(referenceCase);
  const bucket = `noaa-goes${satellite.slice(1)}`;
  const slotsByHour = new Map();
  for (const slot of seriesScanSlots(referenceCase.series)) {
    const hourKey = `${slot.year}/${slot.day}/${slot.hour}`;
    const slots = slotsByHour.get(hourKey) ?? [];
    slots.push(slot);
    slotsByHour.set(hourKey, slots);
  }
  const commands = [];
  for (const [hourKey, slots] of slotsByHour) {
    const [year, day, hour] = hourKey.split('/');
    for (const product of products) {
      commands.push({
        command: 'aws',
        args: [
          's3', 'cp',
          `s3://${bucket}/${product.prefix}/${year}/${day}/${hour}/`,
          path.join(outputDirectory, product.prefix),
          '--recursive', '--no-sign-request', '--exclude', '*',
          ...product.filenameProducts.flatMap((name) => slots.flatMap((slot) => [
            '--include', `OR_ABI-${name}_${satellite}_s${scanMinutePrefix(slot)}*.nc`,
          ])),
        ],
      });
    }
  }
  return commands;
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
    const matchingIndexes = selectors.flatMap((selector, index) => {
      if (selector.productPrefix !== productPrefix || !basename.startsWith(selector.filenamePrefix)) return [];
      const suffix = basename.slice(selector.filenamePrefix.length);
      const match = /^(\d{3})_e(\d{14})_c(\d{14})\.nc$/.exec(suffix);
      if (match === null) return [];
      const startMinute = selector.filenamePrefix.slice(selector.filenamePrefix.lastIndexOf('_s') + 2);
      const startTimestamp = parseNoaaTimestamp(`${startMinute}${match[1]}`);
      const endTimestamp = parseNoaaTimestamp(match[2]);
      const creationTimestamp = parseNoaaTimestamp(match[3]);
      if (startTimestamp === null || endTimestamp === null || creationTimestamp === null
        || endTimestamp <= startTimestamp || creationTimestamp < endTimestamp) return [];
      return [index];
    });
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
  for (const product of products) {
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
