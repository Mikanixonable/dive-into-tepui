// 半透明巻雲の教師の抽出パイプライン。stage = "scan" が種で決まる候補ごとに文脈
// (MODIS の COT/CTH と静止衛星の帯 13 の時系列)を取って区分の条件を満たす窓の中心を
// 決め、"extract" が採用候補の窓(1・4 km/px の 512²)を取って受け入れ・棄却を確定する。
// 途中経過はすべて manifest.json へ残し、再開時は記録済みの候補を取り直さない。
// "report" は features の集計を呼ぶ。取得先は gibs.earthdata.nasa.gov のみ、最大 2 回/秒。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng, encodeGrayPng } from './png.mjs';
import { linearLuminanceField } from './cloud-detail-field.mjs';
import { coldnessField } from './cloud-brightness-temperature.mjs';
import {
  OUT_DIR, CACHE_DIR, CLASSES, KM_PER_DEGREE,
  loadLoopConfig, mulberry32, boxAround, fetchWmsPng, decodeLayer,
  geosatFor, overpassUtcMillis, isoAt, downsampleField, bestShift,
  translateMask, dilateMask, labelMask, fetchGeoFrame, cloudinessAt,
} from './cloud-translucent-gibs.mjs';
import { measureTranslucentWindow, classifyPattern } from './cloud-translucent-features.mjs';
import { buildReport } from './cloud-translucent-report.mjs';

const manifestFile = path.join(OUT_DIR, 'manifest.json');
const SIZE = 512;
// 文脈の解像度 [km/px]。512² で 2304 km を覆う。
const CONTEXT_KM_PER_PX = 4.5;
// 窓の段 [km/px]。
const WINDOW_TIERS = [1, 4];
// 帯 13 の遡る時刻 [h]。
const IR_OFFSETS_H = [0, -1, -2, -4, -6];
// 深い対流の芯の輝度温度の上限 [℃]。
const CORE_BT_MAX_C = -48;
// 芯と数える連結領域の最小面積 [km²]。
const CORE_MIN_AREA_KM2 = 50;
// 半透明・高層雲の条件。
const CTH_MIN_M = 6500;
const COT_RANGE = [0.3, 23];
// anvil-active の関連半径 [km]。
const ASSOC_RADIUS_KM = 60;
// remnant の採用に要る、移流した芯との窓内の重なり。
const REMNANT_OVERLAP_MIN = 0.1;
// 移流した芯の位置決めの余裕 [km](膨張半径)。
const ADVECT_DILATE_KM = 80;
// 孤立系の窓が芯から離れている距離 [km]。
const ISOLATED_CORE_DIST_KM = 300;
// 文脈の段で窓が満たすべき半透明高層雲の割合。事前ふるいなのでゆるめ —
// 受け入れの最終判定は抽出段の EXTRACT_TRANSLUCENT_MIN(1 km/px)が担う。
const CONTEXT_TRANSLUCENT_MIN = 0.08;
// 窓の有効率(黒い画素が 5% 未満)。
const MIN_COVERED = 0.95;
// 抽出で孤立系の窓に要る半透明高層雲の割合。scaly/streak は隙間が区分の要件なので
// 下限は低め、veil は広い幕の定義から高め。convective 系は芯の判定が主で低い。
const EXTRACT_TRANSLUCENT_MIN = { streak: 0.15, scaly: 0.05, veil: 0.55, default: 0.05 };
// 移流の推定の上限 [m/s] と、採用する相関の下限。
const DRIFT_MAX_MS = 30;
const DRIFT_MIN_SCORE = 0.25;
// 採用 1 点あたりの文脈候補の上限(棄却率が高くても永遠に掘らない)。
// 孤立系は判定で 3 型へ振り分ける共用の流れで、鱗雲が稀なので上限を高く取る。
const MAX_CONTEXT_TRIES_PER_POINT = 20;
const MAX_CONTEXT_TRIES_PER_POINT_ISOLATED = 60;

