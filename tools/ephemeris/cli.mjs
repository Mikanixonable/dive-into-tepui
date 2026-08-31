#!/usr/bin/env node
// Small dependency-free (apart from the repository's TypeScript devDependency)
// pack/verify/unpack tool. It loads the browser-safe format module by
// transpiling it in a temporary directory, so the CLI never duplicates the
// binary format implementation.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const toolDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(toolDir, '../..');
const formatSourcePath = join(repoRoot, 'src/physics/ephemeris-pack/format.ts');

const HELP = `
Tepui ephemeris pack tool

Usage:
  node tools/ephemeris/cli.mjs pack <fixture.json> <pack.epk>
  node tools/ephemeris/cli.mjs verify <pack.epk>
  node tools/ephemeris/cli.mjs unpack <pack.epk> <fixture.json>
  node tools/ephemeris/cli.mjs help

The JSON input is a manifest (without series) plus a segments array. Each
segment has body, start, end, and coefficients: [x[], y[], z[]]. Coefficients
are synthetic fixture data in the example; this tool does not download or
invent DE440/DE441 data. The canonical frame is barycentric ICRF/J2000 and
times are J2000 ET seconds on the TDB scale. pack writes the payload SHA-256
into the manifest; verify checks it before reporting the pack as valid.
`;

async function loadFormatModule() {
  const source = await readFile(formatSourcePath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: 'format.ts',
  });
  const tempDir = await mkdtemp(join(tmpdir(), 'tepui-ephemeris-format-'));
  const tempModule = join(tempDir, 'format.mjs');
  await writeFile(tempModule, outputText, 'utf8');
  try {
    return await import(`${pathToFileURL(tempModule).href}?cacheBust=${Date.now()}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function payloadSha256(payloadBytes) {
  return createHash('sha256').update(payloadBytes).digest('hex');
}

function requireDigest(decoded) {
  const expected = decoded.manifest.payloadSha256;
  if (typeof expected !== 'string') throw new Error('manifest has no payloadSha256; this is not a verified generated pack');
  const actual = payloadSha256(decoded.payloadBytes);
  if (actual !== expected) throw new Error(`payload SHA-256 mismatch: expected ${expected}, got ${actual}`);
  return actual;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read JSON fixture ${path}: ${error.message}`);
  }
}

function unpackToJson(decoded) {
  const segments = decoded.manifest.series.map((series) => {
    const start = series.coefficientOffset;
    const degreeValues = series.degree + 1;
    return {
      body: series.body,
      start: series.start,
      end: series.end,
      coefficients: [
        Array.from(decoded.payload.slice(start, start + degreeValues)),
        Array.from(decoded.payload.slice(start + degreeValues, start + 2 * degreeValues)),
        Array.from(decoded.payload.slice(start + 2 * degreeValues, start + 3 * degreeValues)),
      ],
    };
  });
  return { manifest: decoded.manifest, segments };
}

async function pack(format, inputPath, outputPath) {
  const input = await readJson(inputPath);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('fixture must be an object with manifest and segments');
  }
  const { manifest: sourceManifest, segments } = input;
  if (sourceManifest === null || typeof sourceManifest !== 'object' || Array.isArray(sourceManifest)) {
    throw new Error('fixture manifest must be an object');
  }
  const { payloadSha256: _oldDigest, ...manifestBase } = sourceManifest;
  const data = format.buildPackData(manifestBase, segments);
  const digest = payloadSha256(format.encodeFloat64Payload(data.payload));
  const manifest = { ...data.manifest, payloadSha256: digest };
  const bytes = format.encodePack(manifest, data.payload);
  await writeFile(outputPath, bytes);
  console.log(`Packed ${segments.length} segment(s), ${bytes.length} bytes, payload SHA-256 ${digest}`);
}

async function verify(format, inputPath) {
  const decoded = format.decodePack(new Uint8Array(await readFile(inputPath)));
  const digest = requireDigest(decoded);
  console.log(`Verified ${inputPath}: ${decoded.manifest.series.length} segment(s), payload SHA-256 ${digest}`);
}

async function unpack(format, inputPath, outputPath) {
  const decoded = format.decodePack(new Uint8Array(await readFile(inputPath)));
  requireDigest(decoded);
  await writeFile(outputPath, `${JSON.stringify(unpackToJson(decoded), null, 2)}\n`, 'utf8');
  console.log(`Unpacked ${inputPath} to ${outputPath}`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return;
  }
  const format = await loadFormatModule();
  if (command === 'pack' && args.length === 2) return pack(format, resolve(args[0]), resolve(args[1]));
  if (command === 'verify' && args.length === 1) return verify(format, resolve(args[0]));
  if (command === 'unpack' && args.length === 2) return unpack(format, resolve(args[0]), resolve(args[1]));
  process.stderr.write(HELP);
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(`ephemeris pack error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
