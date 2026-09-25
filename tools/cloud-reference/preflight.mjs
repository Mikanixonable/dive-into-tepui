// NOAA 公開 S3 の一覧 metadata だけを使って取得容量を見積もる。

import { readFileSync, statSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesSelectorKey, plannedNetcdfSelectors, satelliteOf } from './selection.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '../..');
const DEFAULT_MAX_KEYS = 1000;
const DEFAULT_CONCURRENCY = 4;

function decodeXml(value) {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(value)) {
    throw new Error('S3 XML contains an unknown or unterminated entity reference');
  }
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity, name) => {
    switch (name.toLowerCase()) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const codePoint = name[1]?.toLowerCase() === 'x'
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
        if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff
          || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
          throw new Error('S3 XML contains an invalid numeric entity reference');
        }
        return String.fromCodePoint(codePoint);
      }
    }
  });
}

function requiredElement(contents, name) {
  const matches = [...contents.matchAll(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'g'))];
  if (matches.length !== 1) throw new Error(`S3 XML must contain exactly one ${name} element`);
  return decodeXml(matches[0][1]);
}

/** ListObjectsV2 の応答を検査し、続きの token と object サイズを返す。 */
export function parseListObjectsV2Xml(xml) {
  if (typeof xml !== 'string' || xml.includes('<!DOCTYPE') || xml.includes('<!ENTITY')) {
    throw new Error('S3 returned an invalid or unsafe XML document');
  }
  if (/<Error(?:\s|>)/.test(xml)) {
    const code = /<Code>([\s\S]*?)<\/Code>/.exec(xml)?.[1] ?? 'unknown';
    const message = /<Message>([\s\S]*?)<\/Message>/.exec(xml)?.[1] ?? 'unknown';
    throw new Error(`S3 returned an error document: ${decodeXml(code)}: ${decodeXml(message)}`);
  }
  if (!/<ListBucketResult(?:\s[^>]*)?>[\s\S]*<\/ListBucketResult>/.test(xml)) {
    throw new Error('S3 response is not a ListObjectsV2 XML document');
  }
  const contentTags = [...xml.matchAll(/<Contents>/g)].length;
  if (contentTags !== [...xml.matchAll(/<\/Contents>/g)].length) {
    throw new Error('S3 XML has unbalanced Contents elements');
  }
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, contents]) => {
    const key = requiredElement(contents, 'Key');
    const sizeText = requiredElement(contents, 'Size');
    if (!/^\d+$/.test(sizeText)) throw new Error(`S3 object has an invalid ContentLength: ${key}`);
    const sizeBytes = Number(sizeText);
    if (!Number.isSafeInteger(sizeBytes)) throw new Error(`S3 object ContentLength exceeds safe integer range: ${key}`);
    return { key, sizeBytes };
  });
  const isTruncatedText = requiredElement(xml, 'IsTruncated');
  if (isTruncatedText !== 'true' && isTruncatedText !== 'false') {
    throw new Error('S3 XML has an invalid IsTruncated value');
  }
  const tokenMatches = [...xml.matchAll(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/g)];
  if (tokenMatches.length > 1) throw new Error('S3 XML contains multiple continuation tokens');
  const continuationToken = tokenMatches.length === 0 ? null : decodeXml(tokenMatches[0][1]);
  if ((isTruncatedText === 'true') !== (continuationToken !== null && continuationToken.length > 0)) {
    throw new Error('S3 XML truncation flag and continuation token disagree');
  }
  return { objects, isTruncated: isTruncatedText === 'true', continuationToken };
}

async function listObjectsV2(bucket, prefix, fetchImplementation, maxKeys) {
  const objects = [];
  const seenTokens = new Set();
  let continuationToken = null;
  do {
    const url = new URL(`https://${bucket}.s3.amazonaws.com/`);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    url.searchParams.set('max-keys', String(maxKeys));
    if (continuationToken !== null) url.searchParams.set('continuation-token', continuationToken);
    const response = await fetchImplementation(url);
    if (!response.ok) throw new Error(`S3 ListObjectsV2 failed with HTTP ${response.status} for ${prefix}`);
    const page = parseListObjectsV2Xml(await response.text());
    objects.push(...page.objects);
    if (!page.isTruncated) break;
    if (seenTokens.has(page.continuationToken)) throw new Error(`S3 repeated a continuation token for ${prefix}`);
    seenTokens.add(page.continuationToken);
    continuationToken = page.continuationToken;
  } while (continuationToken !== null);
  return objects;
}

function selectorDirectory(selector) {
  const match = /_s(\d{4})(\d{3})(\d{2})\d{2}$/.exec(selector.filenamePrefix);
  if (match === null) throw new Error(`invalid planned NOAA selector: ${selector.filenamePrefix}`);
  return `${selector.productPrefix}/${match[1]}/${match[2]}/${match[3]}/`;
}

function selectionGroups(cases, selectorsByCase) {
  const groups = new Map();
  for (const referenceCase of cases) {
    const satellite = satelliteOf(referenceCase);
    const bucket = `noaa-goes${satellite.slice(1)}`;
    for (const entry of selectorsByCase.get(referenceCase.id)) {
      const prefix = selectorDirectory(entry.selector);
      const groupKey = `${bucket}/${prefix}`;
      const group = groups.get(groupKey) ?? { bucket, prefix, selectors: [] };
      group.selectors.push(entry);
      groups.set(groupKey, group);
    }
  }
  return [...groups.values()];
}

function applyObjectToSelectors(object, selectors, matchesBySelector) {
  for (const entry of selectors) {
    if (matchesSelectorKey(entry.selector, object.key)) {
      matchesBySelector.get(entry)?.push(object);
    }
  }
}

