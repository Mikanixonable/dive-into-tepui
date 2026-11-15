// 半透明巻雲の教師が共有する NASA GIBS のアクセス層。WMS GetMap の URL 組立・
// 帯域制限つきのキャッシュ取得・カラーマップ解決と色→値の反転・静止衛星の選択と
// 通過時刻の推定・移流(風)推定とマスクの簡易加工をまとめる。
// 取得済みの応答は .cloud-detail/translucent-teacher/cache/ へ置き、同じキーは取り直さない。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';
import { decodeChannelPng } from './gray-image.mjs';
import {
  parseBand13Colormap,
  validateBand13Colormap,
  invertBrightnessTemperature,
} from './cloud-brightness-temperature.mjs';

const root = path.resolve(import.meta.dirname, '..');
export const OUT_DIR = path.join(root, '.cloud-detail', 'translucent-teacher');
export const CACHE_DIR = path.join(OUT_DIR, 'cache');
const CONFIG_FILE = path.join(root, '.loop-translucent-config.json');

export const WMS_URL = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
export const WMTS_URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/wmts.cgi';
export const COLORMAP_BASE = 'https://gibs.earthdata.nasa.gov/colormaps/v1.3/';
// GIBS へのリクエスト間隔 [ms]。1 秒に 2 回程度までに抑える。
const REQUEST_INTERVAL = 500;
// 1° あたりの km(緯度方向)。経度方向は cos(緯度) で割る。
export const KM_PER_DEGREE = 111.32;

export const CLASSES = ['anvil-active', 'convective-remnant', 'streak', 'scaly', 'veil'];

// 層の解読方法の表。kind: rgb(真色そのまま) / gray(チャンネル0) / ir(帯13の輝度温度℃) /
// scalar(カラーマップの連続値) / category(カラーマップの区分値)。colormap を指定した層は
// LegendURL の発見を待たずその XML を使う。specials は 色→値(null は欠測扱い) の例外で、
// カラーマップに載らない塗り(晴れの黒・上限潰れ)を正す。
export const LAYERS = {
  MODIS_Terra_Cloud_Optical_Thickness: { kind: 'scalar' },
  MODIS_Aqua_Cloud_Optical_Thickness: { kind: 'scalar' },
  MODIS_Terra_Cloud_Top_Height_Day: {
    kind: 'scalar',
    colormap: 'MODIS_VIIRS_Cloud_Top_Height',
    specials: { '0,0,0': null, '220,220,255': null, '102,0,119': 12000 },
  },
  MODIS_Aqua_Cloud_Top_Height_Day: {
    kind: 'scalar',
    colormap: 'MODIS_VIIRS_Cloud_Top_Height',
    specials: { '0,0,0': null, '220,220,255': null, '102,0,119': 12000 },
  },
  MODIS_Terra_Cloud_Top_Pressure_Day: {
    kind: 'scalar',
    specials: { '0,0,0': null, '220,220,255': null },
  },
  MODIS_Aqua_Cloud_Top_Pressure_Day: {
    kind: 'scalar',
    specials: { '0,0,0': null, '220,220,255': null },
  },
  MODIS_Terra_Cloud_Phase_Optical_Properties: { kind: 'category' },
  MODIS_Aqua_Cloud_Phase_Optical_Properties: { kind: 'category' },
  MODIS_Terra_CorrectedReflectance_TrueColor: { kind: 'rgb' },
  MODIS_Aqua_CorrectedReflectance_TrueColor: { kind: 'rgb' },
  Himawari_AHI_Band13_Clean_Infrared: { kind: 'ir' },
  'GOES-East_ABI_Band13_Clean_Infrared': { kind: 'ir' },
  'GOES-West_ABI_Band13_Clean_Infrared': { kind: 'ir' },
  Himawari_AHI_Band3_Red_Visible_1km: { kind: 'gray' },
  'GOES-East_ABI_Band2_Red_Visible_1km': { kind: 'gray' },
  'GOES-West_ABI_Band2_Red_Visible_1km': { kind: 'gray' },
  VIIRS_SNPP_Cirrus_Reflectance_SWIR_M11: { kind: 'scalar', optional: true },
};

