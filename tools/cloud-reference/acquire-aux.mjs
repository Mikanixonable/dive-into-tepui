// NASA Worldview の補助参照画像を取得し、取得元 URL と SHA-256 を記録する。
import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '../..');
const CASE_ID = 'tropical-cyclone-mawar-2023-05-25';
const CASE_DIRECTORY = `reference/${CASE_ID}`;
const IMAGE_NAME = 'mawar.png';
const RECEIPT_NAME = 'receipt.json';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

function assertDirectory(directory, label) {
  const status = lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`${label} must be a directory, not a symbolic link or file: ${directory}`);
  }
}

function ensureCaseDirectory(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  assertDirectory(root, 'repository root');
  const referenceDirectory = path.join(root, 'reference');
  try {
    assertDirectory(referenceDirectory, 'reference directory');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    mkdirSync(referenceDirectory);
  }
  const caseDirectory = path.join(root, CASE_DIRECTORY);
  try {
    assertDirectory(caseDirectory, 'auxiliary case directory');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    mkdirSync(caseDirectory);
  }
  return caseDirectory;
}

function readSourceUrl(repositoryRoot) {
  const sourceUrl = readManifestCase(repositoryRoot).source.catalogUrl;
  const parsedUrl = new URL(sourceUrl);
  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'wvs.earthdata.nasa.gov') {
    throw new Error(`manifest has an unexpected NASA Worldview URL: ${sourceUrl}`);
  }
  return sourceUrl;
}

function readManifestCase(repositoryRoot) {
  const manifestPath = path.join(repositoryRoot, 'tools/cloud-reference/manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const referenceCase = manifest.cases.find((entry) => entry.id === CASE_ID);
  if (referenceCase?.source?.provider !== 'NASA') throw new Error(`manifest case is not a NASA reference: ${CASE_ID}`);
  return referenceCase;
}

function writeAtomic(filename, contents) {
  const temporaryPath = `${filename}.${randomUUID()}.partial`;
  try {
    writeFileSync(temporaryPath, contents, { flag: 'wx', mode: 0o600 });
    renameSync(temporaryPath, filename);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

/** Mawar ケースの PNG を保存し、取得 URL と内容 hash の受領記録を返す。 */
export async function acquireMawarReference(repositoryRoot = REPOSITORY_ROOT, fetchImplementation = globalThis.fetch) {
  if (typeof fetchImplementation !== 'function') throw new Error('fetch is unavailable');
  const root = path.resolve(repositoryRoot);
  const sourceUrl = readSourceUrl(root);
  const caseDirectory = ensureCaseDirectory(root);
  const imagePath = path.join(caseDirectory, IMAGE_NAME);
  const receiptPath = path.join(caseDirectory, RECEIPT_NAME);
  for (const destination of [imagePath, receiptPath]) {
    try {
      const status = lstatSync(destination);
      if (status.isSymbolicLink() || !status.isFile()) {
        throw new Error(`auxiliary output must be a regular file: ${destination}`);
      }
      throw new Error(`auxiliary output already exists: ${destination}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const response = await fetchImplementation(sourceUrl, { redirect: 'follow' });
  if (!response.ok) throw new Error(`NASA Worldview request failed with HTTP ${response.status}`);
  const finalUrl = new URL(response.url || sourceUrl);
  if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'wvs.earthdata.nasa.gov') {
    throw new Error(`NASA Worldview redirected to an unexpected URL: ${finalUrl.href}`);
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'image/png') throw new Error(`NASA Worldview returned unexpected content type: ${contentType ?? 'missing'}`);
  const image = Buffer.from(await response.arrayBuffer());
  if (image.length === 0 || image.length > MAX_IMAGE_BYTES) {
    throw new Error(`NASA Worldview image size is invalid: ${image.length} bytes`);
  }
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== image.length)) {
    throw new Error(`NASA Worldview image size does not match Content-Length: ${declaredLength}`);
  }
  if (image.length < PNG_SIGNATURE.length || !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('NASA Worldview response does not have a PNG signature');
  }

  const receipt = {
    sourceUrl,
    finalUrl: finalUrl.href,
    contentType: 'image/png',
    sizeBytes: image.length,
    algorithm: 'sha256',
    sha256: createHash('sha256').update(image).digest('hex'),
  };
  let imageInstalled = false;
  try {
    writeAtomic(imagePath, image);
    imageInstalled = true;
    writeAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    if (imageInstalled) rmSync(imagePath, { force: true });
    throw error;
  }
  return receipt;
}

/** 取得済みの PNG と受領記録を manifest の出典・SHA-256 へ照合する。 */
export function verifyMawarReference(repositoryRoot = REPOSITORY_ROOT) {
  const root = path.resolve(repositoryRoot);
  const referenceCase = readManifestCase(root);
  const caseDirectory = path.join(root, CASE_DIRECTORY);
  assertDirectory(caseDirectory, 'auxiliary case directory');
  const imagePath = path.join(caseDirectory, IMAGE_NAME);
  const receiptPath = path.join(caseDirectory, RECEIPT_NAME);
  for (const destination of [imagePath, receiptPath]) {
    const status = lstatSync(destination);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new Error(`auxiliary output must be a regular file: ${destination}`);
    }
  }
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const image = readFileSync(imagePath);
  const digest = createHash('sha256').update(image).digest('hex');
  if (receipt.sourceUrl !== referenceCase.source.catalogUrl
    || receipt.algorithm !== 'sha256'
    || receipt.contentType !== 'image/png'
    || receipt.sizeBytes !== image.length
    || receipt.sha256 !== digest
    || (referenceCase.source.checksum.value !== null
      && referenceCase.source.checksum.value !== digest)) {
    throw new Error('auxiliary receipt does not match the retained NASA source and manifest checksum');
  }
  if (image.length < PNG_SIGNATURE.length || !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('retained NASA image does not have a PNG signature');
  }
  return { status: 'verified', sizeBytes: image.length, sha256: digest };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--verify-local') {
    try {
      console.log(JSON.stringify(verifyMawarReference(), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } else if (process.argv.length === 2) {
    acquireMawarReference().then((receipt) => {
      console.log(`${receipt.sha256}  ${CASE_DIRECTORY}/${IMAGE_NAME} (${receipt.sizeBytes} bytes)`);
    }).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  } else {
    throw new Error('usage: node tools/cloud-reference/acquire-aux.mjs [--verify-local]');
  }
}
