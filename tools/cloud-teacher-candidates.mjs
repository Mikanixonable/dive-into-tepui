// 巻雲の教師候補の実写を NASA Worldview から .cloud-detail/candidates/ へ取り込み、
// 型ごとのコンタクトシートと番号対応表(index.json / index.md)を書く。候補表は
// ファイル内の GROUPS。各候補を 1 km/px・512×512(約 512 km 四方)で取り、取れた
// 画像を型ごとに 4 列 × 3 行で並べた sheet-<型>-<n>.png を書く。各タイルの左上へ
// 型内の通し番号を描き、番号と候補の対応を index.json / index.md へ残す。
// 既にある画像は取り直さない。全面が黒い日(欠測)と再試行しても取れない日は記録して飛ばす。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng, encodeRgbPng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.cloud-detail', 'candidates');

// 緯度経度 1° の長さ [km]。km/px の指定は公称値なので、BBOX の換算も近似値で足りる。
const KM_PER_DEGREE = 111.32;
// 真色スナップショットの層と取り方。層は tools/cloud-detail-reference.mjs と同じ
// Worldview Snapshots API の可視真色で、MODIS Terra は候補の全日付(2023-2024)を持つ。
const LAYER = 'MODIS_Terra_CorrectedReflectance_TrueColor';
const KM_PER_PX = 1;
const SIZE = 512;
const TILE = 384;
const SHEET_COLS = 4;
const SHEET_ROWS = 3;
// Worldview へのリクエスト間隔 [ms]。1 秒に 2 回程度までに抑える。
const REQUEST_INTERVAL = 500;