// 何日前の日付か(YYYY-MM-DD)。GIBS best の静止衛星は直近約 1-2 ヶ月しか残らない
// (reference-timeseries の実測)ので、静止衛星を使う日付はこの窓内に収める。
export function recentUtcDate(daysAgo) {
  return new Date(Date.now() - daysAgo * 86400e3).toISOString().slice(0, 10);
}

// .loop-translucent-config.json。無い・壊れているときは既定値で動く。
// 既定の採取期間は 40〜10 日前 — 静止衛星の残存期間と MODIS の処理遅延の間。
export function loadLoopConfig() {
  const defaults = {
    stage: 'probe',
    classes: [...CLASSES],
    points: 30,
    seed: 20260217,
    probeWindows: 3,
    dateStart: recentUtcDate(40),
    dateDays: 30,
    isoArchiveDays: 365,
  };
  if (!existsSync(CONFIG_FILE)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return defaults;
  }
}

// 種から組む一様乱数(cloud-detail-random-teacher と同じ mulberry32)。
export function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// src/assets/earth-climate.png(正距円筒 RGB8: R 平均気温 / G 雲量 / B 標高 0..8000m)の
// B チャンネルから組む陸海マスク。climate-map.ts の landFraction = smoothstep(0, 100m, 標高) を
// そのまま真似、0.5 以上を陸とする。
const climate = decodePng(readFileSync(path.join(root, 'src', 'assets', 'earth-climate.png')));
const smoothstep = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

// 緯度 latitudeDeg・経度 longitudeDeg [deg] の最近傍テクセルの先頭チャンネルの添字。
// 正距円筒の取り決め(u=0.5 が経度 0、v=0 が北極)で引く。
function texelOffsetAt(latitudeDeg, longitudeDeg) {
  const u = (longitudeDeg / 360 + 0.5 + 1) % 1;
  const v = Math.min(1, Math.max(0, 0.5 - latitudeDeg / 180));
  const x = Math.min(climate.width - 1, Math.floor(u * climate.width));
  const y = Math.min(climate.height - 1, Math.floor(v * climate.height));
  return (y * climate.width + x) * climate.channels;
}

// 緯度経度 [deg] の陸らしさ 0..1。
export function landFractionAt(latitudeDeg, longitudeDeg) {
  const elevation = (climate.data[texelOffsetAt(latitudeDeg, longitudeDeg) + 2] / 255) * 8000;
  return smoothstep(0, 100, elevation);
}

// 緯度経度 [deg] の平年の雲量 0..1。
export function cloudinessAt(latitudeDeg, longitudeDeg) {
  return climate.data[texelOffsetAt(latitudeDeg, longitudeDeg) + 1] / 255;
}

// 中心 (latitudeDeg, longitudeDeg) の一辺 sideKm の緯度経度箱。
export function boxAround(latitudeDeg, longitudeDeg, sideKm) {
  const halfLatitude = sideKm / 2 / KM_PER_DEGREE;
  const halfLongitude = sideKm / 2 / (KM_PER_DEGREE * Math.cos((latitudeDeg * Math.PI) / 180));
  return {
    south: latitudeDeg - halfLatitude,
    west: longitudeDeg - halfLongitude,
    north: latitudeDeg + halfLatitude,
    east: longitudeDeg + halfLongitude,
  };
}

// GIBS WMS GetMap の URL。BBOX は南・西・北・東の順。time は日次層が YYYY-MM-DD、
// 静止衛星層が YYYY-MM-DDTHH:MM:SSZ。
export function wmsUrl(layer, box, time, width, height) {
  return `${WMS_URL}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${layer}&CRS=EPSG:4326`
    + `&BBOX=${box.south.toFixed(4)},${box.west.toFixed(4)},${box.north.toFixed(4)},${box.east.toFixed(4)}`
    + `&WIDTH=${width}&HEIGHT=${height}&FORMAT=image/png&TIME=${time}&TRANSPARENT=FALSE`;
}