// 区分の定義。kind 'convective' は芯との関係で拾い、'isolated' は孤立した半透明層。
// convective は Aqua(13.5h 地方時の発達期)、isolated は候補の偶奇で Terra/Aqua を交替する。
const CLASS_DEFS = {
  'anvil-active': { kind: 'convective', latBand: [0, 35], sensor: 'Aqua' },
  'convective-remnant': { kind: 'convective', latBand: [0, 35], sensor: 'Aqua' },
  streak: { kind: 'isolated', latBand: [0, 60] },
  scaly: { kind: 'isolated', latBand: [0, 60] },
  veil: { kind: 'isolated', latBand: [0, 60] },
};

// 対流系の候補を寄せる箱 [deg](海洋大陸・インド洋・ITCZ・雷雨帯)。7 割は箱、3 割は緯度帯。
const CONVECTIVE_BOXES = [
  { south: -10, north: 10, west: 95, east: 155 },
  { south: -15, north: 5, west: 35, east: 70 },
  { south: 0, north: 15, west: -170, east: -80 },
  { south: -10, north: 10, west: -60, east: -20 },
  { south: 30, north: 50, west: -110, east: -60 },
  { south: -40, north: -15, west: 20, east: 150 },
];

// 減衰する低い積雲の観察窓(可視の時系列の実現性の調査用)。
// 日付は採取期間の真ん中を使う — 静止衛星は直近しか残らない。
const DECAY_WINDOWS = [
  { name: 'trade-cumulus', lat: 15, lon: -42 },
  { name: 'sepacific', lat: -20, lon: -91 },
  { name: 'warm-pool', lat: 5, lon: 150 },
];

