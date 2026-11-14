// MODIS Terra の雲頂高度 (MOD06_L2 cloud_top_height_1km、[m]、0〜18000) を NASA GIBS
// WMS から .cloud-lab/reference-cloudtop/ へ取り込み、色を高度へ戻して manifest.json を
// 書く。層は日次 (1 日 1 回の昼間通過) なので 7 地域とも同じ日 (2026-11-08) で取る。
// 箱は compare の cap 統計と同じ広がり (362 px × 8.5 km/px の正方形) で、生成の雲頂と
// 同じ地理を比べる。既にある枠は取り直さない。モデル・距離定義には触れない。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';
import { cloudTopStats } from './cloud-top-stats.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.cloud-lab', 'reference-cloudtop');

const WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
const LAYER = 'MODIS_Terra_Cloud_Top_Height_Day';
const COLORMAP_URL = 'https://gibs.earthdata.nasa.gov/colormaps/v1.3/MODIS_VIIRS_Cloud_Top_Height.xml';
// MODIS は日次なので時刻は日付だけ。Phase 2 / Slice B と同じ 2026-11-08。
const DATE = '2026-11-08';
// 1° あたりの km (緯度方向)。経度方向は cos(緯度) で割る。
const KM_PER_DEG = 111.32;
// compare の cap 統計の箱 (CAP_BOX 362 px × CAP_KM_PER_PX 8.5 km/px) と同じ一辺 [km]。
const BOX_KM = 3077;
// 取り込むフレームの画素数 (正方形)。1 px あたり約 3.2 km — MODIS の公称 1 km より粗いが、
// 雲頂の分布を比べるには十分で、生成側 (8.5 km/px) より細かい。
const FRAME_PX = 960;

// compare の REGIONS と同じ中心。coreRadiusKm は雲頂を中心と外側に分ける半径 [km]
// (台風だけ。compare の cloudTop 節と同じ分け方)。
const REGIONS = [
  { name: 'npac-storm', label: '北太平洋の暴風帯(45N 170W)', lat: 45, lon: -170, coreRadiusKm: null },
  { name: 'natl-storm', label: '北大西洋の暴風帯(50N 30W)', lat: 50, lon: -30, coreRadiusKm: null },
  { name: 'so-ocean', label: '南大洋(55S 100E)', lat: -55, lon: 100, coreRadiusKm: null },
  { name: 'sepac-subtrop', label: '南東太平洋の亜熱帯高圧帯(20S 85W)', lat: -20, lon: -85, coreRadiusKm: null },
  { name: 'sahara', label: 'サハラ(22N 10E)', lat: 22, lon: 10, coreRadiusKm: null },
  { name: 'itcz-atl', label: '大西洋の収束帯(5N 25W)', lat: 5, lon: -25, coreRadiusKm: null },
  { name: 'typhoon', label: '熱帯低気圧(19N 136E)', lat: 19, lon: 136, coreRadiusKm: 250 },
];
// 日付変更線を跨ぐ箱は GIBS が受け付けない (npac-storm: 西端が -180° を超える) ため、
// 東西に割って 2 回取り、画素を横に繋いで 1 枚にする。中心は動かさない。
// 雲頂の色分け: GIBS の公開カラーマップ MODIS_VIIRS_Cloud_Top_Height (50 m 刻み、
// 0〜12000 m)。12000 m 以上は 1 色 (102,0,119) に潰れるので、上限で切れた値として扱う。
// 黒 (0,0,0) は雲の無い画素 (MODIS の雲マスクが晴れ) で、高度は無い。
const ABOVE_MAX_RGB = '102,0,119';
const ABOVE_MAX_M = 12000;
const CLEAR_RGB = '0,0,0';
const NODATA_RGB = '220,220,255';

// 地域の中心に、compare の cap 統計と同じ広がりの緯度経度箱を切る。
function boxFor(region) {
  const halfLat = BOX_KM / 2 / KM_PER_DEG;
  const halfLon = BOX_KM / 2 / (KM_PER_DEG * Math.cos((region.lat * Math.PI) / 180));
  return { south: region.lat - halfLat, north: region.lat + halfLat, west: region.lon - halfLon, east: region.lon + halfLon };
}