// 前のリクエストから REQUEST_INTERVAL 以上あくまで待つ。
let lastRequestAt = 0;
async function throttle() {
  const wait = REQUEST_INTERVAL - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

// URL を cache/fileName として取る。既にある応答はそのまま返す。GIBS は失敗を
// HTTP 200 の XML(ServiceException)で返すことがあるので、PNG 期待時はマジックを確かめ、
// 失敗・非 PNG は 5 回まで取り直す。
export async function fetchCached(url, fileName, { expectPng = true } = {}) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, fileName);
  if (existsSync(file)) return new Uint8Array(readFileSync(file));
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await throttle();
      const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
      // 404 は取り直しても無いので即座に失敗とする(候補名の総当たりを速くする)。
      if (response.status === 404) throw Object.assign(new Error('HTTP 404'), { fatal: true });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (expectPng && !(bytes[0] === 0x89 && bytes[1] === 0x50)) {
        throw new Error(`PNG でない応答(先頭: ${Buffer.from(bytes.subarray(0, 120)).toString('utf8')})`);
      }
      writeFileSync(file, bytes);
      return bytes;
    } catch (e) {
      lastError = e;
      if (e.fatal) break;
      console.log(`${fileName}: 取得に失敗(${e.message}) — ${attempt}/5 回目`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw lastError;
}

// WMS の応答を決定的なキャッシュ名で取る。返り値の file はキャッシュ内のファイル名。
export async function fetchWmsPng(layer, box, time, width, height) {
  const bbox = [box.south, box.west, box.north, box.east].map((v) => v.toFixed(3)).join('_');
  const file = `${layer}_${time}_${bbox}_${width}x${height}.png`.replace(/[:/]/g, '-');
  const bytes = await fetchCached(wmsUrl(layer, box, time, width, height), file);
  return { file, bytes };
}

// WMTS GetCapabilities の XML(1 回だけ取ってキャッシュ)。
export function fetchCapabilitiesXml() {
  return fetchCached(
    `${WMTS_URL}?SERVICE=WMTS&REQUEST=GetCapabilities`,
    'wmts-capabilities.xml',
    { expectPng: false },
  ).then((bytes) => Buffer.from(bytes).toString('utf8'));
}

// カラーマップの XML を取得してテキストで返す(キャッシュする)。
export function fetchColormapXml(name) {
  return fetchCached(`${COLORMAP_BASE}${name}.xml`, `colormap-${name}.xml`, { expectPng: false })
    .then((bytes) => Buffer.from(bytes).toString('utf8'));
}

// capabilities の層 → カラーマップ名(LegendURL の末尾の .svg の名前)の表。遅延で 1 回だけ組む。
let capabilitiesColormapMap = null;
async function capabilitiesColormaps() {
  if (capabilitiesColormapMap !== null) return capabilitiesColormapMap;
  const xml = await fetchCapabilitiesXml();
  const map = new Map();
  for (const block of xml.split('<Layer>').slice(1)) {
    const id = /<ows:Identifier>([^<]+)<\/ows:Identifier>/.exec(block)?.[1];
    if (!id) continue;
    const legend = /LegendURL[^>]*href=["'][^"']*colormaps\/v1\.3\/([^"']+)\.svg/.exec(block);
    if (legend) map.set(id, legend[1]);
  }
  capabilitiesColormapMap = map;
  return map;
}

