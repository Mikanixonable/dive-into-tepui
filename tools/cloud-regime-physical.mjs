// 実写の教師(ランダム抽出場面)へ、雲の物理量をタイル(256 km)ごとに付ける。
// 教師と同じ BBOX・同じ 512² の窓で、MODIS Terra の光学的厚み・雲頂高度(無ければ
// 雲頂気圧)・雲相を教師の日付で取り、画素を欠測・晴天・雲へ分け、雲は ISCCP の
// 9 分類(τ の 3 段 × 雲頂の 3 段)へ畳む。結果 .cloud-detail/regime/teacher-physical.json は
// 実行のたびに取得済み(キャッシュに残る)の全場面から作り直す。
// --max-scenes=N で新しく取得する場面を絞れる(区分が偏らないよう番号順で巡る)。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { decodePng } from './png.mjs';
import {
  boxAround, fetchWmsPng, decodeLayer, fetchColormapXml, parseColormap,
} from './cloud-translucent-gibs.mjs';

const root = path.resolve(import.meta.dirname, '..');
const teacherDir = path.join(root, '.cloud-detail', 'random-teacher');
const manifestFile = path.join(teacherDir, 'manifest.json');
const outDir = path.join(root, '.cloud-detail', 'regime');
const outFile = path.join(outDir, 'teacher-physical.json');
const stateFile = path.join(outDir, 'teacher-physical-state.json');

const SIZE = 512;
const KM_PER_PX = 4;
const TILE_PX = 64;
const TILES_PER_SIDE = SIZE / TILE_PX;
const TILE_KM = TILE_PX * KM_PER_PX;
// 真色の欠測(観測の帯の外・夜)の黒レベル。random-teacher の coveredFraction と同じ閾値。
const BLACK_LEVEL = 16;
// タイルを特徴量として使える有効率の下限。
const MIN_VALID_FRAC = 0.5;

const LAYER_TAU = 'MODIS_Terra_Cloud_Optical_Thickness';
const LAYER_TOP_HEIGHT = 'MODIS_Terra_Cloud_Top_Height_Day';
const LAYER_TOP_PRESSURE = 'MODIS_Terra_Cloud_Top_Pressure_Day';
const LAYER_PHASE = 'MODIS_Terra_Cloud_Phase_Optical_Properties';

// ISCCP D シリーズ(Rossow & Schiffer 1999)の区分の境界。τ は無次元、雲頂は km と hPa の
// 両建て(製品が高度のとき km、気圧のとき hPa で畳む)。
const TAU_BOUND = { thinMid: 3.6, midThick: 23 };
const TOP_KM_BOUND = { lowMiddle: 3.2, middleHigh: 6.5 };
const TOP_HPA_BOUND = { lowMiddle: 680, middleHigh: 440 };

// 9 分類の名前(行 = 雲頂の段 high/middle/low、列 = τ の段 thin/middle/thick)。
const ISCCP_NAME = {
  high: { thin: 'cirrus', mid: 'cirrostratus', thick: 'deepConvection' },
  middle: { thin: 'altocumulus', mid: 'altostratus', thick: 'nimbostratus' },
  low: { thin: 'cumulus', mid: 'stratocumulus', thick: 'stratus' },
};
const CLASS_NAMES = [
  'cirrus', 'cirrostratus', 'deepConvection',
  'altocumulus', 'altostratus', 'nimbostratus',
  'cumulus', 'stratocumulus', 'stratus',
];

// 表を揃えるための区分の並び(random-teacher の抽出順)。
const CATEGORY_ORDER = [
  'tropical-sea', 'temperate-sea', 'highlat-sea', 'tropical-land', 'temperate-land', 'highlat-land', 'arid-land',
];

export function tauBand(tau) {
  return tau < TAU_BOUND.thinMid ? 'thin' : tau < TAU_BOUND.midThick ? 'mid' : 'thick';
}