// 候補表。緯度は南半球を負、経度は西経を負で書く。型の見立てどおりの中身とは限らないので、
// 全部取って一覧へ載せる。
const GROUPS = [
  { type: 'streak', letter: 'A', name: '筋状(ジェット気流の巻雲)', regions: [
    { name: 'arabia', latitude: 26, longitude: 40, dates: ['2023-12-20', '2024-01-10', '2024-01-25', '2024-02-14'] },
    { name: 'japan-pacific', latitude: 32, longitude: 140, dates: ['2023-12-28', '2024-01-15', '2024-02-02'] },
    { name: 'natl-subtropics', latitude: 30, longitude: -45, dates: ['2024-01-20', '2024-02-10', '2023-12-12'] },
    { name: 'australia', latitude: -30, longitude: 135, dates: ['2023-07-10', '2023-07-25', '2023-08-12'] },
    { name: 's-africa-indian', latitude: -35, longitude: 50, dates: ['2023-07-05', '2023-07-20'] },
    { name: 'mexico-swus', latitude: 28, longitude: -108, dates: ['2023-12-15', '2024-01-05'] },
  ] },
  { type: 'billow', letter: 'B', name: '鱗雲状・波状(山の風下・弱い風の高気圧)', regions: [
    { name: 'rockies-lee', latitude: 40, longitude: -103, dates: ['2023-04-10', '2023-11-12', '2024-03-05'] },
    { name: 'patagonia-lee', latitude: -42, longitude: -68, dates: ['2023-09-02', '2023-10-05', '2024-01-12'] },
    { name: 'scandinavia', latitude: 61, longitude: 8, dates: ['2023-04-15', '2023-10-20', '2024-03-25'] },
    { name: 'tibet', latitude: 33, longitude: 85, dates: ['2023-12-10', '2024-02-20'] },
    { name: 'mediterranean', latitude: 37, longitude: 15, dates: ['2023-05-12', '2023-10-02', '2024-04-08'] },
    { name: 'tasman-nz', latitude: -43, longitude: 168, dates: ['2023-09-15', '2024-02-05'] },
  ] },
  { type: 'veil', letter: 'C', name: '薄いベール・広がる巻雲(温暖前線の前、熱帯の薄い巻雲)', regions: [
    { name: 'natl-warmfront', latitude: 52, longitude: -25, dates: ['2023-11-20', '2024-01-02', '2024-02-12'] },
    { name: 'npac-front', latitude: 45, longitude: -160, dates: ['2023-12-05', '2024-03-12'] },
    { name: 'southern-ocean', latitude: -50, longitude: 80, dates: ['2023-07-18', '2023-08-20'] },
    { name: 'warmpool-thin', latitude: -3, longitude: 80, dates: ['2023-12-12', '2024-01-28'] },
  ] },
  { type: 'anvil', letter: 'D', name: '金床(深い対流の巻雲)', regions: [
    { name: 'congo', latitude: -2, longitude: 22, dates: ['2023-03-20', '2023-11-10'] },
    { name: 'bengal', latitude: 14, longitude: 88, dates: ['2023-05-18', '2023-10-15'] },
    { name: 'maritime-continent', latitude: 0, longitude: 115, dates: ['2023-12-22', '2024-01-18'] },
    { name: 'great-plains', latitude: 37, longitude: -98, dates: ['2023-05-25', '2023-06-18'] },
  ] },
  { type: 'scaly', letter: 'E', name: '鱗雲状・波状の追加探索(中緯度の海と山の風下の寒候期)', regions: [
    { name: 'natl-ridge', latitude: 45, longitude: -30, dates: ['2023-03-14', '2023-04-18', '2023-09-05', '2023-10-10', '2023-11-14', '2023-12-19', '2024-01-23', '2024-02-27'] },
    { name: 'natl-warmfront2', latitude: 52, longitude: -25, dates: ['2023-03-14', '2023-04-18', '2023-09-05', '2023-10-10', '2023-12-19', '2024-01-23', '2024-02-27', '2023-10-28'] },
    { name: 'biscay', latitude: 47, longitude: -10, dates: ['2023-03-14', '2023-04-18', '2023-09-05', '2023-10-10', '2023-11-14', '2023-12-19', '2024-01-23', '2024-02-27'] },
    { name: 'npac-ridge', latitude: 40, longitude: -170, dates: ['2023-03-14', '2023-04-18', '2023-09-05', '2023-10-10', '2023-11-14', '2023-12-19', '2024-01-23', '2024-02-27'] },
    { name: 'npac-gulf', latitude: 50, longitude: -145, dates: ['2023-03-14', '2023-04-18', '2023-09-05', '2023-10-10', '2023-11-14', '2023-12-19', '2024-01-23', '2024-02-27'] },
    { name: 'kamchatka-lee', latitude: 55, longitude: 160, dates: ['2023-03-14', '2023-04-18', '2023-09-05', '2023-10-10', '2023-11-14', '2023-12-19', '2024-01-23', '2024-02-27'] },
    { name: 'greenland-lee', latitude: 66, longitude: -35, dates: ['2023-03-14', '2023-04-18', '2023-09-05', '2023-10-10', '2023-11-14', '2023-12-19', '2024-01-23', '2024-02-27'] },
    { name: 'southern-ocean-a', latitude: -48, longitude: 40, dates: ['2023-03-14', '2023-04-18', '2023-05-22', '2023-06-26', '2023-08-01', '2023-09-05', '2023-10-10', '2023-11-14'] },
    { name: 'southern-ocean-b', latitude: -52, longitude: -120, dates: ['2023-03-14', '2023-04-18', '2023-05-22', '2023-06-26', '2023-08-01', '2023-09-05', '2023-10-10', '2023-11-14'] },
    { name: 'andes-lee', latitude: -36, longitude: -66, dates: ['2023-03-14', '2023-04-18', '2023-05-22', '2023-06-26', '2023-08-01', '2023-09-05', '2023-10-10', '2023-11-14'] },
  ] },
];

// Worldview Snapshots API の URL。BBOX の並びは south,west,north,east。
function snapshotUrl(region, date) {
  const halfKm = (KM_PER_PX * SIZE) / 2;
  const halfLatitude = halfKm / KM_PER_DEGREE;
  const halfLongitude = halfKm / (KM_PER_DEGREE * Math.cos((region.latitude * Math.PI) / 180));
  const bbox = {
    south: region.latitude - halfLatitude,
    west: region.longitude - halfLongitude,
    north: region.latitude + halfLatitude,
    east: region.longitude + halfLongitude,
  };
  return 'https://wvs.earthdata.nasa.gov/api/v1/snapshot?REQUEST=GetSnapshot'
    + `&TIME=${date}T00:00:00Z&BBOX=${bbox.south},${bbox.west},${bbox.north},${bbox.east}`
    + `&CRS=EPSG:4326&LAYERS=${LAYER}&WRAP=day&FORMAT=image/png`
    + `&WIDTH=${SIZE}&HEIGHT=${SIZE}`;
}