// 種から組む候補の系列。決定的で、過去の実行で記録した候補は使い回さない。
function* candidateStream(className, classIndex, config) {
  const rng = mulberry32(config.seed + classIndex * 0x9e3779b9);
  const def = CLASS_DEFS[className];
  const epoch = Date.parse(`${config.dateStart}T00:00:00Z`);
  const ctxKm = CONTEXT_KM_PER_PX * SIZE;
  let index = 0;
  while (true) {
    let lat;
    let lon;
    if (def.kind === 'convective' && rng() < 0.7) {
      const box = CONVECTIVE_BOXES[Math.floor(rng() * CONVECTIVE_BOXES.length)];
      lat = box.south + rng() * (box.north - box.south);
      lon = box.west + rng() * (box.east - box.west);
    } else {
      const [latMin, latMax] = def.latBand;
      const sinMin = Math.sin((latMin * Math.PI) / 180);
      const sinMax = Math.sin((latMax * Math.PI) / 180);
      lat = (rng() < 0.5 ? -1 : 1) * Math.asin(sinMin + rng() * (sinMax - sinMin)) * 180 / Math.PI;
      lon = rng() * 360 - 180;
    }
    const date = new Date(epoch + Math.floor(rng() * config.dateDays) * 86400e3).toISOString().slice(0, 10);
    const sensor = def.sensor ?? (index % 2 === 0 ? 'Terra' : 'Aqua');
    const halfLat = ctxKm / 2 / KM_PER_DEGREE;
    const halfLon = ctxKm / 2 / (KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
    if (Math.abs(lat) + halfLat > 85 || lon - halfLon < -178 || lon + halfLon > 178) continue;
    // 平年の雲量が低い場所は孤立した半透明雲が滅多に無い — 候補の段で捨てる。
    if (cloudinessAt(lat, lon) < 0.3) continue;
    yield { index: index++, lat, lon, date, sensor };
  }
}

// 既存の manifest を読む。無い・壊れているときは空で始める。
function loadManifest(config) {
  if (existsSync(manifestFile)) {
    try {
      return JSON.parse(readFileSync(manifestFile, 'utf8'));
    } catch { /* 空で始める */ }
  }
  return {
    tool: 'cloud-translucent-teacher',
    seed: config.seed,
    points: config.points,
    candidates: [],
    decayCumulus: null,
    coverageNotes: [
      `静止衛星は直下点から ${62}° 以内の候補だけを取る(縁の歪みと欠測を避ける)。`,
      '日付変更線・極を跨ぐ箱は候補の段で外す。',
      'VIIRS 1.38µm は任意で、欠測・欠損は記録して続行する。',
      'GIBS best の静止衛星は直近約 1-2 ヶ月しか残らない。採取期間の既定は 40〜10 日前。'
        + 'これより古い日付を選ぶと帯 13/可視が真っ黒で返る。',
    ],
  };
}

function saveManifest(manifest) {
  manifest.generatedAt = new Date().toISOString();
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

// 連続する IR フレーム間のドリフトを、4 倍に縮めた冷たさの場の最良シフトで推す。
// dtH は隣の枠へ退いた分を含め実際の時刻差。戻り値は区間ごとの
// {dtH, dxPx, dyPx, score}(px は文脈の画素)。
function estimateDrifts(coldFields) {
  const drifts = [];
  for (let i = 0; i + 1 < coldFields.length; i++) {
    const dtH = (Date.parse(coldFields[i].time) - Date.parse(coldFields[i + 1].time)) / 3600e3;
    const small0 = downsampleField(coldFields[i].cold, 4);
    const small1 = downsampleField(coldFields[i + 1].cold, 4);
    const maxShift = Math.ceil((DRIFT_MAX_MS * dtH * 3600) / (CONTEXT_KM_PER_PX * 4 * 1000));
    const shift = bestShift(small0, small1, maxShift);
    drifts.push({ dtH, dxPx: shift.dx * 4, dyPx: shift.dy * 4, score: shift.score });
  }
  return drifts;
}

// 区間のドリフトから、ある時刻のフレームを t0 へ運ぶ累積シフト [文脈 px] と平均風。
function accumulatedShifts(drifts, offsetsH) {
  const out = new Map([[0, { dx: 0, dy: 0 }]]);
  for (let i = 1; i < offsetsH.length; i++) {
    // offsetsH は [0,-1,-2,-4,-6]。frame i の時刻から t0 への総変位は区間 i-1..0 の和。
    let dx = 0;
    let dy = 0;
    for (let j = 0; j < i; j++) {
      dx += drifts[j].dxPx;
      dy += drifts[j].dyPx;
    }
    out.set(offsetsH[i], { dx, dy });
  }
  return out;
}

// 文脈の画素座標 → 緯度経度。
function contextToLatLon(cx, cy, cand, ctxKm) {
  const lat = cand.lat + (SIZE / 2 - cy) * ctxKm / KM_PER_DEGREE;
  const lon = cand.lon + (cx - SIZE / 2) * ctxKm / (KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
  return { lat, lon };
}

// 窓の中心(cx, cy)[文脈 px]の周りの wPx² の半透明割合と、芯の画素・移流芯の画素数。
function windowRegion(translucent, cx, cy, wPx) {
  let masked = 0;
  let count = 0;
  for (let y = Math.max(0, Math.round(cy - wPx / 2)); y < Math.min(SIZE, Math.round(cy + wPx / 2)); y++) {
    for (let x = Math.max(0, Math.round(cx - wPx / 2)); x < Math.min(SIZE, Math.round(cx + wPx / 2)); x++) {
      count++;
      masked += translucent[y * SIZE + x];
    }
  }
  return { share: count > 0 ? masked / count : 0, count, masked };
}

// 1 候補の文脈を取り、区分の窓の中心を探す。見つかれば manifest へ入る値を返す。
async function scanCandidate(cand, className) {
  const { satellite, covered, distanceDeg } = geosatFor(cand.lat, cand.lon);
  if (!covered) throw new Error(`disk-uncovered(${distanceDeg.toFixed(1)}°)`);
  const t0 = overpassUtcMillis(cand.date, cand.lon, cand.sensor);
  const ctxBox = boxAround(cand.lat, cand.lon, CONTEXT_KM_PER_PX * SIZE);
  const cotLayer = `MODIS_${cand.sensor}_Cloud_Optical_Thickness`;
  const cthLayer = `MODIS_${cand.sensor}_Cloud_Top_Height_Day`;
  const cotBytes = (await fetchWmsPng(cotLayer, ctxBox, cand.date, SIZE, SIZE));
  const cthBytes = (await fetchWmsPng(cthLayer, ctxBox, cand.date, SIZE, SIZE));
  const cot = (await decodeLayer(cotLayer, cotBytes.bytes)).field;
  const cth = (await decodeLayer(cthLayer, cthBytes.bytes)).field;
  const translucent = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (Number.isFinite(cot.data[i]) && Number.isFinite(cth.data[i])
      && cth.data[i] > CTH_MIN_M && cot.data[i] >= COT_RANGE[0] && cot.data[i] < COT_RANGE[1]) {
      translucent[i] = 1;
    }
  }
  const wPx = Math.round(512 / CONTEXT_KM_PER_PX);
  const fits = (cx, cy) => Math.abs(cx - SIZE / 2) <= (SIZE - wPx) / 2
    && Math.abs(cy - SIZE / 2) <= (SIZE - wPx) / 2;
  // 孤立系は窓に出来る半透明の成分が先にあることが条件 — 無い候補で帯 13 を
  // 5 枚取らないよう、MODIS だけで先に落とす。
  let comps = [];
  if (className !== 'anvil-active') {
    const regions = labelMask(translucent, SIZE, SIZE);
    comps = regions.sizes
      .map((size, i) => ({ size, cx: regions.centroidX[i], cy: regions.centroidY[i] }))
      .filter((c) => c.size * CONTEXT_KM_PER_PX * CONTEXT_KM_PER_PX >= 200 && fits(c.cx, c.cy))
      .sort((a, b) => b.size - a.size)
      .filter((c) => windowRegion(translucent, c.cx, c.cy, wPx).share >= CONTEXT_TRANSLUCENT_MIN);
    if (comps.length === 0) throw new Error('no-window');
  } else {
    let total = 0;
    for (const v of translucent) total += v;
    if (total / (SIZE * SIZE) < 0.03) throw new Error('no-window');
  }
  // 帯 13 の時系列と芯のマスク。
  const frames = [];
  for (const offsetH of IR_OFFSETS_H) {
    const fetched = await fetchGeoFrame(satellite.ir, ctxBox, t0 + offsetH * 3600e3, SIZE, SIZE);
    // 真っ黒は残存期間を外れた日付(静止衛星は直近しか残らない)か欠測。
    if (fetched.blank) throw new Error(`ir-blank(${fetched.time})`);
    const bt = (await decodeLayer(satellite.ir, fetched.bytes)).field;
    frames.push({ offsetH, file: fetched.file, time: fetched.time, bt, cold: coldnessField(bt) });
  }
  const coreAt = (index) => Uint8Array.from(frames[index].bt.data, (v) => (Number.isFinite(v) && v <= CORE_BT_MAX_C ? 1 : 0));
  const coreT0 = coreAt(0);
  const coreLabels = labelMask(coreT0, SIZE, SIZE);
  const coreComps = coreLabels.sizes
    .map((size, i) => ({ areaKm2: size * CONTEXT_KM_PER_PX * CONTEXT_KM_PER_PX, cx: coreLabels.centroidX[i], cy: coreLabels.centroidY[i] }))
    .filter((c) => c.areaKm2 >= CORE_MIN_AREA_KM2)
    .sort((a, b) => b.areaKm2 - a.areaKm2);
  const drifts = estimateDrifts(frames);
  const shifts = accumulatedShifts(drifts, IR_OFFSETS_H);
  const dilatePx = ADVECT_DILATE_KM / CONTEXT_KM_PER_PX;
  const advected = frames.slice(1).map((frame, i) => {
    const shift = shifts.get(frame.offsetH);
    return dilateMask(translateMask(coreAt(i + 1), SIZE, SIZE, Math.round(shift.dx), Math.round(shift.dy)), SIZE, SIZE, dilatePx);
  });
  // 平均風: 全区間の変位の総和 / 総時間。
  let dxKm = 0;
  let dyKm = 0;
  let dtSum = 0;
  let minScore = Infinity;
  for (const d of drifts) {
    dxKm += d.dxPx * CONTEXT_KM_PER_PX;
    dyKm += d.dyPx * CONTEXT_KM_PER_PX;
    dtSum += d.dtH;
    minScore = Math.min(minScore, d.score);
  }
  const wind = minScore >= DRIFT_MIN_SCORE && dtSum > 0
    ? {
      deg: ((Math.atan2(-dyKm, dxKm) * 180) / Math.PI + 360) % 360,
      speedMs: (Math.hypot(dxKm, dyKm) * 1000) / (dtSum * 3600),
      source: 'advection',
    }
    : null;
  let windowCenter = null;
  let coreDistKm = null;
  let remnantOverlap = {};
  if (className === 'anvil-active') {
    for (const core of coreComps) {
      const near = windowRegion(translucent, core.cx, core.cy, Math.round((ASSOC_RADIUS_KM * 2) / CONTEXT_KM_PER_PX));
      if (near.share > 0 && fits(core.cx, core.cy)) {
        windowCenter = { cx: core.cx, cy: core.cy };
        coreDistKm = 0;
        break;
      }
    }
  } else {
    // 芯の画素への最小距離を返す。
    const distToCore = (cx, cy) => {
      let best = Infinity;
      for (let i = 0; i < SIZE * SIZE; i++) {
        if (coreT0[i] === 0) continue;
        const d = Math.hypot((i % SIZE) - cx, Math.floor(i / SIZE) - cy);
        if (d < best) best = d;
      }
      return best * CONTEXT_KM_PER_PX;
    };
    for (const comp of comps) {
      const overlaps = advected.map((mask) => windowRegion(mask, comp.cx, comp.cy, wPx).share);
      const maxOverlap = Math.max(...overlaps);
      const dist = distToCore(comp.cx, comp.cy);
      if (className === 'convective-remnant') {
        const coreInWindow = windowRegion(coreT0, comp.cx, comp.cy, wPx).masked > 0;
        if (!coreInWindow && maxOverlap >= REMNANT_OVERLAP_MIN) {
          windowCenter = comp;
          remnantOverlap = Object.fromEntries(IR_OFFSETS_H.slice(1).map((h, i) => [`h${-h}`, overlaps[i]]));
          coreDistKm = dist;
          break;
        }
      } else if (maxOverlap === 0 && dist >= ISOLATED_CORE_DIST_KM) {
        windowCenter = comp;
        coreDistKm = dist;
        break;
      }
    }
  }
  if (windowCenter === null) throw new Error('no-window');
  const { lat, lon } = contextToLatLon(windowCenter.cx, windowCenter.cy, cand, CONTEXT_KM_PER_PX);
  return {
    satellite: satellite.name,
    irLayer: satellite.ir,
    overpassUtc: isoAt(t0),
    window: { lat, lon, cx: windowCenter.cx, cy: windowCenter.cy },
    wind,
    coreDistKm,
    remnantOverlap,
    advectShift: drifts.map((d) => ({ dtH: d.dtH, dxPx: d.dxPx, dyPx: d.dyPx, score: d.score })),
    contextFiles: {
      cot: cotBytes.file, cth: cthBytes.file, ir: frames.map((f) => f.file),
      center: { lat: cand.lat, lon: cand.lon },
    },
  };
}

// 画素のうち値のある画素(RGB の最大が黒レベルを超える)の割合。
function coveredFraction(png) {
  let covered = 0;
  const total = png.width * png.height;
  for (let i = 0; i < total; i++) {
    const o = i * png.channels;
    if (Math.max(png.data[o], png.data[o + 1] ?? 0, png.data[o + 2] ?? 0) >= 16) covered++;
  }
  return covered / total;
}

// 採用候補の窓を取り、受け入れ可否を確定する。
async function extractCandidate(cand) {
  const { lat, lon } = cand.window;
  const sensor = cand.sensor;
  const date = cand.date;
  const cotLayer = `MODIS_${sensor}_Cloud_Optical_Thickness`;
  const cthLayer = `MODIS_${sensor}_Cloud_Top_Height_Day`;
  const trueLayer = `MODIS_${sensor}_CorrectedReflectance_TrueColor`;
  const files = { tier1: {}, tier4: {} };
  for (const kmPerPx of WINDOW_TIERS) {
    const box = boxAround(lat, lon, kmPerPx * SIZE);
    const tier = kmPerPx === 1 ? files.tier1 : files.tier4;
    for (const [key, layer] of [['truecolor', trueLayer], ['cot', cotLayer], ['cth', cthLayer]]) {
      const fetched = await fetchWmsPng(layer, box, date, SIZE, SIZE);
      tier[key] = fetched.file;
    }
    tier.cotLayer = cotLayer;
    tier.cthLayer = cthLayer;
  }
  // 診断の層(取れなくても候補は捨てない)。
  try {
    const box4 = boxAround(lat, lon, 4 * SIZE);
    const phase = await fetchWmsPng(`MODIS_${sensor}_Cloud_Phase_Optical_Properties`, box4, date, SIZE, SIZE);
    files.tier4.phase = phase.file;
  } catch (e) {
    files.tier4.phaseError = e.message;
  }
  try {
    const box1 = boxAround(lat, lon, SIZE);
    const cirrus = await fetchWmsPng('VIIRS_SNPP_Cirrus_Reflectance_SWIR_M11', box1, date, SIZE, SIZE);
    files.tier1.cirrus = cirrus.file;
  } catch (e) {
    files.tier1.cirrusError = e.message;
  }
  const covered = coveredFraction(decodePng(readFileSync(path.join(CACHE_DIR, files.tier1.truecolor))));
  if (covered < MIN_COVERED) throw new Error(`missing(有効率 ${covered.toFixed(3)})`);
  const read = (name) => readFileSync(path.join(CACHE_DIR, name));
  const luminance = linearLuminanceField(read(files.tier1.truecolor));
  const cot = (await decodeLayer(cotLayer, read(files.tier1.cot))).field;
  const cth = (await decodeLayer(cthLayer, read(files.tier1.cth))).field;
  const mask = new Uint8Array(luminance.width * luminance.height);
  let translucentCount = 0;
  const cotValues = [];
  for (let i = 0; i < mask.length; i++) {
    const c = cot.data[i];
    const h = cth.data[i];
    if (Number.isFinite(c) && Number.isFinite(h) && h > CTH_MIN_M && c >= COT_RANGE[0] && c < COT_RANGE[1]) {
      mask[i] = 1;
      translucentCount++;
      cotValues.push(c);
    }
  }
  const share = translucentCount / mask.length;
  const isolated = CLASS_DEFS[cand.className].kind === 'isolated';
  // 対流系は判定をしないので先に占有率で落とす。孤立系は判定後に区分の下限で見る —
  // 占有率の低い鱗雲を事前に捨てないため。
  if (!isolated) {
    const minShare = EXTRACT_TRANSLUCENT_MIN[cand.className] ?? EXTRACT_TRANSLUCENT_MIN.default;
    if (share < minShare) throw new Error(`translucent-share ${share.toFixed(3)} < ${minShare}`);
  }
  // 芯のマスクを窓の解像度へ(文脈の帯 13 から最近傍で写す)。
  let coreMask = null;
  if (cand.contextFiles?.ir?.[0] !== undefined) {
    const bt = (await decodeLayer(cand.irLayer, read(cand.contextFiles.ir[0]))).field;
    const contextCore = Uint8Array.from(bt.data, (v) => (Number.isFinite(v) && v <= CORE_BT_MAX_C ? 1 : 0));
    coreMask = new Uint8Array(SIZE * SIZE);
    const ctx = cand.contextFiles.center;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const pLat = lat + (SIZE / 2 - y) / KM_PER_DEGREE;
        const pLon = lon + (x - SIZE / 2) / (KM_PER_DEGREE * Math.cos((pLat * Math.PI) / 180));
        const cx = SIZE / 2 + (pLon - ctx.lon) * KM_PER_DEGREE * Math.cos((pLat * Math.PI) / 180) / CONTEXT_KM_PER_PX;
        const cy = SIZE / 2 - (pLat - ctx.lat) * KM_PER_DEGREE / CONTEXT_KM_PER_PX;
        const ix = Math.round(cx);
        const iy = Math.round(cy);
        if (ix >= 0 && iy >= 0 && ix < SIZE && iy < SIZE) coreMask[y * SIZE + x] = contextCore[iy * SIZE + ix];
      }
    }
    const coreName = `${cand.className}-${String(cand.slot).padStart(3, '0')}-coremask.png`;
    writeFileSync(path.join(CACHE_DIR, coreName), encodeGrayPng(SIZE, SIZE, Uint8Array.from(coreMask, (v) => v * 255)));
    files.tier1.coreMask = coreName;
  }
  const measured = measureTranslucentWindow(luminance, { kmPerPx: 1, mask, cot, cth, coreMask, windDeg: cand.wind?.deg ?? null });
  let classifiedAs = null;
  let streamClass = null;
  if (isolated) {
    const classified = classifyPattern(measured);
    // 棄却された窓でも判定に読んだ値を残す — CLASSIFY の見直しの材料。
    cand.classifyValues = classified.values;
    if (classified.className === null) throw new Error(`unclassified(${JSON.stringify(classified.values)})`);
    classifiedAs = classified.className;
    // 孤立系の窓は判定の出た区分の標本にする — 狙いの型と違っても別型の標本になる。
    if (classifiedAs !== cand.className) streamClass = cand.className;
    const minForClass = EXTRACT_TRANSLUCENT_MIN[classifiedAs] ?? EXTRACT_TRANSLUCENT_MIN.default;
    if (share < minForClass) {
      throw new Error(`translucent-share ${share.toFixed(3)} < ${minForClass}(${classifiedAs})`);
    }
  }
  const sorted = [...cotValues].sort((a, b) => a - b);
  return {
    status: 'ok',
    className: classifiedAs ?? cand.className,
    ...(streamClass ? { streamClass } : {}),
    files,
    classifiedAs,
    quantiles: {
      covered,
      translucentShare: share,
      cotP50: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] : null,
    },
  };
}