// 雲頂の段。topKm(高度製品)があれば km、無ければ topHpa(気圧製品)で畳む。
// どちらも無いとき null。
export function topBand(topKm, topHpa) {
  if (Number.isFinite(topKm)) return topKm < TOP_KM_BOUND.lowMiddle ? 'low' : topKm <= TOP_KM_BOUND.middleHigh ? 'middle' : 'high';
  if (Number.isFinite(topHpa)) return topHpa > TOP_HPA_BOUND.lowMiddle ? 'low' : topHpa >= TOP_HPA_BOUND.middleHigh ? 'middle' : 'high';
  return null;
}

// τ と雲頂の段から ISCCP の区分名を返す。どちらか欠けていれば null。
export function isccpClassOf(tau, topKm, topHpa) {
  const band = topBand(topKm, topHpa);
  if (band === null || !Number.isFinite(tau)) return null;
  return ISCCP_NAME[band][tauBand(tau)];
}

// 値の列の分位点。空なら null。
function quantile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

// 1 画素の分類。missing = 欠測、cloud = 雲の検出あり。tau は光学的厚み、
// topKm/topHpa は雲頂(高度か気圧のどちらか一方)、ice は雲相が氷か(不明は null)。
// cell = { missing, cloud, tau, topKm, topHpa, ice }
const clearCell = { missing: false, cloud: false, tau: null, topKm: null, topHpa: null, ice: null };

// 1 タイルの画素列から特徴量を畳む。割合はすべて欠測でない画素を分母にする。
// 有効率が下限未満のタイルは割合・統計をすべて null にして特徴量から外す。
export function summarizeTile(cells) {
  const total = cells.length;
  const valid = cells.filter((cell) => !cell.missing);
  const validFrac = valid.length / total;
  const counts = Object.fromEntries(CLASS_NAMES.map((name) => [name, 0]));
  // 雲頂の段ごと(τ の有無を問わない)・τ が無い雲の雲頂の段ごと・τ の段ごとの画素数。
  const topCounts = { high: 0, middle: 0, low: 0 };
  const noTauTopCounts = { high: 0, middle: 0, low: 0 };
  const tauCounts = { thin: 0, mid: 0, thick: 0 };
  let noTopCount = 0;
  let clearCount = 0;
  let unknownCount = 0;
  let cloudCount = 0;
  const taus = [];
  const topKms = [];
  let iceKnown = 0;
  let iceCount = 0;
  for (const cell of valid) {
    if (!cell.cloud) {
      clearCount++;
      continue;
    }
    cloudCount++;
    const name = isccpClassOf(cell.tau, cell.topKm, cell.topHpa);
    if (name !== null) counts[name] += 1;
    else unknownCount++;
    const band = topBand(cell.topKm, cell.topHpa);
    if (band === null) noTopCount++;
    else {
      topCounts[band]++;
      if (!Number.isFinite(cell.tau)) noTauTopCounts[band]++;
    }
    if (Number.isFinite(cell.tau)) tauCounts[tauBand(cell.tau)]++;
    if (Number.isFinite(cell.tau)) taus.push(cell.tau);
    if (Number.isFinite(cell.topKm)) topKms.push(cell.topKm);
    if (cell.ice !== null) {
      iceKnown++;
      if (cell.ice) iceCount++;
    }
  }
  const n = valid.length;
  const ratios = {
    cloudFrac: cloudCount / n,
    clearFrac: clearCount / n,
    unknownHeightFrac: unknownCount / n,
    ...Object.fromEntries(CLASS_NAMES.map((name) => [name, counts[name] / n])),
  };
  const usable = validFrac >= MIN_VALID_FRAC;
  const share = (count) => (usable ? count / n : null);
  return {
    validFrac,
    cloudFrac: usable ? ratios.cloudFrac : null,
    clearFrac: usable ? ratios.clearFrac : null,
    unknownHeightFrac: usable ? ratios.unknownHeightFrac : null,
    ...Object.fromEntries(CLASS_NAMES.map((name) => [name, usable ? ratios[name] : null])),
    topHighFrac: share(topCounts.high),
    topMiddleFrac: share(topCounts.middle),
    topLowFrac: share(topCounts.low),
    noTopFrac: share(noTopCount),
    highNoTauFrac: share(noTauTopCounts.high),
    middleNoTauFrac: share(noTauTopCounts.middle),
    lowNoTauFrac: share(noTauTopCounts.low),
    tauThinFrac: share(tauCounts.thin),
    tauMidFrac: share(tauCounts.mid),
    tauThickFrac: share(tauCounts.thick),
    tauMedian: usable ? quantile(taus, 0.5) : null,
    tauP90: usable ? quantile(taus, 0.9) : null,
    topKmMedian: usable ? quantile(topKms, 0.5) : null,
    topKmP90: usable ? quantile(topKms, 0.9) : null,
    iceFrac: usable && iceKnown > 0 ? iceCount / iceKnown : null,
    highThinFrac: usable ? ratios.cirrus : null,
    deepFrac: usable ? ratios.deepConvection : null,
  };
}

