// 気象条件 → 雲の形の応答を、実写と生成で比べる。
// 実写の標本(teacher-tiles.json の形態特徴へ teacher-conditions.json の条件を (scene, tile) で結合)と、
// 同じ緯度経度・区分で render-lab が撮った生成の絵(4 km/px、表示時刻は生成の気象状態の時刻を
// 場面の並びへ巡回で割り当て)へ、同じ物差し — 256 km タイルの形態特徴と、節点の格子から導く条件 —
// を当てる。応答の距離・説明される分散・バリオグラム・気象型を比べ、見出しの点数を場面単位の
// ブートストラップ(200 回)の中央値と 5〜95% 点つきで出す。
//
// 使い方: CLOUD_DETAIL_PORT=8842 CLOUD_DETAIL_DEBUG_PORT=9542 node tools/cloud-regime-compare.mjs
//   --fresh で撮影を撮り直す。作業ツリーの .loop-regime.json({ "fresh": true, "maxScenes": 40 })でも
//   同じ指定ができる。
// 出力: .cloud-detail/regime/compare/report.md・report.json・regime-<id>.png、
//   .cloud-detail/regime/history/<時刻>-<commit>.json、
//   .cloud-detail/regime/generated-shots/(撮影のキャッシュと manifest)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { cloudSignalField, tileFeatures, TILE_PX } from './cloud-regime-features.mjs';
import {
  explainedVariance,
  explainedVarianceJoint,
  mulberry32,
  pearson,
  quantileSorted,
  regimeTable,
  responseDistance,
  variogramDistance,
  withAlignment,
  withConditionRanks,
  REGIMES,
} from './cloud-regime-metrics.mjs';
import { offsetToLatLon } from './cloud-regime-reanalysis.mjs';
import { generatedTileConditions } from './cloud-regime-generated.mjs';
import { loadGeneratedWeather } from './cloud-regime-weather.mjs';
import { gitHead } from './cloud-report-history.mjs';
import { decodePng, encodeRgbPng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const regimeDir = path.join(root, '.cloud-detail', 'regime');
const shotsDir = path.join(regimeDir, 'generated-shots');
const compareDir = path.join(regimeDir, 'compare');
const historyDir = path.join(regimeDir, 'history');
const weatherDir = path.join(regimeDir, 'generated-weather');
const teacherDir = path.join(root, '.cloud-detail', 'random-teacher');
const teacherTilesFile = path.join(regimeDir, 'teacher-tiles.json');
const teacherConditionsFile = path.join(regimeDir, 'teacher-conditions.json');
const weatherManifestFile = path.join(weatherDir, 'manifest.json');
const shotsManifestFile = path.join(shotsDir, 'manifest.json');
const renderLabDir = path.join(root, '.render-lab');
const loopConfigFile = path.join(root, '.loop-regime.json');

// 配信と CDP のポート。環境変数で上書きできる(別の作業ツリーの計測と並行して走らせられる)。
const port = Number(process.env.CLOUD_DETAIL_PORT ?? 8842);
const debugPort = Number(process.env.CLOUD_DETAIL_DEBUG_PORT ?? 9542);

// 場面とタイルの物差し。実写の教師と同じ 4 km/px・64 px(256 km)タイル・8×8。生成の絵は
// 中央 CROP_PX を切り出してから同じ格子へ当てる。
const KM_PER_PX = 4;
const CROP_PX = 512;
const GRID = 8;
// 撮影の太陽は場面の中心で現地太陽時 10:30・赤緯 0(tools/render-lab/cloud-detail-cases.ts の
// sunAnglesForLocal1030)。タイルの経度ずれを時角へ足す。照明に足す一様な環境光は描画設定の
// AMBIENT_FRACTION(cloud-detail-distribution.mjs の SHOT_AMBIENT_FRACTION と同じ)。
const SUN_HOUR_ANGLE_DEG = -22.5;
const SHOT_AMBIENT_FRACTION = 0.03;

// 応答を比べる条件。両側で同じ名前・意味を持つ主の条件と、片側だけの条件。
// 単位の揃わない条件(advection・front・湿度)は順位の比較になる。
const CONDITIONS_MAIN = [
  'lift', 'cyclonic', 'slp', 'advection', 'front', 'humidLow', 'humidUp',
  'windLow', 'shear', 'land', 'meanCloudiness',
];
const CONDITIONS_REAL_ONLY = ['stability'];
const CONDITIONS_GEN_ONLY = ['band', 'convectiveActivity', 'anvil'];
// 統計へ渡す特徴量(向きの円周量 orientDeg は除き、withAlignment が足す alignLow・alignUp を含む)。
const FEATURES = [
  'cover', 'coverDense', 'toneCloud', 'scaleKm', 'texture', 'aniso',
  'edge', 'euler', 'clump', 'alignLow', 'alignUp',
];
// 形の特徴量。cover が両極のタイル(ほぼ晴れ・ほぼ全面の雲)では形が定義できず雑音になるので、
// そのタイルではこれらを null にしてから統計へ渡す。
const SHAPE_FEATURES = ['scaleKm', 'texture', 'aniso', 'edge', 'euler', 'clump', 'alignLow', 'alignUp'];
const SHAPE_COVER_MIN = 0.05;
const SHAPE_COVER_MAX = 0.95;
// 物理単位の揃う条件。周辺分布を物理量のまま比べる。
const MARGINAL_CONDITIONS = ['slp', 'cyclonic', 'lift', 'windLow', 'windUp', 'shear'];
const MARGINAL_QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
// η² の直積の条件。
const JOINT_CONDITIONS = ['lift', 'advection', 'humidLow'];
// 緯度帯の切り分け。交絡を除くため、(a)(b)(f) は全域に加えてこの 2 帯でも出す。
const BANDS = [
  { id: 'all', label: '全域', test: () => true },
  { id: 'tropics', label: '熱帯(|緯度| < 25)', test: (lat) => Math.abs(lat) < 25 },
  { id: 'extratropics', label: '中高緯度(|緯度| ≥ 25)', test: (lat) => Math.abs(lat) >= 25 },
];
// 見出しの点数は全タイルと、雪氷・砂漠の誤認を除いた海のタイルだけの 2 通り。
const SUBSETS = [
  { id: 'all', label: '全タイル', test: () => true },
  { id: 'sea', label: '海(land < 0.2)', test: (s) => isNum(s.conditions?.land) && s.conditions.land < 0.2 },
];
const BOOTSTRAP_RESAMPLES_DEFAULT = 200;
const BOOTSTRAP_SEED = 2024;
// 巻雲の光学深さの係数。cloud-kind.ts の CIRRUS_MAX_OPTICAL_DEPTH と同じ値 — 全天の被覆は
// 積雲と巻雲を重ねた 1 − (1 − cumulusOpacity)·exp(−cirrus²·3)(views.ts の空の式)で見る。
// 絵の cover は薄い巻雲にも反応するので、cumulus だけの coverage チャンネルでは向きが確かめられない。
const CIRRUS_MAX_OPTICAL_DEPTH = 3;
// 気象状態のサンプルから、描画と同じ全天の被覆率を組み立てる。
const totalCoverage = (s) => 1 - (1 - s.coverage) * Math.exp(-(s.cirrus * s.cirrus) * CIRRUS_MAX_OPTICAL_DEPTH);
// 絵の cover と向きを確かめるチャンネルの候補。coverage は積雲だけの不透明度、全天被覆は巻雲を
// 重ねた描画の式(views.ts の空)と同じ、meanCloudiness は静的な気候の雲量 — 向きの正しさは
// 静的な場でも見えるので、対応が弱いときの切り分けとして全部を表に出す。
const COVERAGE_CHANNELS = [
  { id: 'coverage', label: 'coverage(積雲のみ)', of: (s) => s.coverage },
  { id: 'total', label: '全天被覆', of: (s) => totalCoverage(s) },
  { id: 'meanCloudiness', label: 'meanCloudiness', of: (s) => s.meanCloudiness },
];
// 幾何の検算に使う向きの候補。cover はタイルの向きに無関心な統計なので、反転はタイルの座標の
// 対応だけがずれる — 正しい向きの相関がいちばん高いはず。
const ORIENTATIONS = [
  { id: 'identity', label: '恒等', map: (r, c) => [r, c] },
  { id: 'flipX', label: '左右反転', map: (r, c) => [r, GRID - 1 - c] },
  { id: 'flipY', label: '上下反転', map: (r, c) => [GRID - 1 - r, c] },
  { id: 'rot180', label: '180° 回転', map: (r, c) => [GRID - 1 - r, GRID - 1 - c] },
];
const ORIENTATION_MIN_CORR = 0.4;
// 見比べ用のモンタージュに並べるタイル数と、タイルの絵の拡大率(64 px → 256 px)。
const MONTAGE_PICKS = 8;
const MONTAGE_SCALE = 4;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// 文字列から決定的な 32 bit の種(FNV-1a)。
function seedOf(text) {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function quantiles(values, fractions = MARGINAL_QUANTILES) {
  const sorted = values.filter(isNum).sort((a, b) => a - b);
  return fractions.map((f) => quantileSorted(sorted, f));
}

// render-lab を webpack で組む(cloud-detail:distribution と同じ呼び出し)。
function buildRenderLab() {
  const cli = path.join(root, 'node_modules', 'webpack-cli', 'bin', 'cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cli, '--config', 'webpack.render-lab.config.js', '--mode', 'production'],
      { cwd: root, stdio: 'inherit' },
    );
    child.on('exit', (code) => (
      code === 0 ? resolve() : reject(new Error(`webpack exited with code ${code}`))
    ));
    child.on('error', reject);
  });
}