// 減衰する低い積雲の観察窓。可視 1 km を地方時の昼(≈13 時)・+2h・+4h に取る。
async function runDecayProbe(config, manifest) {
  if (manifest.decayCumulus !== null) return;
  const files = [];
  const date = new Date(
    Date.parse(`${config.dateStart}T00:00:00Z`) + Math.floor(config.dateDays / 2) * 86400e3,
  ).toISOString().slice(0, 10);
  for (const win of DECAY_WINDOWS) {
    const { satellite } = geosatFor(win.lat, win.lon);
    const t0 = overpassUtcMillis(date, win.lon, 'Aqua');
    const box = boxAround(win.lat, win.lon, SIZE);
    for (const offsetH of [0, 2, 4]) {
      try {
        const fetched = await fetchGeoFrame(satellite.vis, box, t0 + offsetH * 3600e3, SIZE, SIZE, 0.02);
        if (fetched.blank) throw new Error(`可視が真っ暗(${fetched.time})`);
        const decoded = await decodeLayer(satellite.vis, fetched.bytes);
        const file = `decay-${win.name}-t${offsetH}h.png`;
        const gray = new Uint8Array(decoded.field.data.length);
        for (let i = 0; i < gray.length; i++) gray[i] = Math.round(decoded.field.data[i] * 255);
        writeFileSync(path.join(OUT_DIR, file), encodeGrayPng(decoded.field.width, decoded.field.height, gray));
        files.push({ window: win.name, offsetH, file, satellite: satellite.name, time: fetched.time });
      } catch (e) {
        files.push({ window: win.name, offsetH, error: e.message });
      }
    }
  }
  manifest.decayCumulus = {
    files,
    note: '1 km/px の可視で個々の積雲(1〜5 km)の減衰を追うには解像度が辛うじ届く程度。'
      + '昼間しか撮れず、時系列は数時間に限られる。細胞の追跡より被覆率の時間変化を見る用途に限る。',
  };
}