// RGB 画像の i 番目の画素が黒(観測の帯の外)か。
function pixelBlack(image, i) {
  const p = i * image.channels;
  return Math.max(image.data[p], image.data[p + 1] ?? 0, image.data[p + 2] ?? 0) < BLACK_LEVEL;
}

// RGB 画像の i 番目の画素の 'r,g,b' キー。
function rgbKey(image, i) {
  const p = i * image.channels;
  return `${image.data[p]},${image.data[p + 1]},${image.data[p + 2]}`;
}

// 製品の色の表(colormap の全エントリ)から、値を持つ色(透明でないエントリ)の集合と、
// 透明(nodata・晴天の色)の集合を引く。decodeLayer の LUT は表に無い色へ最近色の値を返すので、
// 値の採用は表に完全一致する色だけに限る(ブレンドした縁の色は値なしにする)。
// 黒(0,0,0)は表に無くても GIBS の塗り(欠測・反演なし)なので、値なしとして扱う。
async function colormapColors(decoded) {
  const entries = parseColormap(await fetchColormapXml(decoded.colormap));
  return {
    valued: new Set(entries.filter((e) => !e.transparent).map((e) => `${e.r},${e.g},${e.b}`)),
    labelOf: new Map(entries.filter((e) => !e.transparent).map((e) => [`${e.r},${e.g},${e.b}`, e.label ?? ''])),
  };
}

// 場面の 3 製品と真色の画素から、全画素の分類 cell を組む。
// 欠測・晴天・雲の区別(復号結果を色で数えた実態に合わせた。0 ではなく黒の画素を数えて確認):
// - 欠測は真色が黒の画素だけ(観測の帯の外・夜)。教師の採用条件もこの黒で弾く。
//   真色が黒でない画素で 3 製品すべてが黒(塗り)のものは、MOD06 の光学量は雲の画素だけに
//   反演されるので「観測はあるが雲の反演なし」= 晴天として数える。真色の黒と 3 製品の黒が
//   ほぼ重なる(約 96%)ことがこの区別の根拠。
// - 雲は、τ・雲頂のどちらかが表の色と完全一致して値を持つ画素、または雲相が液体・氷・不明の
//   画素。これに当たらない観測画素は晴天。雲相の晴天の色(100,100,100)は透明エントリで値を
//   持たないので、雲相は雲の値だけを数える。
// - 雲頂高度の薄青(220,220,255)は透明エントリで値なし。黒は表に無いが、3 製品の塗りとして値なし。
function classifyPixels(tauLayer, topLayer, phaseLayer, teacher) {
  const cells = new Array(SIZE * SIZE);
  // 区別の根拠を点検するための内訳。teacherBlack = 真色が黒(欠測)、
  // productsBlack = 真色はあるが 3 製品すべて黒(晴天へ畳む)、
  // ownBlackOrUnvalued = 観測済みで雲の値が無い(晴天へ畳む)。
  const diag = { teacherBlack: 0, productsBlack: 0, ownBlackOrUnvalued: 0, phaseCounts: new Map() };
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (pixelBlack(teacher, i)) {
      diag.teacherBlack++;
      cells[i] = { ...clearCell, missing: true };
      continue;
    }
    const tauKey = rgbKey(tauLayer.image, i);
    const topKey = rgbKey(topLayer.image, i);
    const phaseKey = phaseLayer === null ? null : rgbKey(phaseLayer.image, i);
    const tauRaw = tauLayer.colors.valued.has(tauKey);
    const topRaw = topLayer.colors.valued.has(topKey);
    const phaseCloud = phaseLayer !== null && phaseLayer.colors.valued.has(phaseKey);
    if (!tauRaw && !topRaw && !phaseCloud) {
      if (tauKey === '0,0,0' && topKey === '0,0,0') diag.productsBlack++;
      else diag.ownBlackOrUnvalued++;
      cells[i] = clearCell;
      continue;
    }
    const tau = tauRaw ? tauLayer.field.data[i] : NaN;
    const top = topRaw ? topLayer.field.data[i] : NaN;
    const phaseLabel = phaseCloud ? phaseLayer.colors.labelOf.get(phaseKey) : undefined;
    if (phaseCloud) diag.phaseCounts.set(phaseKey, (diag.phaseCounts.get(phaseKey) ?? 0) + 1);
    const tauOk = Number.isFinite(tau);
    const topOk = Number.isFinite(top);
    cells[i] = {
      missing: false,
      cloud: true,
      tau: tauOk ? tau : null,
      topKm: topLayer.kind === 'height' && topOk ? top / 1000 : null,
      topHpa: topLayer.kind === 'pressure' && topOk ? top : null,
      ice: phaseLabel === undefined ? null : /ice/i.test(phaseLabel) ? true : /liquid/i.test(phaseLabel) ? false : null,
    };
  }
  return { cells, diag };
}