// 時刻 hours [h] の撮影名と気象ファイル名。
const shotName = (scene, hours) => `${scene}-h${String(hours).padStart(4, '0')}`;
const shotFile = (name) => path.join(shotsDir, `${name}.png`);
const weatherFile = (hours) => path.join(weatherDir, `h${String(hours).padStart(4, '0')}.f32`);

// 足りない撮影を .render-lab のページで撮る。missing の各要素へ返った centerKmPerPx・altitudeM を書き込む。
async function shootMissing(missing) {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: renderLabDir, port, debugPort, profilePrefix: 'cloud-regime-',
    onEvent, requestTimeoutMs: 300_000,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.shootCloudDetailRandom === 'function')",
      'the render lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);
    let taken = 0;
    for (const entry of missing) {
      const result = await devTools.evaluate(
        `window.renderLab.shootCloudDetailRandom(${JSON.stringify(entry.name)}, ${JSON.stringify(entry.point)})`);
      writeFileSync(shotFile(entry.name), Buffer.from(result.png.slice(result.png.indexOf(',') + 1), 'base64'));
      entry.centerKmPerPx = result.centerKmPerPx;
      entry.altitudeM = result.altitudeM;
      taken++;
      if (taken % 10 === 0 || taken === missing.length) console.log(`shot ${taken}/${missing.length} ${entry.name}`);
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
    return taken;
  } finally {
    await session.close();
  }
}

