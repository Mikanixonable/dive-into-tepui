// Acquire every GOES ABI frame and matching cloud product needed by one manifest case.
// The command intentionally keeps source NetCDF files; spatial cropping belongs to the
// observation operator so checksum receipts continue to identify NOAA's originals.
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
  throw new Error('usage: node tools/cloud-reference/acquire.mjs [--dry-run] <case-id> <output-directory>');
}

function utcHourParts(date) {
  const year = date.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const dayOfYear = Math.floor((date.getTime() - yearStart) / 86_400_000) + 1;
  return {
    year: String(year),
    day: String(dayOfYear).padStart(3, '0'),
    hour: String(date.getUTCHours()).padStart(2, '0'),
  };
}

function seriesHours(series) {
  const startMs = Date.parse(series.start);
  const endMs = Date.parse(series.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
    throw new Error('manifest case has an invalid UTC series');
  }
  const firstHourMs = Math.floor(startMs / 3_600_000) * 3_600_000;
  const lastHourMs = Math.floor(endMs / 3_600_000) * 3_600_000;
  const hours = [];
  for (let hourMs = firstHourMs; hourMs <= lastHourMs; hourMs += 3_600_000) {
    hours.push(utcHourParts(new Date(hourMs)));
  }
  return hours;
}

function acquisitionPlan(referenceCase, outputDirectory) {
  const satelliteMatch = /^GOES-(\d+) ABI /.exec(referenceCase.source.product);
  if (referenceCase.source.provider !== 'NOAA' || satelliteMatch === null) {
    throw new Error(`case ${referenceCase.id} is not a supported NOAA GOES ABI source`);
  }
  const satellite = `G${satelliteMatch[1]}`;
  const bucket = `noaa-goes${satelliteMatch[1]}`;
  const commands = [];
  for (const hour of seriesHours(referenceCase.series)) {
    const scanPrefix = `${hour.year}${hour.day}${hour.hour}`;
    for (const product of products) {
      commands.push({
        command: 'aws',
        args: [
          's3', 'cp',
          `s3://${bucket}/${product.prefix}/${hour.year}/${hour.day}/${hour.hour}/`,
          path.join(outputDirectory, product.prefix),
          '--recursive', '--no-sign-request', '--exclude', '*',
          ...product.filenameProducts.flatMap((name) => [
            '--include', `OR_ABI-${name}_${satellite}_s${scanPrefix}*.nc`,
          ]),
        ],
      });
    }
  }
  return commands;
}

function filesBelow(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const candidate = path.join(directory, entry);
    if (statSync(candidate).isDirectory()) files.push(...filesBelow(candidate));
    else files.push(candidate);
  }
  return files;
}

async function checksum(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeChecksumReceipt(outputDirectory) {
  const files = filesBelow(outputDirectory).filter((filename) => filename.endsWith('.nc')).sort();
  for (const product of products) {
    if (!files.some((filename) => path.relative(outputDirectory, filename).startsWith(`${product.prefix}/`))) {
      throw new Error(`download produced no ${product.prefix} NetCDF files`);
    }
  }
  const lines = [];
  for (const filename of files) {
    lines.push(`${await checksum(filename)}  ${path.relative(outputDirectory, filename)}`);
  }
  writeFileSync(path.join(outputDirectory, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}

const args = process.argv.slice(2);
const dryRun = args[0] === '--dry-run';
if (dryRun) args.shift();
if (args.length !== 2) usage();
const [caseId, outputArgument] = args;
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const referenceCase = manifest.cases.find((candidate) => candidate.id === caseId);
if (referenceCase === undefined) throw new Error(`unknown cloud reference case: ${caseId}`);
const outputDirectory = path.resolve(root, outputArgument);
const plan = acquisitionPlan(referenceCase, outputDirectory);
if (dryRun) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  for (const step of plan) {
    const result = spawnSync(step.command, step.args, { stdio: 'inherit' });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) throw new Error(`AWS CLI failed with status ${result.status}`);
  }
  await writeChecksumReceipt(outputDirectory);
}