// 場面の画素列を 8×8 のタイルへ畳む。
function tileEntries(sceneId, cells) {
  const out = [];
  for (let row = 0; row < TILES_PER_SIDE; row++) {
    for (let col = 0; col < TILES_PER_SIDE; col++) {
      const tileCells = [];
      for (let y = row * TILE_PX; y < (row + 1) * TILE_PX; y++) {
        for (let x = col * TILE_PX; x < (col + 1) * TILE_PX; x++) {
          tileCells.push(cells[y * SIZE + x]);
        }
      }
      out.push({
        scene: sceneId,
        tile: `r${row}c${col}`,
        xKm: (col - (TILES_PER_SIDE - 1) / 2) * TILE_KM,
        yKm: ((TILES_PER_SIDE - 1) / 2 - row) * TILE_KM,
        physical: summarizeTile(tileCells),
      });
    }
  }
  return out;
}

// manifest の採用済み点から場面の一覧を組む。重複は最後の記録、緯度経度の無い
// (既存の画像を採用した)点は BBOX が組めないので外す。
function loadScenes() {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const byKey = new Map();
  for (const point of manifest.points ?? []) {
    if (point.status !== 'ok' || point.latitude === null || point.longitude === null) continue;
    const scene = `${point.category}-${String(point.slot).padStart(3, '0')}`;
    byKey.set(`${point.category}|${point.slot}`, {
      scene,
      category: point.category,
      slot: point.slot,
      latitude: point.latitude,
      longitude: point.longitude,
      date: point.date,
    });
  }
  return [...byKey.values()];
}

// 取得済み場面の記録(雲頂が高度か気圧か、雲相が取れたか)。キャッシュの層名を
// 記録側で引けるようにして、作り直しのとき同じ層を読む。
function loadState() {
  if (!existsSync(stateFile)) return { scenes: {} };
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return { scenes: {} };
  }
}

function saveState(state) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

// 1 場面の 3 製品を取る(キャッシュにあればそのまま)。雲頂は高度製品を優先し、
// 無い日付は気圧製品へ退く。preferredTop は前回の取得で確定した層 — 記録済みの場面は
// 同じ層を読んで結果を揺らさない。雲相は診断用なので、取れなくても場面は捨てない。
async function fetchSceneData(scene, preferredTop) {
  const box = boxAround(scene.latitude, scene.longitude, KM_PER_PX * SIZE);
  const tau = await fetchWmsPng(LAYER_TAU, box, scene.date, SIZE, SIZE);
  let top;
  let topKind;
  if (preferredTop === 'pressure') {
    top = await fetchWmsPng(LAYER_TOP_PRESSURE, box, scene.date, SIZE, SIZE);
    topKind = 'pressure';
  } else {
    try {
      top = await fetchWmsPng(LAYER_TOP_HEIGHT, box, scene.date, SIZE, SIZE);
      topKind = 'height';
    } catch {
      top = await fetchWmsPng(LAYER_TOP_PRESSURE, box, scene.date, SIZE, SIZE);
      topKind = 'pressure';
    }
  }
  let phase = null;
  try {
    phase = await fetchWmsPng(LAYER_PHASE, box, scene.date, SIZE, SIZE);
  } catch {
    // 雲相が無い日は null のまま — iceFrac は null に畳む。
  }
  return { tau, top, topKind, phase };
}