// 前のリクエストから REQUEST_INTERVAL 以上あくまで待つ。
let lastRequestAt = 0;
async function throttle() {
  const wait = REQUEST_INTERVAL - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

// 1 枚の取得。回線の瞬断や HTTP エラーでは、再試行を 2 回まで行う。
async function fetchSnapshot(url, id) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await throttle();
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes[0] !== 0x89 || bytes[1] !== 0x50) {
        throw new Error(`PNG でない応答(先頭: ${Buffer.from(bytes.subarray(0, 120)).toString('utf8')})`);
      }
      return bytes;
    } catch (e) {
      lastError = e;
      console.log(`${id}: 取得に失敗(${e.message}) — ${attempt}/3 回目`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw lastError;
}

// 画素のうち値のある画素(RGB の最大が黒レベルを超える)の割合。GIBS の欠測・観測幅の外は
// (0,0,0) で返るので、全面が黒いならその日はデータが無い。
function coveredFraction(png) {
  let covered = 0;
  const total = png.width * png.height;
  for (let i = 0; i < total; i++) {
    const o = i * png.channels;
    if (Math.max(png.data[o], png.data[o + 1] ?? 0, png.data[o + 2] ?? 0) >= 16) covered++;
  }
  return covered / total;
}

// PNG の decode 結果から中心の size×size を切り出し、先頭 3 byte を RGB として取り出す。
// 並べる元は同じ km/px どうしなので拡縮しない。
function centerTileRgb(png, size) {
  const x0 = Math.floor((png.width - size) / 2);
  const y0 = Math.floor((png.height - size) / 2);
  const out = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = ((y + y0) * png.width + (x + x0)) * png.channels;
      const dst = (y * size + x) * 3;
      out[dst] = png.data[src];
      out[dst + 1] = png.data[Math.min(src + 1, src + png.channels - 1)];
      out[dst + 2] = png.data[Math.min(src + 2, src + png.channels - 1)];
    }
  }
  return out;
}

// 数字の 5×7 ビットマップ。コンタクトシートの番号描画専用。
const FONT_SCALE = 3;
const FONT = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['01110', '10001', '00001', '00110', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

// size×size の RGB タイルの左上へ番号を描く。黒い縁取り付きの白文字にして、
// 明るい雲の上でも暗い海面の上でも読めるようにする。
function stampNumber(rgb, size, number) {
  const lit = [];
  [...String(number)].forEach((char, i) => {
    const rows = FONT[char];
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < rows[y].length; x++) {
        if (rows[y][x] === '1') {
          lit.push({ x: 6 + i * 6 * FONT_SCALE + x * FONT_SCALE, y: 6 + y * FONT_SCALE });
        }
      }
    }
  });
  paint(rgb, size, lit, [0, 0, 0], 1);
  paint(rgb, size, lit, [255, 255, 255], 0);
}

// 文字の点灯画素列へ、lit の各画素を中心とする (FONT_SCALE+2×grow)×同 の色ブロックを描く。
// grow=1 で縁取り、grow=0 で本体を描く。
function paint(rgb, size, lit, color, grow) {
  for (const p of lit) {
    for (let dy = -grow; dy < FONT_SCALE + grow; dy++) {
      for (let dx = -grow; dx < FONT_SCALE + grow; dx++) {
        const x = p.x + dx;
        const y = p.y + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const o = (y * size + x) * 3;
        rgb[o] = color[0];
        rgb[o + 1] = color[1];
        rgb[o + 2] = color[2];
      }
    }
  }
}

// RGB タイルの列を SHEET_COLS×SHEET_ROWS に並べた 1 枚の RGB へ。空きマスは黒のまま。
function contactSheet(tiles) {
  const width = SHEET_COLS * TILE;
  const height = SHEET_ROWS * TILE;
  const out = new Uint8Array(width * height * 3);
  tiles.forEach((tile, i) => {
    const tx = (i % SHEET_COLS) * TILE;
    const ty = Math.floor(i / SHEET_COLS) * TILE;
    for (let y = 0; y < TILE; y++) {
      out.set(tile.subarray(y * TILE * 3, (y + 1) * TILE * 3), ((ty + y) * width + tx) * 3);
    }
  });
  return { width, height, data: out };
}