// 層名からカラーマップ名を解決する。LegendURL が無い層は、層名から衛星・時刻の接辞を
// 外した幹で候補を試す(例: MODIS_Terra_Cloud_Top_Pressure_Day → MODIS_VIIRS_Cloud_Top_Pressure)。
// 見つからなければ null と、試した候補を返す。
export async function resolveColormapName(layerName) {
  const map = await capabilitiesColormaps();
  if (map.has(layerName)) return { name: map.get(layerName), source: 'legend', tried: [] };
  const stem = layerName.replace(/^(MODIS_(Terra|Aqua)|VIIRS_[A-Z0-9]+)_/, '');
  const stems = [...new Set([stem, stem.replace(/_(Day|Night|Min|Max|Std)$/, '')])];
  const tried = [];
  for (const s of stems) {
    for (const candidate of [`MODIS_VIIRS_${s}`, `MODIS_${s}`, s]) {
      tried.push(candidate);
      try {
        await fetchColormapXml(candidate);
        return { name: candidate, source: 'heuristic', tried };
      } catch { /* 次の候補へ */ }
    }
  }
  return { name: null, source: 'missing', tried };
}

// "[lo,hi)" などの区間か単一数を読む。区間の無い数値は {lo:v,hi:v}、
// 数値に出来ないものは null。無い端は ±Infinity で返す。
function parseValueRange(text) {
  if (text === undefined) return null;
  const m = /^[[(]\s*([^,]+)\s*,\s*([^\])]*)\s*[\])]$/.exec(text.trim());
  if (m !== null) {
    const lo = parseFloat(m[1]);
    const hi = parseFloat(m[2]);
    return { lo: Number.isFinite(lo) ? lo : -Infinity, hi: Number.isFinite(hi) ? hi : Infinity };
  }
  const v = parseFloat(text);
  return Number.isFinite(v) ? { lo: v, hi: v } : null;
}

// カラーマップ XML の全 ColorMapEntry を読む。sourceValue は区間か単一数、value=
// は物理量の区間(bin 番号の sourceValue とは別のことがある)。mid は物理量側
// (value=)を優先し、無ければ sourceValue の中点。transparent/nodata=true は欠測。
// label は LegendEntry の tooltip を rgb で引き当てたカテゴリ名。
export function parseColormap(xml) {
  const legends = new Map();
  for (const m of xml.matchAll(/<LegendEntry\b[^>]*>/g)) {
    const rgb = /rgb="([^"]*)"/.exec(m[0])?.[1];
    const tooltip = /tooltip="([^"]*)"/.exec(m[0])?.[1];
    if (rgb !== undefined && tooltip !== undefined) legends.set(rgb, tooltip);
  }
  const entries = [];
  for (const m of xml.matchAll(/<ColorMapEntry\b[^>]*>/g)) {
    const tag = m[0];
    const attr = (name) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
    const rgb = attr('rgb');
    if (rgb === undefined) continue;
    const [r, g, b] = rgb.split(',').map(Number);
    const transparent = attr('transparent') === 'true' || attr('nodata') === 'true';
    // 物理量の区間(value=)を優先し、無ければ bin 番号側(sourceValue=)を使う。
    const chosen = parseValueRange(attr('value')) ?? parseValueRange(attr('sourceValue'));
    const lo = chosen?.lo ?? null;
    const hi = chosen?.hi ?? null;
    const mid = lo === null
      ? null
      : Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2
        : Number.isFinite(lo) ? lo : Number.isFinite(hi) ? hi : null;
    entries.push({ r, g, b, transparent, lo, hi, mid, label: legends.get(rgb) });
  }
  return entries;
}

// カラーマップの健全性の概形(bin 数・値域・欠測色)。probe の点検と report の記録用。
export function colormapSummary(entries) {
  const bins = entries.filter((e) => !e.transparent);
  const finite = bins.filter((e) => Number.isFinite(e.lo) && Number.isFinite(e.hi));
  return {
    bins: bins.length,
    lo: finite.length > 0 ? Math.min(...finite.map((e) => e.lo)) : null,
    hi: finite.length > 0 ? Math.max(...finite.map((e) => e.hi)) : null,
    nodata: entries.filter((e) => e.transparent).map((e) => `${e.r},${e.g},${e.b}`),
    labels: [...new Set(bins.map((e) => e.label).filter((l) => l !== undefined))],
  };
}