// 場面の製品バイト列から復号して、真色と合わせて全画素の分類 cell を返す。
async function sceneCells(scene, data) {
  // 層ごとに、復号した場・色の画像・表の値を持つ色の集合を組む。
  const layer = async (name, bytes, kind) => {
    const decoded = await decodeLayer(name, bytes);
    return {
      kind,
      field: decoded.field,
      image: decodePng(Buffer.from(bytes)),
      colors: await colormapColors(decoded),
    };
  };
  const tau = await layer(LAYER_TAU, data.tau.bytes, 'tau');
  const top = await layer(data.topKind === 'height' ? LAYER_TOP_HEIGHT : LAYER_TOP_PRESSURE, data.top.bytes, data.topKind);
  const phase = data.phase === null ? null : await layer(LAYER_PHASE, data.phase.bytes, 'phase');
  const teacher = decodePng(readFileSync(path.join(teacherDir, `${scene.scene}-${KM_PER_PX}km.png`)));
  return classifyPixels(tau, top, phase, teacher);
}

// 区分が偏らない順(場面の番号順で区分を巡る)。
function sceneOrder(scenes) {
  const rank = (category) => CATEGORY_ORDER.indexOf(category);
  return [...scenes].sort((a, b) => a.slot - b.slot || rank(a.category) - rank(b.category));
}