// 撮った絵を中心の実寸 centerKmPerPx から KM_PER_PX ちょうどへ双線形で引き直し、中央
// CROP_PX×CROP_PX を切り出した RGB の PNG バイト列を返す。
function resampleCropPng(png, centerKmPerPx) {
  const scale = centerKmPerPx / KM_PER_PX;
  const outWidth = Math.round(png.width * scale);
  const outHeight = Math.round(png.height * scale);
  if (outWidth < CROP_PX || outHeight < CROP_PX) {
    throw new Error(`引き直した絵が ${outWidth}×${outHeight} で ${CROP_PX} より小さい(centerKmPerPx=${centerKmPerPx})`);
  }
  const resampled = new Uint8Array(outWidth * outHeight * 3);
  const pixel = (x, y, c) => {
    const px = Math.min(png.width - 1, Math.max(0, x));
    const py = Math.min(png.height - 1, Math.max(0, y));
    return png.data[(py * png.width + px) * png.channels + c];
  };
  for (let y = 0; y < outHeight; y++) {
    const fy = (y + 0.5) / scale - 0.5;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let x = 0; x < outWidth; x++) {
      const fx = (x + 0.5) / scale - 0.5;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const v00 = pixel(x0, y0, c);
        const v10 = pixel(x0 + 1, y0, c);
        const v01 = pixel(x0, y0 + 1, c);
        const v11 = pixel(x0 + 1, y0 + 1, c);
        resampled[(y * outWidth + x) * 3 + c] = Math.round(
          (1 - ty) * ((1 - tx) * v00 + tx * v10) + ty * ((1 - tx) * v01 + tx * v11));
      }
    }
  }
  const x0 = Math.floor((outWidth - CROP_PX) / 2);
  const y0 = Math.floor((outHeight - CROP_PX) / 2);
  const cropped = new Uint8Array(CROP_PX * CROP_PX * 3);
  for (let y = 0; y < CROP_PX; y++) {
    cropped.set(
      resampled.subarray(((y + y0) * outWidth + x0) * 3, ((y + y0) * outWidth + x0 + CROP_PX) * 3),
      y * CROP_PX * 3,
    );
  }
  return encodeRgbPng(CROP_PX, CROP_PX, cropped);
}

// 切り出しの各画素の照明 = cos(太陽天頂角) + 環境光。時角は場面の中心の −22.5° に
// その画素の経度ずれを足す(赤緯 0 なので cosZ = cos(緯度)·cos(時角))。
function illuminationField(lat0, lon0) {
  const out = new Float32Array(CROP_PX * CROP_PX);
  for (let y = 0; y < CROP_PX; y++) {
    for (let x = 0; x < CROP_PX; x++) {
      const xKm = (x + 0.5 - CROP_PX / 2) * KM_PER_PX;
      const yKm = (CROP_PX / 2 - y - 0.5) * KM_PER_PX;
      const { lat, lon } = offsetToLatLon(lat0, lon0, xKm, yKm);
      const hour = ((SUN_HOUR_ANGLE_DEG + (lon - lon0)) * Math.PI) / 180;
      out[y * CROP_PX + x] = Math.cos((lat * Math.PI) / 180) * Math.cos(hour) + SHOT_AMBIENT_FRACTION;
    }
  }
  return out;
}

// 生成の撮影 1 場面ぶんの標本と、幾何の検算に使うタイルの cover。切り出した絵へ
// 照明の配列を当てて雲の信号へ直し、8×8 のタイルへ特徴を測る。各タイルの条件は
// cloud-regime-generated.mjs の shared 部品(generatedTileConditions)から取る。
function generatedSamples(scene, weather, centerKmPerPx) {
  const shot = decodePng(readFileSync(shotFile(shotName(scene.scene, scene.hours))));
  const croppedPng = resampleCropPng(shot, centerKmPerPx);
  const field = cloudSignalField(croppedPng, {
    illumination: illuminationField(scene.latitude, scene.longitude),
  });
  const tiles = tileFeatures(field, KM_PER_PX, TILE_PX);
  const conditionByTile = new Map(
    generatedTileConditions(scene, weather).map((t) => [`${t.row}|${t.col}`, t]));
  return tiles.map((tile) => {
    const c = conditionByTile.get(`${tile.row}|${tile.col}`);
    return {
      side: 'generated',
      scene: scene.scene,
      tile: `r${tile.row}c${tile.col}`,
      row: tile.row,
      col: tile.col,
      xKm: tile.xKm,
      yKm: tile.yKm,
      lat: c.lat,
      lon: c.lon,
      features: tile.features,
      conditions: c.conditions,
    };
  });
}

// 形の特徴量を、cover が 0.05〜0.95 のタイルだけが持つ形へ直す(ほかは null)。
// 元の配列は書き換えない。
function maskShapeFeatures(samples) {
  return samples.map((s) => {
    const cover = s.features?.cover;
    if (isNum(cover) && cover >= SHAPE_COVER_MIN && cover <= SHAPE_COVER_MAX) return s;
    return {
      ...s,
      features: { ...s.features, ...Object.fromEntries(SHAPE_FEATURES.map((f) => [f, null])) },
    };
  });
}

// 見出しの点数 4 つ。responseDistance・explainedVariance・variogramDistance が
// null を返した組は数えない。
function headlineOf(realSamples, genSamples) {
  let contrastSum = 0;
  let biasSum = 0;
  let responseN = 0;
  let etaSum = 0;
  let etaN = 0;
  for (const condition of CONDITIONS_MAIN) {
    for (const feature of FEATURES) {
      const d = responseDistance(realSamples, genSamples, condition, feature);
      if (isNum(d.contrast) && isNum(d.bias)) {
        contrastSum += d.contrast;
        biasSum += Math.abs(d.bias);
        responseN++;
      }
      const etaReal = explainedVariance(realSamples, condition, feature);
      const etaGen = explainedVariance(genSamples, condition, feature);
      if (isNum(etaReal) && isNum(etaGen)) {
        etaSum += Math.abs(etaGen - etaReal);
        etaN++;
      }
    }
  }
  let variogramSum = 0;
  let variogramN = 0;
  for (const feature of FEATURES) {
    const vd = variogramDistance(realSamples, genSamples, feature);
    if (isNum(vd.distance)) {
      variogramSum += vd.distance;
      variogramN++;
    }
  }
  return {
    responseContrast: responseN > 0 ? contrastSum / responseN : null,
    responseBias: responseN > 0 ? biasSum / responseN : null,
    variogramDistance: variogramN > 0 ? variogramSum / variogramN : null,
    explainedGap: etaN > 0 ? etaSum / etaN : null,
  };
}