function emptyCaseSummary(referenceCase, selectors) {
  return {
    caseId: referenceCase.id,
    expectedFileCount: selectors.length,
    matchedFileCount: 0,
    exactSelectorCount: 0,
    bytes: 0,
    products: Object.fromEntries([...new Set(selectors.map(({ selector }) => selector.productPrefix))]
      .map((productPrefix) => [productPrefix, { expectedFileCount: 0, matchedFileCount: 0, exactSelectorCount: 0, bytes: 0 }])),
    missing: [],
    duplicates: [],
  };
}

/** NOAA の object metadata を照合し、ケース別と全体の必要容量を返す。 */
export async function preflightReferenceCases(cases, {
  fetchImplementation = globalThis.fetch,
  concurrency = DEFAULT_CONCURRENCY,
  maxKeys = DEFAULT_MAX_KEYS,
} = {}) {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('at least one manifest case is required');
  if (typeof fetchImplementation !== 'function') throw new Error('fetch is unavailable');
  if (!Number.isInteger(concurrency) || concurrency <= 0) throw new Error('concurrency must be a positive integer');
  if (!Number.isInteger(maxKeys) || maxKeys <= 0 || maxKeys > DEFAULT_MAX_KEYS) {
    throw new Error(`maxKeys must be between 1 and ${DEFAULT_MAX_KEYS}`);
  }

  const selectorsByCase = new Map(cases.map((referenceCase) => [
    referenceCase.id,
    plannedNetcdfSelectors(referenceCase).map((selector) => ({ caseId: referenceCase.id, selector })),
  ]));
  const allEntries = [...selectorsByCase.values()].flat();
  const matchesBySelector = new Map(allEntries.map((entry) => [entry, []]));
  const groups = selectionGroups(cases, selectorsByCase);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, async () => {
    while (cursor < groups.length) {
      const group = groups[cursor];
      cursor += 1;
      const objects = await listObjectsV2(group.bucket, group.prefix, fetchImplementation, maxKeys);
      for (const object of objects) applyObjectToSelectors(object, group.selectors, matchesBySelector);
    }
  }));

  const summaries = cases.map((referenceCase) => {
    const entries = selectorsByCase.get(referenceCase.id);
    const summary = emptyCaseSummary(referenceCase, entries);
    for (const entry of entries) {
      const files = matchesBySelector.get(entry);
      const product = summary.products[entry.selector.productPrefix];
      product.expectedFileCount += 1;
      if (files.length === 0) {
        summary.missing.push(`${entry.selector.productPrefix}/${entry.selector.filenamePrefix}*.nc`);
        continue;
      }
      summary.matchedFileCount += files.length;
      product.matchedFileCount += files.length;
      if (files.length > 1) {
        summary.duplicates.push({ selector: `${entry.selector.productPrefix}/${entry.selector.filenamePrefix}*.nc`, keys: files.map(({ key }) => key) });
        continue;
      }
      summary.exactSelectorCount += 1;
      product.exactSelectorCount += 1;
      summary.bytes += files[0].sizeBytes;
      product.bytes += files[0].sizeBytes;
    }
    return summary;
  });
  const total = summaries.reduce((aggregate, summary) => ({
    expectedFileCount: aggregate.expectedFileCount + summary.expectedFileCount,
    matchedFileCount: aggregate.matchedFileCount + summary.matchedFileCount,
    exactSelectorCount: aggregate.exactSelectorCount + summary.exactSelectorCount,
    bytes: aggregate.bytes + summary.bytes,
    missingCount: aggregate.missingCount + summary.missing.length,
    duplicateCount: aggregate.duplicateCount + summary.duplicates.length,
  }), { expectedFileCount: 0, matchedFileCount: 0, exactSelectorCount: 0, bytes: 0, missingCount: 0, duplicateCount: 0 });
  return { cases: summaries, total, complete: total.exactSelectorCount === total.expectedFileCount };
}

function availableBytesAt(pathname) {
  let directory = path.resolve(pathname);
  while (true) {
    try {
      if (!statSync(directory).isDirectory()) directory = path.dirname(directory);
      const filesystem = statfsSync(directory);
      return Number(filesystem.bavail) * Number(filesystem.bsize);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(directory);
      if (parent === directory) throw error;
      directory = parent;
    }
  }
}

function usage() {
  return 'usage: node tools/cloud-reference/preflight.mjs <case-id|--all> <output-directory>';
}

async function runCli(args) {
  if (args.length !== 2) throw new Error(usage());
  const [caseSelector, outputArgument] = args;
  const manifest = JSON.parse(readFileSync(`${SCRIPT_DIRECTORY}/manifest.json`, 'utf8'));
  const cases = caseSelector === '--all'
    ? manifest.cases.filter((referenceCase) => referenceCase.source.provider === 'NOAA')
    : manifest.cases.filter((referenceCase) => referenceCase.id === caseSelector);
  if (cases.length === 0) throw new Error(`unknown cloud reference case: ${caseSelector}`);
  const outputDirectory = path.resolve(REPOSITORY_ROOT, outputArgument);
  const result = await preflightReferenceCases(cases);
  const availableBytes = availableBytesAt(outputDirectory);
  const capacity = {
    outputDirectory,
    availableBytes,
    plannedBytes: result.total.bytes,
    remainingBytes: result.complete ? availableBytes - result.total.bytes : null,
  };
  console.log(JSON.stringify({ ...result, capacity }, null, 2));
  if (!result.complete) process.exitCode = 2;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
