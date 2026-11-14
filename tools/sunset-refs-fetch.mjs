// 夕景・昼夜境界の実写参照をパブリックドメインの供給元から取り込む道具。
// NASA 画像 API(images-api.nasa.gov)で検索し、項目の collection.json(images-assets.nasa.gov)
// から適度な大きさの JPG を .cloud-detail/sunset-ref/ へ保存する。出典とライセンスは
// SOURCES.md へ書く。NASA の画像は特記の無い限りパブリックドメイン。
//   使い方: node tools/sunset-refs-fetch.mjs — 引数は無し。
// 取り込み先は git 管理外(.cloud-detail/ は .gitignore 済み)。
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.cloud-detail', 'sunset-ref');

// 許可された供給元のドメイン(指定のものだけ)。
const ALLOWED_HOSTS = new Set([
  'images-api.nasa.gov', 'images-assets.nasa.gov', 'science.nasa.gov',
  'earthobservatory.nasa.gov', 'upload.wikimedia.org',
]);

// 検索語と、その語で採りたい枚数の目安。宇宙からの夕日・縁を優先し、地上の夕空も拾う。
const QUERIES = [
  { q: 'orbital sunset', take: 3, kind: 'space' },
  { q: 'earth limb sunset', take: 2, kind: 'space' },
  { q: 'terminator earth', take: 1, kind: 'space' },
  { q: 'sunset clouds sky', take: 2, kind: 'ground' },
];

// 取り込む画像ファイルの上限。
const MAX_FILES = 8;
const UA = { 'user-agent': 'tepui-sunset-refs/1.0 (image research tool)' };

// URL が許可された供給元のものか。
const isAllowed = (url) => {
  try {
    return ALLOWED_HOSTS.has(new URL(url).host);
  } catch {
    return false;
  }
};

async function fetchJson(url) {
  const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`GET ${url} → ${response.status}`);
  return response.json();
}

async function fetchBytes(url) {
  const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`GET ${url} → ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// collection.json の資産 URL 一覧から、手頃な大きさの JPG を1本選ぶ。
// 原寸(~orig)は巨大になりうるので中〜大サイズを優先する。
function pickAsset(urls) {
  const jpgs = urls.filter((u) => /\.jpe?g$/i.test(u) && isAllowed(u));
  const pref = ['~medium', '~large', '~orig', '~small', '~thumb'];
  for (const token of pref) {
    const hit = jpgs.find((u) => u.includes(token));
    if (hit) return hit;
  }
  return jpgs[0] ?? null;
}

// ファイル名に使う短いスラグ。
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

async function search(q) {
  const url = `https://images-api.nasa.gov/search?q=${encodeURIComponent(q)}&media_type=image&page_size=30`;
  const body = await fetchJson(url);
  return body.collection?.items ?? [];
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const saved = [];   // { file, title, nasaId, assetUrl, pageUrl, center, date, kind }
  const failures = [];
  const seen = new Set();

  for (const { q, take, kind } of QUERIES) {
    if (saved.length >= MAX_FILES) break;
    let items;
    try {
      items = await search(q);
    } catch (e) {
      failures.push(`search "${q}": ${e.message}`);
      continue;
    }
    console.log(`search "${q}": ${items.length} items`);
    let taken = 0;
    for (const item of items) {
      if (taken >= take || saved.length >= MAX_FILES) break;
      const data = item.data?.[0];
      const nasaId = data?.nasa_id;
      if (!nasaId || seen.has(nasaId) || !item.href) continue;
      if (!isAllowed(item.href)) continue;
      seen.add(nasaId);
      try {
        const assets = await fetchJson(item.href);
        const assetUrl = pickAsset(Array.isArray(assets) ? assets : []);
        if (assetUrl === null) throw new Error('collection に JPG が無い');
        const bytes = await fetchBytes(assetUrl);
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
          throw new Error(`JPEG ではない(magic ${bytes[0]?.toString(16)} ${bytes[1]?.toString(16)})`);
        }
        const file = `${nasaId}-${slug(data.title ?? 'untitled')}.jpg`;
        writeFileSync(path.join(outDir, file), bytes);
        saved.push({
          file,
          title: data.title ?? '',
          nasaId,
          assetUrl,
          pageUrl: `https://images.nasa.gov/details/${nasaId}`,
          center: data.center ?? '',
          date: data.date_created ?? '',
          kind,
        });
        taken++;
        console.log(`  saved ${file} (${(bytes.length / 1024).toFixed(0)} KB)`);
      } catch (e) {
        failures.push(`${nasaId} "${data.title ?? ''}": ${e.message}`);
      }
    }
  }

  const lines = [
    '# Sunset / terminator reference photographs',
    '',
    'Fetched by `tools/sunset-refs-fetch.mjs`. Sources are restricted to the allowed domains',
    '(NASA image APIs). NASA imagery is in the public domain unless noted otherwise',
    '(see https://www.nasa.gov/nasa-brand-center/images-and-media/).',
    '',
    '| file | kind | title | NASA ID | center | date | asset | page |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...saved.map((s) => (
      `| ${s.file} | ${s.kind} | ${s.title.replaceAll('|', '/')} | ${s.nasaId}`
      + ` | ${s.center} | ${s.date.slice(0, 10)} | ${s.assetUrl} | ${s.pageUrl} |`
    )),
    '',
    failures.length > 0 ? '## Failures' : '',
    ...failures.map((f) => `- ${f}`),
    '',
  ];
  writeFileSync(path.join(outDir, 'SOURCES.md'), lines.filter((l, i) => !(l === '' && i > 0 && lines[i - 1] === '')).join('\n'));
  console.log(`\n${saved.length} files → ${outDir}`);
  if (failures.length > 0) {
    console.log(`${failures.length} failures:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  if (saved.length < 4) {
    console.error('WARNING: fewer than 4 reference images fetched');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