// 描画 PNG をカラーマップで値の場へ反転する。完全一致→5bit/軸の最近色 LUT の順で
// bin の中点を返し、透明・specials の null・対応の無い色は NaN。
// specials は 'r,g,b' → 数値(上限潰れなど)か null(晴れ・欠測)の例外表。
export function decodeColormapField(image, entries, specials = {}) {
  const { width, height, channels, data } = image;
  const usable = entries.filter((e) => !e.transparent && e.mid !== null);
  const exact = new Map();
  for (const e of usable) exact.set((e.r << 16) | (e.g << 8) | e.b, e.mid);
  const LUT_BITS = 5;
  const LUT_SIZE = 1 << LUT_BITS;
  const SHIFT = 8 - LUT_BITS;
  const lut = new Float32Array(LUT_SIZE ** 3);
  for (let r = 0; r < LUT_SIZE; r++) {
    for (let g = 0; g < LUT_SIZE; g++) {
      for (let b = 0; b < LUT_SIZE; b++) {
        const cr = (r << SHIFT) + (1 << (SHIFT - 1));
        const cg = (g << SHIFT) + (1 << (SHIFT - 1));
        const cb = (b << SHIFT) + (1 << (SHIFT - 1));
        let best = Infinity;
        let bestValue = 0;
        for (const e of usable) {
          const d = (e.r - cr) ** 2 + (e.g - cg) ** 2 + (e.b - cb) ** 2;
          if (d < best) {
            best = d;
            bestValue = e.mid;
          }
        }
        lut[(r * LUT_SIZE + g) * LUT_SIZE + b] = bestValue;
      }
    }
  }
  const out = new Float32Array(width * height).fill(NaN);
  let nodata = 0;
  let blended = 0;
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    const key = `${data[p]},${data[p + 1]},${data[p + 2]}`;
    if (key in specials) {
      const v = specials[key];
      if (v !== null) out[i] = v;
      else nodata++;
      continue;
    }
    const code = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
    if (exact.has(code)) {
      out[i] = exact.get(code);
    } else {
      out[i] = lut[((data[p] >> SHIFT) * LUT_SIZE + (data[p + 1] >> SHIFT)) * LUT_SIZE + (data[p + 2] >> SHIFT)];
      blended++;
    }
  }
  return {
    width,
    height,
    data: out,
    stats: { nodataFraction: nodata / (width * height), blendedFraction: blended / (width * height) },
  };
}

// 帯 13 のカラーマップ。1 回だけ取って検査する。
let band13 = null;
export async function band13Entries() {
  if (band13 === null) {
    const xml = await fetchColormapXml('Clean_Longwave_Infrared_Window_Band');
    const entries = parseBand13Colormap(xml);
    validateBand13Colormap(entries);
    band13 = entries;
  }
  return band13;
}

// 層の PNG バイト列を kind に応じて解読する。
// 返り値: { kind:'rgb', image } | { kind:'field', field{w,h,data}, unit, stats, colormap } |
//         { kind:'category', field, categories:[{value,label}], stats, colormap }
export async function decodeLayer(layerName, bytes) {
  const spec = LAYERS[layerName];
  if (spec === undefined) throw new Error(`未知の層: ${layerName}`);
  if (spec.kind === 'rgb') return { kind: 'rgb', image: decodePng(Buffer.from(bytes)) };
  if (spec.kind === 'gray') return { kind: 'field', field: decodeChannelPng(Buffer.from(bytes), 0), unit: '0..1' };
  if (spec.kind === 'ir') {
    const image = decodePng(Buffer.from(bytes));
    const inverted = invertBrightnessTemperature(image, await band13Entries());
    return {
      kind: 'field',
      field: { width: inverted.width, height: inverted.height, data: inverted.data },
      unit: 'degC',
      stats: inverted.stats,
    };
  }
  // spec のカラーマップを先に試し、取れなければ LegendURL/推測へ退く。
  let colormap = spec.colormap ?? null;
  let xml = null;
  if (colormap !== null) {
    try {
      xml = await fetchColormapXml(colormap);
    } catch {
      colormap = null;
    }
  }
  let resolution = null;
  if (colormap === null) {
    resolution = await resolveColormapName(layerName);
    if (resolution.name === null) {
      throw new Error(`${layerName}: カラーマップを解決できない(試行: ${resolution.tried.join(', ')})`);
    }
    colormap = resolution.name;
    xml = await fetchColormapXml(colormap);
  }
  const entries = parseColormap(xml);
  const image = decodePng(Buffer.from(bytes));
  const decoded = decodeColormapField(image, entries, spec.specials ?? {});
  const out = {
    kind: spec.kind,
    field: { width: decoded.width, height: decoded.height, data: decoded.data },
    stats: decoded.stats,
    colormap,
    resolution,
    colormapSummary: colormapSummary(entries),
  };
  if (spec.kind === 'category') {
    out.categories = entries
      .filter((e) => !e.transparent)
      .map((e, i) => ({ index: i, value: e.mid, label: e.label }));
  }
  return out;
}