// 番号対応表の index.md を組み立てる。
function indexMarkdown(grouped, skipped) {
  const lines = [
    '# 巻雲 教師候補の一覧',
    '',
    `層: ${LAYER} / ${KM_PER_PX} km/px / ${SIZE}×${SIZE}(約 ${SIZE} km 四方)`,
    '',
    '番号は各シートのタイル左上の番号。有効率は欠測(黒)でない画素の割合。',
    '',
  ];
  for (const { group, entries } of grouped) {
    const sheets = [...new Set(entries.map((e) => e.sheet))];
    lines.push(`## ${group.letter} ${group.name} — ${sheets.join(', ')}`, '');
    lines.push('| # | 地域 | 緯度 | 経度 | 日付(UTC) | 有効率 | 画像 | シート |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const e of entries) {
      lines.push(`| ${e.number} | ${e.region} | ${e.latitude} | ${e.longitude} | ${e.date}`
        + ` | ${e.covered.toFixed(2)} | ${e.id}.png | ${e.sheet} |`);
    }
    lines.push('');
  }
  if (skipped.length > 0) {
    lines.push('## 飛ばした候補', '', '| id | 理由 |', '| --- | --- |');
    for (const s of skipped) lines.push(`| ${s.id} | ${s.reason} |`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const taken = [];
  const skipped = [];
  for (const group of GROUPS) {
    for (const region of group.regions) {
      for (const date of region.dates) {
        const id = `${group.type}-${region.name}-${date}`;
        const file = path.join(outDir, `${id}.png`);
        if (existsSync(file)) {
          console.log(`skip ${id}.png(既にある)`);
        } else {
          let bytes;
          try {
            bytes = await fetchSnapshot(snapshotUrl(region, date), id);
          } catch (e) {
            skipped.push({ id, reason: `取得失敗: ${e.message}` });
            console.log(`failed ${id}: ${e.message}`);
            continue;
          }
          const covered = coveredFraction(decodePng(Buffer.from(bytes)));
          if (covered < 0.02) {
            skipped.push({ id, reason: `欠測(全面が黒。有効率 ${covered.toFixed(3)})` });
            console.log(`missing ${id}: 全面が黒(有効率 ${covered.toFixed(3)})`);
            continue;
          }
          writeFileSync(file, bytes);
          console.log(`fetched ${id}.png(有効率 ${covered.toFixed(3)})`);
        }
        taken.push({ group, region, date, id, file });
      }
    }
  }

  // 取れた画像を型ごとに通し番号でシートへ並べる。
  const grouped = [];
  const indexEntries = [];
  for (const group of GROUPS) {
    const entries = [];
    const tiles = [];
    taken.filter((e) => e.group === group).forEach((e, i) => {
      const png = decodePng(readFileSync(e.file));
      const tile = centerTileRgb(png, TILE);
      stampNumber(tile, TILE, i + 1);
      tiles.push(tile);
      entries.push({
        number: i + 1,
        type: group.letter,
        typeName: group.name,
        region: e.region.name,
        latitude: e.region.latitude,
        longitude: e.region.longitude,
        date: e.date,
        covered: coveredFraction(png),
        id: e.id,
        file: path.posix.join('.cloud-detail', 'candidates', `${e.id}.png`),
        sheet: `sheet-${group.type}-${Math.floor(i / (SHEET_COLS * SHEET_ROWS)) + 1}.png`,
      });
    });
    for (let s = 0; s * SHEET_COLS * SHEET_ROWS < tiles.length; s++) {
      const sheet = contactSheet(tiles.slice(s * SHEET_COLS * SHEET_ROWS, (s + 1) * SHEET_COLS * SHEET_ROWS));
      const sheetName = `sheet-${group.type}-${s + 1}.png`;
      writeFileSync(path.join(outDir, sheetName), encodeRgbPng(sheet.width, sheet.height, sheet.data));
      console.log(`wrote ${sheetName}`);
    }
    grouped.push({ group, entries });
    indexEntries.push(...entries);
  }

  const index = {
    tool: 'cloud-teacher-candidates',
    layer: LAYER,
    kmPerPx: KM_PER_PX,
    size: SIZE,
    candidates: indexEntries,
    skipped,
  };
  writeFileSync(path.join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  writeFileSync(path.join(outDir, 'index.md'), indexMarkdown(grouped, skipped));
  console.log(`wrote index.json / index.md(取れた ${indexEntries.length} 枚、飛ばした ${skipped.length} 件)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