// 区分ごとの 9 分類+晴天+高さ不明の平均の割合と、deep/highThin を超えるタイルの割合を出す。
function printSummary(tileRows, sceneCount, newCount) {
  const byCategory = new Map();
  for (const row of tileRows) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, []);
    byCategory.get(row.category).push(row.physical);
  }
  const colNames = [...CLASS_NAMES, 'clear', 'unkn'];
  const keys = [...CLASS_NAMES, 'clearFrac', 'unknownHeightFrac'];
  // 区分ごとの表。値は有効率が下限以上のタイルの平均で、null のタイルは外す。
  const printTable = (names, metricKeys, width) => {
    console.log(`${'category'.padEnd(14)} ${names.map((n) => n.slice(0, width - 1).padStart(width)).join(' ')}`);
    for (const category of CATEGORY_ORDER.filter((c) => byCategory.has(c))) {
      const rows = byCategory.get(category).filter((p) => p.validFrac >= MIN_VALID_FRAC);
      const cells = metricKeys.map((k) => {
        const vals = rows.map((p) => p[k]).filter((v) => v !== null);
        return vals.length > 0 ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3).padStart(width) : '-'.padStart(width);
      });
      console.log(`${category.padEnd(14)} ${cells.join(' ')}`);
    }
  };
  console.log(`場面 ${sceneCount} 件(今回の取得 ${newCount})・タイル ${tileRows.length} 枚`);
  console.log(`\n区分ごとの平均の割合(欠測を除く画素が分母、タイル平均):`);
  printTable(colNames, keys, 6);
  console.log('\n雲頂の段と τ の欠測の内訳(区分ごとの平均の割合。分母は欠測を除く画素):');
  printTable(
    ['topHi', 'topMid', 'topLow', 'noTop', 'hiNoT', 'miNoT', 'loNoT'],
    ['topHighFrac', 'topMiddleFrac', 'topLowFrac', 'noTopFrac', 'highNoTauFrac', 'middleNoTauFrac', 'lowNoTauFrac'],
    7,
  );
  const validFracs = tileRows.map((row) => row.physical.validFrac);
  console.log(`\nvalidFrac の分布: p10=${quantile(validFracs, 0.1)?.toFixed(3)}`
    + ` p50=${quantile(validFracs, 0.5)?.toFixed(3)} p90=${quantile(validFracs, 0.9)?.toFixed(3)}`
    + ` <0.5 のタイル ${validFracs.filter((v) => v < MIN_VALID_FRAC).length}/${validFracs.length}`);
  console.log('\n深い対流・薄い高層雲を含むタイルの割合(区分ごと):');
  console.log(`${'category'.padEnd(14)} ${'deep>0.05'.padStart(10)} ${'thinH>0.2'.padStart(10)}`);
  for (const category of CATEGORY_ORDER.filter((c) => byCategory.has(c))) {
    const rows = byCategory.get(category).filter((p) => p.validFrac >= MIN_VALID_FRAC);
    const share = (f) => (rows.length === 0 ? null : rows.filter(f).length / rows.length);
    console.log(`${category.padEnd(14)} ${String(share((p) => p.deepFrac > 0.05)?.toFixed(3) ?? '-').padStart(10)}`
      + ` ${String(share((p) => p.highThinFrac > 0.2)?.toFixed(3) ?? '-').padStart(10)}`);
  }
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--max-scenes='));
  const maxNew = arg === undefined ? Infinity : Number(arg.split('=')[1]);
  const scenes = sceneOrder(loadScenes());
  const state = loadState();
  let newCount = 0;
  const tileRows = [];
  const sceneEntries = [];
  for (const scene of scenes) {
    const recorded = state.scenes[scene.scene] !== undefined;
    if (!recorded && newCount >= maxNew) continue;
    let data;
    try {
      data = await fetchSceneData(scene, state.scenes[scene.scene]?.top);
    } catch (e) {
      console.error(`${scene.scene}: 製品を取得できない(${e.message}) — 場面を捨てる`);
      continue;
    }
    if (!recorded) {
      state.scenes[scene.scene] = { top: data.topKind, phase: data.phase !== null };
      saveState(state);
      newCount++;
    }
    const { cells, diag } = await sceneCells(scene, data);
    for (const entry of tileEntries(scene.scene, cells)) tileRows.push({ category: scene.category, ...entry });
    sceneEntries.push({
      scene: scene.scene,
      category: scene.category,
      latitude: scene.latitude,
      longitude: scene.longitude,
      date: scene.date,
      top: data.topKind,
    });
    // 分類の内訳をログへ残す(欠測・晴天の区別の点検用)。
    const counts = { missing: 0, clear: 0, cloud: 0 };
    for (const cell of cells) counts[cell.missing ? 'missing' : cell.cloud ? 'cloud' : 'clear'] += 1;
    console.error(`${scene.scene}: 欠測 ${counts.missing}(真色黒 ${diag.teacherBlack})`
      + `・晴天 ${counts.clear}(製品すべて黒 ${diag.productsBlack}・その他の無値 ${diag.ownBlackOrUnvalued})`
      + `・雲 ${counts.cloud} (top=${data.topKind}, phase=${data.phase !== null})`
      + ` 雲相の色 ${JSON.stringify([...diag.phaseCounts.entries()])}`);
  }
  mkdirSync(outDir, { recursive: true });
  const out = {
    tool: 'cloud-regime-physical',
    generatedAt: new Date().toISOString(),
    layers: {
      tau: LAYER_TAU,
      topHeight: LAYER_TOP_HEIGHT,
      topPressure: LAYER_TOP_PRESSURE,
      phase: LAYER_PHASE,
    },
    thresholds: {
      source: 'ISCCP D series (Rossow & Schiffer 1999)',
      tau: [TAU_BOUND.thinMid, TAU_BOUND.midThick],
      topKm: [TOP_KM_BOUND.lowMiddle, TOP_KM_BOUND.middleHigh],
      topHpa: [TOP_HPA_BOUND.lowMiddle, TOP_HPA_BOUND.middleHigh],
    },
    scenes: sceneEntries,
    tiles: tileRows.map(({ scene, tile, xKm, yKm, physical }) => ({ scene, tile, xKm, yKm, physical })),
  };
  writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
  printSummary(tileRows, sceneEntries.length, newCount);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