// 静止衛星の直下点経度と層名の表。
export const GEOSATS = [
  {
    name: 'Himawari', subpointLon: 140.7,
    ir: 'Himawari_AHI_Band13_Clean_Infrared', vis: 'Himawari_AHI_Band3_Red_Visible_1km',
  },
  {
    name: 'GOES-East', subpointLon: -75.2,
    ir: 'GOES-East_ABI_Band13_Clean_Infrared', vis: 'GOES-East_ABI_Band2_Red_Visible_1km',
  },
  {
    name: 'GOES-West', subpointLon: -137.2,
    ir: 'GOES-West_ABI_Band13_Clean_Infrared', vis: 'GOES-West_ABI_Band2_Red_Visible_1km',
  },
];
// 円円盤の縁として使う直下点からの大円距離の上限 [deg]。これより外は見えが悪く取らない。
export const DISK_LIMIT_DEG = 62;

// 候補の点 (latitudeDeg, longitudeDeg) に最も近い静止衛星と円盤内かどうか。
export function geosatFor(latitudeDeg, longitudeDeg) {
  let best = null;
  let bestDist = Infinity;
  for (const sat of GEOSATS) {
    const dLon = ((longitudeDeg - sat.subpointLon) * Math.PI) / 180;
    const dist = (Math.acos(Math.min(1, Math.cos((latitudeDeg * Math.PI) / 180) * Math.cos(dLon))) * 180) / Math.PI;
    if (dist < bestDist) {
      bestDist = dist;
      best = sat;
    }
  }
  return { satellite: best, distanceDeg: bestDist, covered: bestDist <= DISK_LIMIT_DEG };
}

// 極軌道衛星の通過 UTC [ms]。Terra ≈ 10.5h・Aqua ≈ 13.5h の地方太陽時で、
// 静止衛星のフレームに合わせて 10 分へ丸める。
export function overpassUtcMillis(date, longitudeDeg, sensor) {
  const localHour = sensor === 'Aqua' ? 13.5 : 10.5;
  const epoch = Date.parse(`${date}T00:00:00Z`);
  return Math.round((epoch + (localHour - longitudeDeg / 15) * 3600e3) / 600e3) * 600e3;
}

// ms を GIBS の時刻形式へ(YYYY-MM-DDTHH:MM:SSZ)。
export function isoAt(millis) {
  return new Date(millis).toISOString().replace(/\.\d+/, '');
}

// PNG の平均輝度(0..1)。GIBS はデータの無い時刻・古い日付に真っ黒を返すので、
// 真っ黒判定(0.01 未満)に使う。
export function meanLuminance(bytes) {
  const image = decodePng(Buffer.from(bytes));
  let sum = 0;
  for (let i = 0; i < image.width * image.height; i++) {
    const o = i * image.channels;
    sum += (image.data[o] + image.data[o + 1] + image.data[o + 2]) / 3;
  }
  return sum / (image.width * image.height) / 255;
}