// 場面を単位にした再標本化で、見出しの点数 4 つの中央値と 5〜95% 点を取る。
// metrics の bootstrapByScene と同じ手順を、4 値まとめて引くためにここで組む。
function bootstrapScores(realSamples, genSamples, resamples = BOOTSTRAP_RESAMPLES_DEFAULT, seed = BOOTSTRAP_SEED) {
  const groupByScene = (samples) => {
    const map = new Map();
    for (const s of samples) {
      if (!map.has(s.scene)) map.set(s.scene, []);
      map.get(s.scene).push(s);
    }
    return [...map.values()];
  };
  const realScenes = groupByScene(realSamples);
  const genScenes = groupByScene(genSamples);
  const rng = mulberry32(seed);
  const pick = (scenes) => {
    const out = [];
    for (let i = 0; i < scenes.length; i++) out.push(...scenes[Math.floor(rng() * scenes.length)]);
    return out;
  };
  const draws = { responseContrast: [], responseBias: [], variogramDistance: [], explainedGap: [] };
  for (let r = 0; r < resamples; r++) {
    const scores = headlineOf(pick(realScenes), pick(genScenes));
    for (const key of Object.keys(draws)) if (isNum(scores[key])) draws[key].push(scores[key]);
  }
  return Object.fromEntries(Object.entries(draws).map(([key, values]) => {
    values.sort((a, b) => a - b);
    return [key, {
      median: quantileSorted(values, 0.5),
      p05: quantileSorted(values, 0.05),
      p95: quantileSorted(values, 0.95),
      draws: values.length,
    }];
  }));
}

// (a) 応答の距離の表。条件 × 特徴量ごとの bias・contrast・gainRatio・corr。
function responseTable(realSamples, genSamples) {
  const rows = [];
  for (const condition of CONDITIONS_MAIN) {
    for (const feature of FEATURES) {
      const d = responseDistance(realSamples, genSamples, condition, feature);
      rows.push({ condition, feature, bias: d.bias, contrast: d.contrast, gainRatio: d.gainRatio, corr: d.corr });
    }
  }
  return rows;
}

// (b) 説明される分散 η²。両側に条件があるものは実写・生成の両方、片側だけのものは片側だけ出す。
function explainedTable(realSamples, genSamples) {
  const rows = [];
  const names = [...CONDITIONS_MAIN, ...CONDITIONS_REAL_ONLY, ...CONDITIONS_GEN_ONLY];
  for (const condition of names) {
    for (const feature of FEATURES) {
      rows.push({
        condition,
        feature,
        real: explainedVariance(realSamples, condition, feature),
        generated: explainedVariance(genSamples, condition, feature),
      });
    }
  }
  return rows;
}

// 直積 [lift, advection, humidLow] の η²(特徴量ごと)。
function explainedJoint(realSamples, genSamples) {
  return FEATURES.map((feature) => ({
    feature,
    real: explainedVarianceJoint(realSamples, JOINT_CONDITIONS, feature),
    generated: explainedVarianceJoint(genSamples, JOINT_CONDITIONS, feature),
  }));
}

// (c) バリオグラムの距離(特徴量ごと)と、場面内の分散 ÷ 全分散(実写・生成)。
function variogramTable(realSamples, genSamples) {
  const withinRatio = (samples, feature) => {
    const byScene = new Map();
    for (const s of samples) {
      if (!byScene.has(s.scene)) byScene.set(s.scene, []);
      byScene.get(s.scene).push(s);
    }
    const values = samples.map((s) => s.features?.[feature]).filter(isNum);
    if (values.length === 0) return null;
    const grand = values.reduce((s, v) => s + v, 0) / values.length;
    let within = 0;
    for (const group of byScene.values()) {
      const local = group.map((s) => s.features?.[feature]).filter(isNum);
      if (local.length === 0) continue;
      const mean = local.reduce((s, v) => s + v, 0) / local.length;
      within += local.reduce((s, v) => s + (v - mean) ** 2, 0);
    }
    const total = values.reduce((s, v) => s + (v - grand) ** 2, 0);
    return total > 0 ? within / total : null;
  };
  return FEATURES.map((feature) => {
    const vd = variogramDistance(realSamples, genSamples, feature);
    return {
      feature,
      distance: vd.distance,
      rangeRatio: vd.rangeRatio,
      realWithin: withinRatio(realSamples, feature),
      generatedWithin: withinRatio(genSamples, feature),
    };
  });
}

// (e) 条件の周辺分布。物理単位の揃う条件の p5・p25・p50・p75・p95。
function marginalTable(realSamples, genSamples) {
  return MARGINAL_CONDITIONS.map((condition) => ({
    condition,
    real: quantiles(realSamples.map((s) => s.conditions?.[condition])),
    generated: quantiles(genSamples.map((s) => s.conditions?.[condition])),
  }));
}

const fmt = (v, digits = 3) => (isNum(v) ? Number(v.toPrecision(digits)) : '—');
const padL = (text, width) => String(text).padEnd(width);
const padR = (text, width) => String(text).padStart(width);