// GIBS WMS の GetMap の URL。BBOX は南・西・北・東(緯度・経度の順)。
function frameUrl(box, width, height) {
  return `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${LAYER}&CRS=EPSG:4326`
    + `&BBOX=${box.south.toFixed(4)},${box.west.toFixed(4)},${box.north.toFixed(4)},${box.east.toFixed(4)}`
    + `&WIDTH=${width}&HEIGHT=${height}&FORMAT=image/png&TIME=${DATE}&TRANSPARENT=FALSE`;
}

// URL の取得。回線の瞬断では失敗しないよう、失敗したら 3 回まで取り直す。
async function fetchBytes(url, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (e) {
      lastError = e;
      console.log(`${label}: 取得に失敗(${e.message}) — ${attempt}/3 回目、取り直す`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw new Error(`${label}: 3 回取り直しても取得できない(${url}): ${lastError.message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// 公開カラーマップを読む。値の段 (50 m 刻み) が 0〜12000 m を隙間なく覆い、色が重ならない
// ことを確かめ、色 → 段の下端 [m] の表を返す。形が変わっていたら、黙って誤読しないよう投げる。
function parseColormap(xml) {
  const entries = [...xml.matchAll(
    /<ColorMapEntry rgb="([\d,]+)" transparent="(\w+)" sourceValue="\[(-?\d+),(-?\d+)\)"/g,
  )];
  const valueEntries = entries.filter((e) => e[2] === 'false');
  const fillEntries = entries.filter((e) => e[2] === 'true');
  if (fillEntries.length !== 1 || fillEntries[0][1] !== NODATA_RGB) {
    throw new Error(`カラーマップの無データ色が想定と違う: ${JSON.stringify(fillEntries.map((e) => e[1]))}`);
  }
  const bins = valueEntries.map((e) => ({ rgb: e[1], lo: +e[3], hi: +e[4] })).sort((a, b) => a.lo - b.lo);
  if (bins.length !== 240 || bins[0].lo !== 0 || bins[bins.length - 1].hi !== ABOVE_MAX_M) {
    throw new Error(`カラーマップの段数が想定と違う: ${bins.length} 段、${bins[0]?.lo}〜${bins[bins.length - 1]?.hi} m`);
  }
  for (let i = 1; i < bins.length; i++) {
    if (bins[i].lo !== bins[i - 1].hi || bins[i].hi - bins[i].lo !== 50) {
      throw new Error(`カラーマップの段が 50 m 刻みで連続していない: ${bins[i - 1].lo}〜${bins[i - 1].hi} の次が ${bins[i].lo}〜${bins[i].hi}`);
    }
  }
  const byRgb = new Map(bins.map((b) => [b.rgb, b.lo]));
  if (byRgb.size !== bins.length) throw new Error('カラーマップに重なった色がある');
  return byRgb;
}

// 2 つの PNG を横に繋いで 1 枚の RGB 画素列にする (日付変更線を跨ぐ箱用)。
function stitchHorizontal(parts) {
  const width = parts.reduce((sum, part) => sum + part.width, 0);
  const height = parts[0].height;
  const data = new Uint8Array(width * height * 3);
  for (const part of parts) {
    if (part.height !== height) throw new Error('繋ぐ PNG の高さが違う');
  }
  let x0 = 0;
  for (const part of parts) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < part.width; x++) {
        const from = (y * part.width + x) * part.channels;
        const to = (y * width + x0 + x) * 3;
        data[to] = part.data[from];
        data[to + 1] = part.data[from + 1];
        data[to + 2] = part.data[from + 2];
      }
    }
    x0 += part.width;
  }
  return { width, height, channels: 3, data };
}

// 1 地域の箱を取る。日付変更線を跨ぐ場合は東西に割って取り、横に繋ぐ。返すのは、
// 保存する PNG のバイト列の並びと、繋いだ後の画素列。
async function fetchBox(region, box) {
  const totalLon = box.east - box.west;
  const spans = box.west >= -180
    ? [{ west: box.west, east: box.east }]
    : [{ west: box.west + 360, east: 180 }, { west: -180, east: box.east }];
  const widths = spans.map((span, i) => (i === spans.length - 1
    ? FRAME_PX - spans.slice(0, i).reduce((s, p) => s + Math.round(FRAME_PX * (p.east - p.west) / totalLon), 0)
    : Math.round(FRAME_PX * (span.east - span.west) / totalLon)));
  const files = [];
  const parts = [];
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const file = spans.length === 1
      ? `${region.name}-cloudtop.png`
      : `${region.name}-cloudtop-${String.fromCharCode(97 + i)}.png`;
    const target = path.join(outDir, file);
    let bytes;
    if (existsSync(target)) {
      bytes = new Uint8Array(readFileSync(target));
      console.log(`skip ${file}(既にある)`);
    } else {
      const url = frameUrl({ ...box, west: span.west, east: span.east }, widths[i], FRAME_PX);
      bytes = await fetchBytes(url, file);
      writeFileSync(target, bytes);
      console.log(`fetched ${file}`);
    }
    const decoded = decodePng(Buffer.from(bytes));
    if (decoded.width !== widths[i] || decoded.height !== FRAME_PX) {
      throw new Error(`${file}: 画素数が想定と違う (${decoded.width}×${decoded.height}、想定 ${widths[i]}×${FRAME_PX})`);
    }
    parts.push(decoded);
    files.push({ file: path.posix.join('.cloud-lab', 'reference-cloudtop', file), sha256: sha256(bytes) });
  }
  const stitched = spans.length === 1 ? parts[0] : stitchHorizontal(parts);
  return { files, pixels: stitched };
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const colormapPath = path.join(outDir, 'colormap.xml');
  let colormapXml;
  if (existsSync(colormapPath)) {
    colormapXml = readFileSync(colormapPath, 'utf8');
    console.log('colormap.xml は既にある(使い回す)');
  } else {
    const bytes = await fetchBytes(COLORMAP_URL, 'colormap.xml');
    colormapXml = Buffer.from(bytes).toString('utf8');
    writeFileSync(colormapPath, colormapXml);
    console.log('fetched colormap.xml');
  }
  const byRgb = parseColormap(colormapXml);
  const kmPerPx = BOX_KM / FRAME_PX;
  const frames = [];
  for (const region of REGIONS) {
    const box = boxFor(region);
    const { files, pixels } = await fetchBox(region, box);
    const { top, coverage, counts } = invertPixels(pixels, byRgb);
    if (counts.cloudy === 0) {
      throw new Error(`${region.name}: 雲のある画素が 0 — ${DATE} に GIBS の ${LAYER} が無い。日付を新しくして取り直すこと`);
    }
    const stats = [{ part: 'all', stats: cloudTopStats(top, coverage, kmPerPx, null) }];
    if (region.coreRadiusKm !== null) {
      const capCenter = (FRAME_PX - 1) / 2;
      const radius = region.coreRadiusKm / kmPerPx;
      const maskFor = (within) => Uint8Array.from({ length: FRAME_PX * FRAME_PX }, (_, i) => {
        const inside = Math.hypot((i % FRAME_PX) - capCenter, Math.floor(i / FRAME_PX) - capCenter) <= radius;
        return inside === within ? 1 : 0;
      });
      stats.length = 0;
      stats.push(
        { part: 'core', stats: cloudTopStats(top, coverage, kmPerPx, maskFor(true)) },
        { part: 'outside', stats: cloudTopStats(top, coverage, kmPerPx, maskFor(false)) },
      );
    }
    const frame = {
      region: region.name, files, timeUtc: DATE, box,
      kmPerPx, width: FRAME_PX, height: FRAME_PX, pixelCounts: counts, stats,
    };
    console.log(`${region.name}: 雲 ${(counts.cloudy / counts.total * 100).toFixed(1)}%・`
      + `中央値 ${(stats[0].stats.median / 1000).toFixed(1)} km・12000 m 以上 ${(counts.censoredAbove12000 / counts.total * 100).toFixed(1)}%`);
    frames.push(frame);
  }
  const manifest = {
    tool: 'cloud-lab-reference-cloudtop',
    source: 'NASA GIBS WMS (epsg4326/best)',
    layer: LAYER,
    date: DATE,
    colormap: {
      url: COLORMAP_URL,
      sha256: sha256(new TextEncoder().encode(colormapXml)),
      entries: 240,
      valueMinM: 0,
      valueMaxM: ABOVE_MAX_M,
      censoredClassM: ABOVE_MAX_M,
    },
    boxKm: BOX_KM,
    kmPerPx,
    framePx: FRAME_PX,
    notes: [
      '箱は compare の cap 統計と同じ広がり (362 px × 8.5 km/px = 3077 km の正方形) で、生成の雲頂と同じ地理を比べる。',
      'npac-storm の箱は日付変更線を跨ぐため東西に割って 2 回取り、横に繋いで 1 枚にした (中心は動かしていない)。',
      '色 → 高度は GIBS の公開カラーマップ MODIS_VIIRS_Cloud_Top_Height (50 m 刻み、0〜12000 m) で戻した。12000 m 以上は 1 色に潰れるため 12000 m として数えた (上限で切れている)。',
      '黒は雲の無い画素 (MODIS の雲マスクが晴れ)。生成側の「雲がある」は被覆率 > 0.3、実写側は MODIS の雲マスクで、定義が違う — 雲のある面積のずれはこの family では比べず、capMeans と zonal が担う。',
      '生成の雲頂は焼き場の G チャネル (0..1) × 15000 m で、雲底 1000 m から圏界面 (赤道 17000 m・極 9000 m) までの物理的な高さ [m] である。MODIS の 0〜18000 m と同じ単位で直接比べられる。',
    ],
    regions: REGIONS.map(({ name, label, lat, lon, coreRadiusKm }) => ({ name, label, lat, lon, coreRadiusKm })),
    frames,
  };
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${path.posix.join('.cloud-lab', 'reference-cloudtop', 'manifest.json')} (${frames.length} frames)`);
}

// decodePng の結果 (画素列) を高度へ戻す。
function invertPixels(pixels, byRgb) {
  const { width, height, channels, data } = pixels;
  const top = { width, height, data: new Float32Array(width * height) };
  const coverage = { width, height, data: new Float32Array(width * height) };
  const counts = { total: width * height, cloudy: 0, clear: 0, nodata: 0, censoredAbove12000: 0 };
  const unknown = new Map();
  for (let p = 0; p < width * height; p++) {
    const i = p * channels;
    const rgb = `${data[i]},${data[i + 1]},${data[i + 2]}`;
    if (rgb === CLEAR_RGB) { counts.clear++; continue; }
    if (rgb === NODATA_RGB) { counts.nodata++; continue; }
    if (rgb === ABOVE_MAX_RGB) {
      top.data[p] = ABOVE_MAX_M;
      coverage.data[p] = 1;
      counts.cloudy++;
      counts.censoredAbove12000++;
      continue;
    }
    const lo = byRgb.get(rgb);
    if (lo === undefined) {
      unknown.set(rgb, (unknown.get(rgb) ?? 0) + 1);
      continue;
    }
    top.data[p] = lo + 25;
    coverage.data[p] = 1;
    counts.cloudy++;
  }
  if (unknown.size > 0) {
    const topUnknown = [...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    throw new Error(`カラーマップに無い色が ${[...unknown.values()].reduce((a, b) => a + b, 0)} 画素ある: `
      + `${JSON.stringify(topUnknown)} — カラーマップが変わった可能性があるため中断する`);
  }
  return { top, coverage, counts };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