// 静止衛星の 1 フレームを取る。指定時刻が真っ黒(その 10 分枠が未配信)なら
// ±10, ±20 分の隣の枠を試す。全部黒なら blank=true で最後の応答を返す。
// 戻り値は { file, bytes, time, blank }。
export async function fetchGeoFrame(layer, box, millis, width, height, blankLimit = 0.01) {
  let last = null;
  for (const offsetMin of [0, -10, 10, -20, 20]) {
    const time = isoAt(millis + offsetMin * 60e3);
    const fetched = await fetchWmsPng(layer, box, time, width, height);
    if (meanLuminance(fetched.bytes) >= blankLimit) return { ...fetched, time, blank: false };
    last = { ...fetched, time };
  }
  return { ...last, blank: true };
}

// 場を factor ずつのブロック平均で縮める(端の余りは捨てる)。
export function downsampleField(field, factor) {
  const w = Math.floor(field.width / factor);
  const h = Math.floor(field.height / factor);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          sum += field.data[(y * factor + dy) * field.width + x * factor + dx];
        }
      }
      out[y * w + x] = sum / (factor * factor);
    }
  }
  return { width: w, height: h, data: out };
}

// 場 b を (dx, dy) 画素ずらしたとき a との正規化相関が最大のずれを探す(巻き無し)。
// |dx|,|dy| <= maxShift を総当たりする。戻り値はそのずれと相関。
export function bestShift(a, b, maxShift) {
  const { width, height } = a;
  let best = null;
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      const x0 = Math.max(0, -dx);
      const x1 = Math.min(width, width - dx);
      const y0 = Math.max(0, -dy);
      const y1 = Math.min(height, height - dy);
      if (x1 - x0 < 8 || y1 - y0 < 8) continue;
      let sa = 0;
      let sb = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sa += a.data[y * width + x];
          sb += b.data[(y + dy) * width + x + dx];
          n++;
        }
      }
      const ma = sa / n;
      const mb = sb / n;
      let sab = 0;
      let s2a = 0;
      let s2b = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const va = a.data[y * width + x] - ma;
          const vb = b.data[(y + dy) * width + x + dx] - mb;
          sab += va * vb;
          s2a += va * va;
          s2b += vb * vb;
        }
      }
      const score = sab / Math.sqrt(Math.max(1e-30, s2a * s2b));
      if (best === null || score > best.score) best = { dx, dy, score };
    }
  }
  return best;
}

// マスクを (dx, dy) 画素ずらした新しいマスク(巻き無し、はみ出しは 0)。
export function translateMask(mask, width, height, dx, dy) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < width; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= width) continue;
      out[y * width + x] = mask[sy * width + sx];
    }
  }
  return out;
}

// マスクを radiusPx の円盤で膨張する(位置決めの余裕を持たせる用)。
export function dilateMask(mask, width, height, radiusPx) {
  const out = new Uint8Array(mask);
  const r = Math.ceil(radiusPx);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 0) continue;
      for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const span = Math.floor(Math.sqrt(radiusPx * radiusPx - dy * dy));
        for (let dx = -span; dx <= span; dx++) {
          const nx = x + dx;
          if (nx >= 0 && nx < width) out[ny * width + nx] = 1;
        }
      }
    }
  }
  return out;
}

// 二値マスクの連結成分。8 近傍でラベルを振り、画素数と重心を成分ごとに返す。
export function labelMask(mask, width, height) {
  const labels = new Int32Array(width * height).fill(-1);
  const sizes = [];
  const centroidX = [];
  const centroidY = [];
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || labels[start] !== -1) continue;
    const label = sizes.length;
    labels[start] = label;
    stack.push(start);
    let size = 0;
    let sx = 0;
    let sy = 0;
    while (stack.length > 0) {
      const at = stack.pop();
      const x = at % width;
      const y = Math.floor(at / width);
      size++;
      sx += x;
      sy += y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (mask[next] === 1 && labels[next] === -1) {
            labels[next] = label;
            stack.push(next);
          }
        }
      }
    }
    sizes.push(size);
    centroidX.push(sx / size);
    centroidY.push(sy / size);
  }
  return { labels, sizes, centroidX, centroidY };
}