// markdown の表。
function mdTable(headerCells, rows) {
  const lines = [
    `| ${headerCells.join(' | ')} |`,
    `| ${headerCells.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
  return lines.join('\n');
}

// (a) の 4 指標を、条件 × 特徴量の表として出す。
function responseMdTable(rows, metric) {
  return mdTable(
    ['条件', ...FEATURES],
    CONDITIONS_MAIN.map((condition) => [
      condition,
      ...FEATURES.map((feature) => fmt(
        rows.find((r) => r.condition === condition && r.feature === feature)?.[metric])),
    ]),
  );
}

// 特徴量 × 条件の η² 表(実写 / 生成 を並べる)。
function explainedMdTable(rows) {
  const names = [...CONDITIONS_MAIN, ...CONDITIONS_REAL_ONLY, ...CONDITIONS_GEN_ONLY];
  return mdTable(
    ['条件', '側', ...FEATURES],
    names.flatMap((condition) => {
      const cells = (side) => FEATURES.map((feature) => fmt(
        rows.find((r) => r.condition === condition && r.feature === feature)?.[side]));
      return [[condition, '実写', ...cells('real')], ['', '生成', ...cells('generated')]];
    }),
  );
}

async function main() {
  const loopConfig = existsSync(loopConfigFile)
    ? JSON.parse(readFileSync(loopConfigFile, 'utf8'))
    : {};
  const fresh = process.argv.includes('--fresh') || loopConfig.fresh === true;
  const maxScenes = loopConfig.maxScenes ?? Infinity;
  const bootstrapArg = process.argv.find((a) => a.startsWith('--bootstrap='));
  const bootstrapResamples = bootstrapArg === undefined
    ? BOOTSTRAP_RESAMPLES_DEFAULT
    : Number(bootstrapArg.split('=')[1]);

  // --- 実写の標本: 教師のタイルの特徴へ、場面単位の条件を (scene, tile) で付ける ---
  const teacherTiles = JSON.parse(readFileSync(teacherTilesFile, 'utf8'));
  const teacherConditions = JSON.parse(readFileSync(teacherConditionsFile, 'utf8'));
  const conditionByKey = new Map(teacherConditions.tiles.map((t) => [`${t.scene}|${t.tile}`, t]));
  const realSamples = [];
  for (const s of teacherTiles.samples) {
    const conditionTile = conditionByKey.get(`${s.scene}|${s.tile}`);
    if (conditionTile === undefined) continue;
    realSamples.push({
      side: 'real',
      scene: s.scene,
      tile: s.tile,
      xKm: s.xKm,
      yKm: s.yKm,
      lat: s.lat,
      lon: s.lon,
      features: s.features,
      conditions: conditionTile.conditions,
    });
  }
  // 条件のある場面を、条件ファイルの並びの順で取る。
  const scenes = teacherConditions.scenes
    .filter((s) => realSamples.some((t) => t.scene === s.scene))
    .slice(0, maxScenes);
  if (scenes.length === 0) throw new Error('条件のある教師の場面が無い(teacher-conditions.json を確認)');
  const sceneIds = new Set(scenes.map((s) => s.scene));
  const real = realSamples.filter((s) => sceneIds.has(s.scene));
  console.log(`実写の標本: ${scenes.length} 場面・${real.length} タイル`);

  // --- 生成の時刻の割り当て: 気象状態の時刻一覧を場面の並びへ巡回 ---
  if (!existsSync(weatherManifestFile)) {
    throw new Error(`${weatherManifestFile} が無い — 先に node tools/cloud-regime-weather.mjs を実行する`);
  }
  const weatherManifest = JSON.parse(readFileSync(weatherManifestFile, 'utf8'));
  const hoursList = weatherManifest.hours;
  for (const hours of hoursList) {
    if (!existsSync(weatherFile(hours))) throw new Error(`${weatherFile(hours)} が無い`);
  }
  scenes.forEach((scene, i) => { scene.hours = hoursList[i % hoursList.length]; });

  // --- 生成の撮影: 条件のある場面と同じ緯度経度・区分で 4 km/px の絵を撮る ---
  const targets = scenes.map((scene) => ({
    name: shotName(scene.scene, scene.hours),
    scene: scene.scene,
    category: scene.category,
    hours: scene.hours,
    point: {
      category: scene.category,
      latitudeDeg: scene.latitude,
      longitudeDeg: scene.longitude,
      displayTime: scene.hours * 3600,
      tierKmPerPx: KM_PER_PX,
    },
  }));
  mkdirSync(shotsDir, { recursive: true });
  if (fresh) for (const target of targets) rmSync(shotFile(target.name), { force: true });
  const missing = targets.filter((target) => !existsSync(shotFile(target.name)));
  if (missing.length > 0) {
    console.log('=== webpack --config webpack.render-lab.config.js --mode production ===');
    await buildRenderLab();
    await shootMissing(missing);
  }
  console.log(`生成の撮影: 全 ${targets.length} 枚のうち ${missing.length} 枚を新たに撮った`);

  // 撮影の記録。撮ったとき・一覧が変わったときだけ書く。
  const previousShots = existsSync(shotsManifestFile)
    ? JSON.parse(readFileSync(shotsManifestFile, 'utf8')).shots ?? []
    : [];
  const shotInfoByName = new Map(previousShots.map((shot) => [shot.name, shot]));
  const shotInfos = targets.map((target) => ({
    name: target.name,
    scene: target.scene,
    category: target.category,
    latitudeDeg: target.point.latitudeDeg,
    longitudeDeg: target.point.longitudeDeg,
    hours: target.hours,
    displayTime: target.point.displayTime,
    tierKmPerPx: KM_PER_PX,
    centerKmPerPx: target.centerKmPerPx ?? shotInfoByName.get(target.name)?.centerKmPerPx ?? null,
    altitudeM: target.altitudeM ?? shotInfoByName.get(target.name)?.altitudeM ?? null,
  }));
  const listChanged = previousShots.map((shot) => shot.name).join('\n')
    !== shotInfos.map((shot) => shot.name).join('\n');
  const commit = gitHead(root);
  if (missing.length > 0 || listChanged) {
    writeFileSync(shotsManifestFile, `${JSON.stringify({
      tool: 'cloud-regime-compare',
      generatedAt: new Date().toISOString(),
      commit,
      shots: shotInfos,
    }, null, 2)}\n`);
  }

  // --- 生成の標本: 撮影をタイルへ切り、気象状態から条件を付ける ---
  const weatherByHour = new Map(hoursList.map((h) => [h, loadGeneratedWeather(h)]));
  const shotInfoMap = new Map(shotInfos.map((info) => [info.name, info]));
  const generated = [];
  // 幾何の検算に使う、場面ごとのタイルの cover(向きの候補を当てる材料)。
  const coverCheck = [];
  for (const scene of scenes) {
    const weather = weatherByHour.get(scene.hours);
    const info = shotInfoMap.get(shotName(scene.scene, scene.hours));
    const samples = generatedSamples(
      scene, weather, info?.centerKmPerPx ?? KM_PER_PX);
    generated.push(...samples);
    const covers = new Map(samples.map((s) => [`${s.row}|${s.col}`, s.features.cover]));
    coverCheck.push({ scene, covers });
  }
  console.log(`生成の標本: ${scenes.length} 場面・${generated.length} タイル`);

  // --- 幾何の検算: 4 通りの向きで、タイルの cover と気象状態の被覆の相関 ---
  // cover は「雲の信号 > 閾値」の割合 — 明るい地表(砂漠・雪氷)では雲が無くても 1 に張り付き、
  // 気象の被覆との対応を壊すので、陸の被覆が小さいタイルだけ(landFraction < 0.2)でも別集計する。
  const orientationCorr = { pooled: {}, sea: {} };
  for (const channel of COVERAGE_CHANNELS) {
    for (const orientation of ORIENTATIONS) {
      const pooled = { xs: [], ys: [] };
      const sea = { xs: [], ys: [] };
      for (const scene of scenes) {
        const weather = weatherByHour.get(scene.hours);
        const { covers } = coverCheck.find((c) => c.scene === scene);
        for (let row = 0; row < GRID; row++) {
          for (let col = 0; col < GRID; col++) {
            const [srcRow, srcCol] = orientation.map(row, col);
            const cover = covers.get(`${srcRow}|${srcCol}`);
            const xKm = (col - (GRID - 1) / 2) * TILE_PX * KM_PER_PX;
            const yKm = ((GRID - 1) / 2 - row) * TILE_PX * KM_PER_PX;
            const { lat, lon } = offsetToLatLon(scene.latitude, scene.longitude, xKm, yKm);
            const s = weather.sampleAt(lat, lon);
            const value = channel.of(s);
            if (isNum(cover) && isNum(value)) {
              pooled.xs.push(cover);
              pooled.ys.push(value);
              if (isNum(s.landFraction) && s.landFraction < 0.2) {
                sea.xs.push(cover);
                sea.ys.push(value);
              }
            }
          }
        }
      }
      orientationCorr.pooled[channel.id] ??= {};
      orientationCorr.pooled[channel.id][orientation.id] = pearson(pooled.xs, pooled.ys);
      orientationCorr.sea[channel.id] ??= {};
      orientationCorr.sea[channel.id][orientation.id] = pearson(sea.xs, sea.ys);
    }
  }
  const primary = orientationCorr.sea.total;
  const bestOrientation = ORIENTATIONS.reduce((best, o) => (
    (primary[o.id] ?? -Infinity) > (primary[best.id] ?? -Infinity) ? o : best));
  const geometryOk = bestOrientation.id === 'identity'
    && (primary.identity ?? 0) >= ORIENTATION_MIN_CORR;
  for (const variant of ['pooled', 'sea']) {
    for (const channel of COVERAGE_CHANNELS) {
      console.log(`幾何の検算(${variant === 'sea' ? '海のタイル' : '全タイル'}、cover × ${channel.label} の相関): ${
        ORIENTATIONS.map((o) => `${o.label} ${fmt(orientationCorr[variant][channel.id][o.id])}`).join(' / ')
      }`);
    }
  }
  if (!geometryOk) {
    throw new Error(
      '幾何の検算に失敗 — 時刻か座標の対応が壊れている'
      + `(render-lab の displayTime と cloud-lab の hours、カメラの向きを確かめる)`,
    );
  }

  // --- 統計: alignLow・alignUp を足し、形の特徴量を cover の範囲で絞る ---
  const realPrepared = maskShapeFeatures(withAlignment(real));
  const genPrepared = maskShapeFeatures(withAlignment(generated));
  const rankConditions = [...CONDITIONS_MAIN, ...CONDITIONS_REAL_ONLY, ...CONDITIONS_GEN_ONLY];

  const sections = {};
  const scoreRows = [];
  let rankedAll = null;
  for (const band of BANDS) {
    const realBand = realPrepared.filter((s) => band.test(s.conditions?.lat ?? s.lat));
    const genBand = genPrepared.filter((s) => band.test(s.conditions?.lat ?? s.lat));
    const response = responseTable(realBand, genBand);
    const eta = explainedTable(realBand, genBand);
    const joint = explainedJoint(realBand, genBand);
    const variants = {};
    for (const subset of SUBSETS) {
      const realSub = realBand.filter(subset.test);
      const genSub = genBand.filter(subset.test);
      variants[subset.id] = {
        n: { real: realSub.length, generated: genSub.length },
        scores: headlineOf(realSub, genSub),
        bootstrap: bootstrapScores(realSub, genSub, bootstrapResamples),
      };
      scoreRows.push({ band: band.id, subset: subset.id, ...variants[subset.id] });
    }
    const section = { n: { real: realBand.length, generated: genBand.length }, response, eta, joint, variants };
    if (band.id === 'all') {
      rankedAll = {
        real: withConditionRanks(realBand, rankConditions),
        generated: withConditionRanks(genBand, rankConditions),
      };
      section.variograms = variogramTable(realBand, genBand);
      section.regimes = Object.fromEntries(SUBSETS.map((subset) => [subset.id, {
        real: regimeTable(rankedAll.real.filter(subset.test), FEATURES),
        generated: regimeTable(rankedAll.generated.filter(subset.test), FEATURES),
      }]));
      section.marginals = marginalTable(realBand, genBand);
    }
    sections[band.id] = section;
    console.log(`帯 ${band.label}: 実写 ${realBand.length}・生成 ${genBand.length} タイル`);
  }

  // --- 見比べ用の画像: 気象型ごとに実写・生成のタイルを並べる ---
  const montageFiles = writeRegimeMontages(rankedAll, scenes, shotInfoMap);
  console.log(`気象型のモンタージュ ${montageFiles.length} 枚を compare/ へ書いた`);

  // --- レポート ---
  const generatedAt = new Date().toISOString();
  const report = {
    meta: {
      tool: 'cloud-regime-compare',
      generatedAt,
      commit,
      scenes: { real: scenes.length, generated: scenes.length },
      tiles: { real: real.length, generated: generated.length },
      hours: hoursList,
      geometryCheck: orientationCorr,
      teacherGeneratedAt: teacherConditions.generatedAt,
    },
    sections,
  };
  mkdirSync(compareDir, { recursive: true });
  writeFileSync(path.join(compareDir, 'report.json'), `${JSON.stringify(report)}\n`);
  writeFileSync(path.join(compareDir, 'report.md'), buildReportMd(report, montageFiles));
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(
    path.join(historyDir, `${generatedAt.replace(/[:.]/g, '-')}-${commit}.json`),
    `${JSON.stringify(report)}\n`,
  );

  // --- 標準出力: 見出しの点数と、応答の違いの上位 ---
  const out = [];
  out.push('');
  out.push(`=== 見出しの点数(小さいほど良い。場面ブートストラップ ${bootstrapResamples} 回、中央値 [5–95%]) ===`);
  for (const row of scoreRows) {
    const band = BANDS.find((b) => b.id === row.band);
    const subset = SUBSETS.find((s) => s.id === row.subset);
    const cell = (key) => {
      const b = row.bootstrap[key];
      return `${fmt(b?.median)} [${fmt(b?.p05)}–${fmt(b?.p95)}]`;
    };
    out.push(`${padL(band.label, 18)} ${padL(subset.label, 14)}`
      + ` contrast ${padR(cell('responseContrast'), 20)}`
      + ` bias ${padR(cell('responseBias'), 20)}`
      + ` variogram ${padR(cell('variogramDistance'), 20)}`
      + ` η²gap ${padR(cell('explainedGap'), 20)}`);
  }
  const response = sections.all.response;
  const topContrast = [...response].filter((r) => isNum(r.contrast))
    .sort((a, b) => b.contrast - a.contrast).slice(0, 15);
  out.push('');
  out.push('=== 応答が実写と最も違う条件 × 特徴量(contrast 上位、全域・全タイル) ===');
  for (const r of topContrast) {
    out.push(`${padL(r.condition, 16)} ${padL(r.feature, 11)}`
      + ` contrast ${padR(fmt(r.contrast), 8)} bias ${padR(fmt(r.bias), 8)}`
      + ` gain ${padR(fmt(r.gainRatio), 8)} corr ${padR(fmt(r.corr), 8)}`);
  }
  const lowGain = [...response].filter((r) => isNum(r.gainRatio))
    .sort((a, b) => a.gainRatio - b.gainRatio).slice(0, 15);
  out.push('');
  out.push('=== 生成が応答していない条件 × 特徴量(gainRatio 下位、全域・全タイル) ===');
  for (const r of lowGain) {
    out.push(`${padL(r.condition, 16)} ${padL(r.feature, 11)}`
      + ` gain ${padR(fmt(r.gainRatio), 8)} contrast ${padR(fmt(r.contrast), 8)}`
      + ` bias ${padR(fmt(r.bias), 8)} corr ${padR(fmt(r.corr), 8)}`);
  }
  console.log(out.join('\n'));
}

// 気象型ごとのモンタージュを compare/ へ書き、書いたファイル名を返す。
// ranked は withConditionRanks 済みの標本(全域)。タイルは海のタイル(land < 0.2)だけから
// 決定的な乱数で選び、元の絵(RGB)の切り抜きを MONTAGE_SCALE 倍にして並べる
// (上段 = 実写 8 枚・下段 = 生成 8 枚)。実写の絵は教師の画像から、生成の絵は撮影の
// キャッシュからタイルの特徴を測ったときと同じ手順(4 km/px への引き直し・中央切り出し)で組み直す。
function writeRegimeMontages(ranked, scenes, shotInfoMap) {
  const sea = (s) => isNum(s.conditions?.land) && s.conditions.land < 0.2;
  const tilePx = TILE_PX * MONTAGE_SCALE;
  const written = [];
  for (const regime of REGIMES) {
    const rows = [ranked.real, ranked.generated].map((samples, side) => {
      const inRegime = samples.filter((s) => s.conditionsRank && regime.test(s.conditionsRank) && sea(s));
      const rng = mulberry32(seedOf(`${regime.id}|${side}`));
      const order = inRegime.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      return order.slice(0, MONTAGE_PICKS).map((i) => inRegime[i]);
    });
    const rgb = new Uint8Array(MONTAGE_PICKS * tilePx * 2 * tilePx * 3);
    // 使う場面だけ絵を組み直す(決定的なので同じ場面からは同じ絵が来る)。
    for (const [side, picks] of rows.entries()) {
      const byScene = new Map();
      picks.forEach((sample, index) => {
        if (!byScene.has(sample.scene)) byScene.set(sample.scene, []);
        byScene.get(sample.scene).push({ sample, index });
      });
      for (const [sceneId, list] of byScene) {
        const png = side === 0
          ? decodePng(readFileSync(path.join(teacherDir, `${sceneId}-${KM_PER_PX}km.png`)))
          : montageRgb(
            scenes.find((s) => s.scene === sceneId),
            shotInfoMap,
          );
        for (const { sample, index } of list) {
          const col = sample.col ?? colFromTile(sample.tile);
          const row = sample.row ?? rowFromTile(sample.tile);
          paintTile(rgb, png, row, col, index, side);
        }
      }
    }
    mkdirSync(compareDir, { recursive: true });
    const file = path.join(compareDir, `regime-${regime.id}.png`);
    writeFileSync(file, encodeRgbPng(MONTAGE_PICKS * tilePx, 2 * tilePx, rgb));
    written.push(`regime-${regime.id}.png`);
  }
  return written;
}

// 'r<行>c<列>' のタイル名から格子の添字。
const rowFromTile = (tile) => Number(tile.slice(1).split('c')[0]);
const colFromTile = (tile) => Number(tile.split('c')[1]);

// モンタージュ用に、生成の場面の絵(RGB)を撮影から組み直す。タイルの特徴を測ったときと
// 同じ手順(4 km/px への引き直し・中央切り出し)で、絵の向きも同じ。
function montageRgb(scene, shotInfoMap) {
  const info = shotInfoMap.get(shotName(scene.scene, scene.hours));
  const shot = decodePng(readFileSync(shotFile(shotName(scene.scene, scene.hours))));
  return decodePng(resampleCropPng(shot, info?.centerKmPerPx ?? KM_PER_PX));
}

// タイル 1 枚(64 px)の RGB を MONTAGE_SCALE 倍(最近傍)にしてモンタージュのマスへ書く。
// マスの行は side(0 が実写の上段、1 が生成の下段)、列は選んだ順の index。
function paintTile(rgb, png, tileRow, tileCol, index, side) {
  const tilePx = TILE_PX * MONTAGE_SCALE;
  const width = MONTAGE_PICKS * tilePx;
  for (let y = 0; y < tilePx; y++) {
    for (let x = 0; x < tilePx; x++) {
      const sx = tileCol * TILE_PX + Math.floor(x / MONTAGE_SCALE);
      const sy = tileRow * TILE_PX + Math.floor(y / MONTAGE_SCALE);
      const src = (sy * png.width + sx) * png.channels;
      const dst = ((side * tilePx + y) * width + index * tilePx + x) * 3;
      rgb[dst] = png.data[src];
      rgb[dst + 1] = png.data[src + 1];
      rgb[dst + 2] = png.data[src + 2];
    }
  }
}

// report.json から report.md(日本語)を組む。帯ごとに節を分ける。
function buildReportMd(report, montageFiles) {
  const { meta, sections } = report;
  const lines = [];
  lines.push('# 気象条件 → 雲の形の応答の比較(実写 / 生成)');
  lines.push('');
  lines.push(`- commit: ${meta.commit} · 生成: ${meta.generatedAt}`);
  lines.push(`- 実写: ${meta.scenes.real} 場面 / ${meta.tiles.real} タイル`
    + ` · 生成: ${meta.scenes.generated} 場面 / ${meta.tiles.generated} タイル`);
  lines.push(`- 生成の表示時刻: ${meta.hours.join(', ')} h(場面の並びへ巡回)`);
  for (const variant of ['pooled', 'sea']) {
    for (const channel of COVERAGE_CHANNELS) {
      lines.push(`- 幾何の検算(${variant === 'sea' ? '海のタイル' : '全タイル'}、cover × ${channel.label} の相関): ${ORIENTATIONS.map((o) => `${o.label} ${fmt(meta.geometryCheck[variant][channel.id][o.id])}`).join(' / ')}`);
    }
  }
  lines.push('');
  lines.push('## 見出しの点数(小さいほど良い。場面ブートストラップ 200 回、中央値 [5–95%])');
  lines.push('');
  lines.push(mdTable(
    ['帯', '集合', 'responseContrast', 'responseBias', 'variogramDistance', 'explainedGap'],
    BANDS.flatMap((band) => SUBSETS.map((subset) => {
      const v = sections[band.id].variants[subset.id];
      const cell = (key) => `${fmt(v.bootstrap[key].median)} [${fmt(v.bootstrap[key].p05)}–${fmt(v.bootstrap[key].p95)}]`;
      return [band.label, subset.label, cell('responseContrast'), cell('responseBias'), cell('variogramDistance'), cell('explainedGap')];
    })),
  ));
  for (const band of BANDS) {
    const section = sections[band.id];
    lines.push('');
    lines.push(`## ${band.label}(実写 ${section.n.real}・生成 ${section.n.generated} タイル)`);
    for (const metric of ['bias', 'contrast', 'gainRatio', 'corr']) {
      lines.push('');
      lines.push(`### (a) 応答の距離 — ${metric}`);
      lines.push(responseMdTable(section.response, metric));
    }
    lines.push('');
    lines.push('### (b) 説明される分散 η²(条件 × 特徴量)');
    lines.push(explainedMdTable(section.eta));
    lines.push('');
    lines.push(`直積 [${JOINT_CONDITIONS.join(', ')}] の η²: 実写 / 生成`);
    lines.push(mdTable(
      ['特徴量', '実写', '生成'],
      section.joint.map((j) => [j.feature, fmt(j.real), fmt(j.generated)]),
    ));
  }
  const all = sections.all;
  lines.push('');
  lines.push('## 全域の補足');
  lines.push('');
  lines.push('### (c) バリオグラムの距離と、場面内の分散 ÷ 全分散');
  lines.push(mdTable(
    ['特徴量', '距離', '最遠/最近 比(生成÷実写)', '場面内/全 実写', '場面内/全 生成'],
    all.variograms.map((v) => [v.feature, fmt(v.distance), fmt(v.rangeRatio), fmt(v.realWithin), fmt(v.generatedWithin)]),
  ));
  lines.push('');
  lines.push('### (d) 気象型ごとの中央値(REGIMES × 特徴量、実写 / 生成、全タイル / 海)');
  for (const [i, regime] of REGIMES.entries()) {
    lines.push('');
    lines.push(`#### ${regime.label}`);
    lines.push(mdTable(
      ['集合', '側', ...FEATURES],
      SUBSETS.flatMap((subset) => {
        const r = all.regimes[subset.id].real[i];
        const g = all.regimes[subset.id].generated[i];
        return [
          [subset.label, `実写 n=${r.n}`, ...FEATURES.map((f) => fmt(r.stats[f].median))],
          [subset.label, `生成 n=${g.n}`, ...FEATURES.map((f) => fmt(g.stats[f].median))],
        ];
      }),
    ));
  }
  lines.push('');
  lines.push('### (e) 条件の周辺分布(p5・p25・p50・p75・p95、実写 / 生成)');
  lines.push(mdTable(
    ['条件', '側', ...MARGINAL_QUANTILES.map((q) => `p${q * 100}`)],
    all.marginals.flatMap((m) => [
      [m.condition, '実写', ...m.real.map((v) => fmt(v))],
      ['', '生成', ...m.generated.map((v) => fmt(v))],
    ]),
  ));
  lines.push('');
  lines.push('## 見比べ用の画像');
  lines.push(montageFiles.map((f) => `- ${f}`).join('\n'));
  lines.push('');
  return `${lines.join('\n')}\n`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