async function runScan(config, manifest) {
  for (const className of config.classes) {
    const accepted = () => manifest.candidates.filter(
      (c) => c.className === className && (c.status === 'scanned' || c.status === 'ok')).length;
    const used = new Set(manifest.candidates.filter((c) => c.className === className).map((c) => c.candidateIndex));
    const stream = candidateStream(className, CLASSES.indexOf(className), config);
    let slot = manifest.candidates.filter((c) => c.className === className).length;
    let tries = 0;
    const triesCap = config.points * (CLASS_DEFS[className].kind === 'isolated'
      ? MAX_CONTEXT_TRIES_PER_POINT_ISOLATED
      : MAX_CONTEXT_TRIES_PER_POINT);
    while (accepted() < config.points && tries < triesCap) {
      const cand = stream.next().value;
      if (used.has(cand.index)) continue;
      used.add(cand.index);
      slot++;
      tries++;
      const entry = {
        candidateIndex: cand.index, className, slot,
        lat: cand.lat, lon: cand.lon, date: cand.date, sensor: cand.sensor,
        status: 'rejected', fetchedAt: new Date().toISOString(),
      };
      try {
        Object.assign(entry, await scanCandidate(cand, className), { status: 'scanned' });
        console.log(`scanned ${className}#${slot}(${cand.lat.toFixed(1)}°, ${cand.lon.toFixed(1)}°, ${cand.date})`);
      } catch (e) {
        entry.rejectReason = e.message;
        console.log(`rejected ${className}#${slot}: ${e.message}`);
      }
      manifest.candidates.push(entry);
      saveManifest(manifest);
    }
    console.log(`${className}: 採用 ${accepted()}/${config.points}(${tries} 候補)`);
  }
}

async function runExtract(config, manifest) {
  // retryRejects が立つときは、判定・占有率で棄却した窓と、採用済みの孤立系の窓を
  // 現在の基準で採り直す(基準の見直しで区分の付け替えが起きるため)。
  const retryable = (c) => c.status === 'scanned' || (config.retryRejects === true
    && ((c.status === 'rejected' && /^(translucent-share|unclassified)/.test(c.rejectReason ?? ''))
      || (c.status === 'ok' && CLASS_DEFS[c.className]?.kind === 'isolated')));
  for (const cand of manifest.candidates.filter(retryable)) {
    try {
      delete cand.rejectReason;
      Object.assign(cand, await extractCandidate(cand));
      console.log(`extracted ${cand.className}#${cand.slot}`);
    } catch (e) {
      cand.status = 'rejected';
      cand.rejectReason = e.message;
      console.log(`rejected ${cand.className}#${cand.slot}: ${e.message}`);
    }
    saveManifest(manifest);
  }
  await runDecayProbe(config, manifest);
  saveManifest(manifest);
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const config = loadLoopConfig();
  const manifest = loadManifest(config);
  if (config.stage === 'scan') await runScan(config, manifest);
  else if (config.stage === 'extract') await runExtract(config, manifest);
  else if (config.stage === 'report') await buildReport();
  else console.log(`未知の stage: ${config.stage}(probe は cloud-translucent-probe.mjs)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
