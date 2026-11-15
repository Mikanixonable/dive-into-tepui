// 生成した雲の動きを、実写の赤外時系列と同じ物差しで測る。tools/cloud-lab/motion.html の
// ページ(window.cloudMotion)が生成雲場を表示時刻ごとに全球(正距円筒)へ焼き、実写の箱と同じ
// 緯度経度の面へ切り出す。雲は冷たい雲頂の場へ写して返る — 雲頂高度から気温減率で雲頂温度を
// 引き、放射率(1 − e^−τ、τ は鉛直柱光学深さ)で重み付けた 2 層放射で視線上の輝度温度を組み、
// 実写と同じ閾値(0 ℃)と飽和(−70 ℃)へ写す。地表の輝度温度は帯状平均の海面温度の推定
// (赤道 299 K、極 277 K の緯度連続関数)を使う。
//
// 実写側と揃えるもの: 13 箱(緯度経度・類分けは cloud-lab-reference-motion.mjs と同じ)、
// 8 km/px、48 時間の 1 時間刻み、指標(cloud-motion-metrics の scaleDecorrelation・
// blockMotion・renewalFraction、引数も同じ)。違うのは期だけ — 生成の世界に暦日は無いので、
// 実写の 2 期の間隔(38 日)に合わせて表示時刻 0 h と 912 h の 2 期で測る。
//
// 使い方: CLOUD_LAB_PORT=8827 CLOUD_LAB_DEBUG_PORT=9527 npm run cloud-lab:motion-compare
// 表は .cloud-lab/motion-compare/report.json へ、前の実行は history/ へ残る。
// 走らせる差し替えは、リポジトリ直下の .loop-motion-config.json(任意)の
// { "variants": ["base", ...] } で選ぶ — 無ければ base だけで測る。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import {
  blockMotion, DIRECTION_MIN_SPEED_MS, renewalFraction, scaleDecorrelation, summarizeBlocks,
} from './cloud-motion-metrics.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'motion-compare');
const historyDir = path.join(outDir, 'history');
const referenceReportPath = path.join(buildDir, 'reference-motion', 'report.json');
const reportPath = path.join(outDir, 'report.json');

const port = Number(process.env.CLOUD_LAB_PORT ?? 8827);
const debugPort = Number(process.env.CLOUD_LAB_DEBUG_PORT ?? 9527);

// 実写の箱と同じ 13 箱(cloud-lab-reference-motion.mjs の BOXES と同じ緯度経度・類分け)。
const BOXES = [
  { name: 'midlat-nwpac', cls: 'midlat-sea', lat: 40, lon: 160 },
  { name: 'midlat-npac-east', cls: 'midlat-sea', lat: 40, lon: -140 },
  { name: 'midlat-natl', cls: 'midlat-sea', lat: 45, lon: -40 },
  { name: 'japan', cls: 'japan', lat: 35, lon: 138 },
  { name: 'midlat-sindian', cls: 'midlat-sea', lat: -45, lon: 80 },
  { name: 'midlat-spac', cls: 'midlat-sea', lat: -45, lon: -150 },
  { name: 'subtrop-nwpac', cls: 'subtropics', lat: 25, lon: 150 },
  { name: 'subtrop-sepac', cls: 'subtropics', lat: -25, lon: -90 },
  { name: 'tropics-wpac', cls: 'tropics-sea', lat: 0, lon: 150 },
  { name: 'tropics-atl', cls: 'tropics-sea', lat: 5, lon: -30 },
  { name: 'tropics-epac', cls: 'tropics-sea', lat: 0, lon: -100 },
  { name: 'tropics-samerica', cls: 'tropics-land', lat: -10, lon: -60 },
  { name: 'highlat-natl', cls: 'high-lat', lat: 60, lon: -20 },
];
// 生成の世界には暦日が無いので、実写の 2 期の間隔(2026-09-20 → 2026-10-28 の 38 日)に合わせて
// 表示時刻 0 h と 912 h を 2 期とする。期の名は対応づけのために実写の日付を借りる。
const PERIODS = [
  { name: '2026-09-20', startHours: 0 },
  { name: '2026-10-28', startHours: 912 },
];
const SAMPLE_HOURS = Array.from({ length: 49 }, (_, i) => i);
// 差し替え実験の一覧。クエリは motion-main.ts の applyAblations が読む。感度の確認(windScale)と、
// 速さ・減衰時間・入れ替わりの主犯の切り分け(noShear・noCyclone・noEpoch・noCirculation・
// noAdvection・局所風の eddyScale)を同じ系列で行う。
const KNOWN_ABLATIONS = new Map([
  ['base', ''],
  ['wind×0.5', 'windScale=0.5'],
  ['wind×2', 'windScale=2'],
  ['noShear', 'noShear=1'],
  ['noCyclone', 'noCyclone=1'],
  ['noEpoch', 'noEpoch=1'],
  ['noCirculation', 'noCirculation=1'],
  ['noAdvection', 'noAdvection=1'],
  ['eddy×0.5', 'eddyScale=0.5'],
  ['eddy×0.3', 'eddyScale=0.3'],
]);
// リポジトリ直下の .loop-motion-config.json の { "variants": ["base", ...] } で走らせる
// 変種を選ぶ。無ければ base だけ。
const configPath = path.join(root, '.loop-motion-config.json');
const variants = (existsSync(configPath)
  ? JSON.parse(readFileSync(configPath, 'utf8')).variants
  : null) ?? ['base'];
const ABLATIONS = variants.map((name) => {
  if (!KNOWN_ABLATIONS.has(name)) throw new Error(`知らない差し替え: ${name}`);
  return { name, query: KNOWN_ABLATIONS.get(name) };
});
// 風の写しを読む時刻 [h](系列の先頭・中間・末尾)。
const WIND_SAMPLE_HOURS = [0, 24, 48];

// 箱は km の正方形(2000 km 四方)。計測は実写と同じ 8 km/px の 250×250 で行う。
const HALF_KM = 1000;
const KM_PER_PX = 8;
const SIZE_PX = 250;
const KM_PER_DEG = 111.32;

const CLASSES = [
  ['midlat-sea', '中緯度の海'],
  ['japan', '日本付近'],
  ['subtropics', '亜熱帯'],
  ['tropics-sea', '熱帯の海'],
  ['tropics-land', '熱帯の陸'],
  ['high-lat', '高緯度'],
];
const SCALES_KM = [150, 300, 600, 1200];
const LAGS_H = [1, 2, 4, 8, 12, 24];
const RENEWAL_LAGS_H = [6, 10, 12, 24];
// motion.html 側の WIND_SPAN_MS と同じ。
const WIND_SPAN_MS = 96;

// .cloud-lab/reference-motion/report.json が無い環境で使う、報告書の実写の目安。
// 値は依頼文にある実写の表の値で、範囲は類をまたいだ散らばり。report.json があれば
// そちらの類ごとの値を使い、こちらには戻らない。
const REFERENCE_BENCHMARK = {
  // 冷たい雲頂の移流速さの中央値 [m/s]。熱帯の陸だけ別の値(43)。
  speedMedianMs: { default: [23, 28], 'tropics-land': [40, 46] },
  // 速さの P90 [m/s]。
  speedP90Ms: { default: [75, 89] },
  // 尺度別の 1/e 減衰時間 [h]。
  tauHours: { 150: [1.3, 3.1], 300: [2.5, 4.8], 600: [4.2, 7.4], 1200: [5.4, 8.8] },
  // 日本付近の朝→夕(約 10 h)の入れ替わり。
  japanRenewal10h: { noShift: 0.65, bestShift: 0.06 },
};

function boxFor(box) {
  const dlat = HALF_KM / KM_PER_DEG;
  const dlon = HALF_KM / (KM_PER_DEG * Math.cos((box.lat * Math.PI) / 180));
  return {
    south: box.lat - dlat, north: box.lat + dlat,
    west: box.lon - dlon, east: box.lon + dlon,
  };
}

function mean(values) {
  const xs = values.filter((v) => v !== null && !Number.isNaN(v));
  return xs.length === 0 ? null : xs.reduce((s, v) => s + v, 0) / xs.length;
}

function sdOf(values) {
  const xs = values.filter((v) => v !== null);
  if (xs.length < 2) return null;
  const m = xs.reduce((s, v) => s + v, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
}

function circularStatsDeg(dirsDeg) {
  const c = mean(dirsDeg.map((d) => Math.cos((d * Math.PI) / 180)));
  const s = mean(dirsDeg.map((d) => Math.sin((d * Math.PI) / 180)));
  const r = Math.hypot(c, s);
  return {
    meanDeg: (Math.atan2(s, c) * 180) / Math.PI,
    sdDeg: (Math.sqrt(-2 * Math.log(Math.min(r, 1))) * 180) / Math.PI,
  };
}

// 1/e を切る時刻を、平均の相関曲線から線形補間で求める。
function tauOf(lags, corrs) {
  const threshold = 1 / Math.E;
  for (let i = 1; i < lags.length; i++) {
    const a = corrs[i - 1];
    const b = corrs[i];
    if (a === null || b === null) return null;
    if (b < threshold) return lags[i - 1] + ((a - threshold) / (a - b)) * (lags[i] - lags[i - 1]);
  }
  return null;
}

// base64 の RGBA8 を ch 番目のチャンネルの Float32Array へ。
function channelField(base64, ch) {
  const bytes = Buffer.from(base64, 'base64');
  const data = new Float32Array(SIZE_PX * SIZE_PX);
  for (let i = 0; i < data.length; i++) data[i] = bytes[i * 4 + ch] / 255;
  return { width: SIZE_PX, height: SIZE_PX, data };
}

// 風の写し RGBA8 から画素ごとの 4 成分 [m/s]。
function windField(base64) {
  const bytes = Buffer.from(base64, 'base64');
  const out = new Float32Array(SIZE_PX * SIZE_PX * 4);
  for (let i = 0; i < bytes.length; i++) out[i] = (bytes[i] / 255 - 0.5) * WIND_SPAN_MS;
  return out;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

// 風の写し 3 時刻ぶんの集計。地表付近・上層それぞれの速さの中央値、層間のシアの大きさ、向きのばらつき。
function windStats(windArrays) {
  const surfaceSpeeds = [];
  const upperSpeeds = [];
  const shears = [];
  const dirs = [];
  for (const w of windArrays) {
    for (let i = 0; i < w.length; i += 4) {
      const su = w[i];
      const sv = w[i + 1];
      const uu = w[i + 2];
      const uv = w[i + 3];
      surfaceSpeeds.push(Math.hypot(su, sv));
      upperSpeeds.push(Math.hypot(uu, uv));
      shears.push(Math.hypot(uu - su, uv - sv));
      const speed = Math.hypot(uu, uv);
      if (speed >= DIRECTION_MIN_SPEED_MS) dirs.push((Math.atan2(uv, uu) * 180) / Math.PI);
    }
  }
  surfaceSpeeds.sort((a, b) => a - b);
  upperSpeeds.sort((a, b) => a - b);
  shears.sort((a, b) => a - b);
  return {
    surfaceMedianMs: quantile(surfaceSpeeds, 0.5),
    upperMedianMs: quantile(upperSpeeds, 0.5),
    shearMedianMs: quantile(shears, 0.5),
    upperDirectionSdDeg: circularStatsDeg(dirs).sdDeg,
  };
}

const fmt = (v, digits = 1) => (v === null || v === undefined || Number.isNaN(v) ? '  n/a' : v.toFixed(digits).padStart(6));

async function main() {
  mkdirSync(historyDir, { recursive: true });
  const previousPath = reportPath;
  if (existsSync(previousPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    renameSync(previousPath, path.join(historyDir, `report-${stamp}.json`));
  }

  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'cloud-motion-compare-',
    onEvent, requestTimeoutMs: 120_000,
  });

  // バリアント → 系列のキー → 枚・風。
  const runs = new Map();
  try {
    for (const variant of ABLATIONS) {
      const seriesFrames = new Map();
      const seriesWinds = new Map();
      runs.set(variant.name, { seriesFrames, seriesWinds });
      const url = `${session.baseUrl}/motion.html${variant.query ? `?${variant.query}` : ''}`;
      await session.devTools.send('Page.navigate', { url });
      await waitFor(session.devTools, '!!window.cloudMotion', 'cloud motion probe');
      console.log(`probe ready (${variant.name})`);

      for (const period of PERIODS) {
        for (const hours of SAMPLE_HOURS) {
          const displayHours = period.startHours + hours;
          await session.devTools.evaluate(`window.cloudMotion.prepare(${displayHours})`);
          for (const box of BOXES) {
            const key = `${box.name} ${period.name}`;
            const spec = { ...boxFor(box), sizePx: SIZE_PX };
            const cold = await session.devTools.evaluate(`window.cloudMotion.sampleBox(${JSON.stringify(spec)})`);
            if (!seriesFrames.has(key)) seriesFrames.set(key, []);
            seriesFrames.get(key).push({ hours, field: channelField(cold, 0) });
            if (WIND_SAMPLE_HOURS.includes(hours)) {
              const wind = await session.devTools.evaluate(`window.cloudMotion.sampleWindBox(${JSON.stringify(spec)})`);
              if (!seriesWinds.has(key)) seriesWinds.set(key, []);
              seriesWinds.get(key).push(windField(wind));
            }
          }
          if (hours % 12 === 0) console.log(`${variant.name} ${period.name} +${hours} h を読んだ`);
        }
      }
    }
  } finally {
    await session.close();
  }
  if (fatalEvents.length > 0) {
    for (const event of fatalEvents) console.error(`[page] ${event}`);
    throw new Error('ページが致命的なイベントを出した');
  }

  const reports = [];
  for (const variant of ABLATIONS) {
    const { seriesFrames, seriesWinds } = runs.get(variant.name);
    console.log(`\n######## ${variant.name} ########`);
    reports.push(evaluateRun(variant.name, seriesFrames, seriesWinds));
  }

  // バリアントどうしの要約。類の平均だけを並べて、どの仕掛けがどの物差しを動かすかを見る。
  console.log('\n=== 差し替えの要約(類の平均。距離は実写との距離) ===');
  console.log('バリアント      速さ中央値  τ150  τ300  τ600  上層風  距離');
  for (const report of reports) {
    const speed = mean(report.tables.motion.map((r) => r.speedMedian));
    const tau = (s) => mean(report.tables.tau.map((r) => r.tauHours[SCALES_KM.indexOf(s)] ?? 24));
    const upper = mean(report.tables.wind.map((r) => r.upperMedianMs));
    console.log(
      `${report.variant.padEnd(14, ' ')}  ${fmt(speed)} ${fmt(tau(150), 1).padStart(8)} ${fmt(tau(300), 1).padStart(6)}`
      + ` ${fmt(tau(600), 1).padStart(6)} ${fmt(upper)} ${fmt(report.distanceFromReference === null ? null : report.distanceFromReference * 100, 0)}%`,
    );
  }
}

function evaluateRun(variantName, seriesFrames, seriesWinds) {

  const results = [];
  for (const period of PERIODS) {
    for (const box of BOXES) {
      const key = `${box.name} ${period.name}`;
      const frames = seriesFrames.get(key);
      if (!frames) continue;
      const decorrelation = scaleDecorrelation(frames, KM_PER_PX, SCALES_KM, LAGS_H);
      const motion = blockMotion(frames, KM_PER_PX, {
        blockKm: 500, lagH: 3, maxSpeedMs: 80, minPeak: 0.4, centerLatDeg: box.lat,
      });
      const renewal = renewalFraction(frames, KM_PER_PX, { thresholdQuantile: 0.8, boxKm: 600, lagsH: RENEWAL_LAGS_H });
      const coldPositive = mean(frames.map((f) => f.field.data.filter((v) => v > 0).length / f.field.data.length));
      const wind = windStats(seriesWinds.get(key));
      results.push({
        box: box.name, class: box.cls, start: period.name, centerLat: box.lat,
        frameCount: frames.length, coldPositiveFraction: coldPositive,
        decorrelation, motion, renewal, wind,
      });
      console.log(
        `${key}: 枚 ${frames.length}、冷たさ > 0 の画素 ${(coldPositive * 100).toFixed(1)}%、`
        + `ブロック ${motion.blockCount}、上層風の中央値 ${fmt(wind.upperMedianMs)} m/s`,
      );
    }
  }

  const inClass = (cls) => results.filter((r) => r.class === cls);
  const tauTable = CLASSES.map(([cls, label]) => {
    const group = inClass(cls);
    const tau = SCALES_KM.map((_, s) => {
      const meanCorr = LAGS_H.map((_, l) => mean(group.map((r) => r.decorrelation.correlations[s][l])));
      return tauOf([0, ...LAGS_H], [1, ...meanCorr]);
    });
    return { class: cls, label, seriesCount: group.length, tauHours: tau };
  });
  const motionTable = CLASSES.map(([cls, label]) => {
    const group = inClass(cls);
    const blocks = group.flatMap((r) => r.motion.blocks);
    const seriesMeanDirs = group.map((r) => {
      const dirs = r.motion.blocks
        .filter((b) => b.speed >= DIRECTION_MIN_SPEED_MS)
        .map((b) => b.dirDeg);
      return dirs.length === 0 ? null : circularStatsDeg(dirs).meanDeg;
    }).filter((d) => d !== null);
    return {
      class: cls, label, seriesCount: group.length, ...summarizeBlocks(blocks),
      withinDirectionSdDeg: mean(group.map((r) => r.motion.directionCircularStdDeg)),
      betweenDirectionSdDeg: seriesMeanDirs.length === 0 ? null : circularStatsDeg(seriesMeanDirs).sdDeg,
    };
  });
  const renewalTable = CLASSES.map(([cls, label]) => {
    const group = inClass(cls);
    return {
      class: cls, label, seriesCount: group.length,
      lags: RENEWAL_LAGS_H.map((lagH) => {
        const rows = group.map((r) => r.renewal.find((x) => x.lagH === lagH));
        const noShift = rows.map((x) => x.renewalNoShift);
        const bestShift = rows.map((x) => x.renewalBestShift);
        return {
          lagH,
          windowCount: rows.reduce((s, x) => s + x.windowCount, 0),
          renewalNoShift: mean(noShift), renewalNoShiftSd: sdOf(noShift),
          renewalBestShift: mean(bestShift), renewalBestShiftSd: sdOf(bestShift),
        };
      }),
    };
  });
  const windTable = CLASSES.map(([cls, label]) => {
    const group = inClass(cls);
    return {
      class: cls, label, seriesCount: group.length,
      surfaceMedianMs: mean(group.map((r) => r.wind.surfaceMedianMs)),
      upperMedianMs: mean(group.map((r) => r.wind.upperMedianMs)),
      shearMedianMs: mean(group.map((r) => r.wind.shearMedianMs)),
      upperDirectionSdDeg: mean(group.map((r) => r.wind.upperDirectionSdDeg)),
    };
  });

  console.log('\n=== (1) 尺度ごとの 1/e 時間 tau [h](生成。箱の類ごとに、系列の平均の相関曲線から) ===');
  console.log(`類               系列  ${SCALES_KM.map((s) => `${s} km`.padStart(8)).join('')}`);
  for (const row of tauTable) {
    console.log(`${row.label.padEnd(14, ' ')}  ${String(row.seriesCount).padStart(4)}  ${row.tauHours.map((t) => fmt(t, 1).padStart(8)).join('')}`);
  }

  console.log('\n=== (2) 速さ [m/s] と向き(生成。lagH = 3。箱の類ごとにブロックを集めた値) ===');
  console.log('類               系列  ブロック 動くブロック   中央値   P10    P90   箱の中の向きSD[°]  箱どうしの向きSD[°]');
  for (const row of motionTable) {
    console.log(
      `${row.label.padEnd(14, ' ')}  ${String(row.seriesCount).padStart(4)}  ${String(row.blockCount).padStart(7)}  ${String(row.movingBlockCount).padStart(9)}`
      + `  ${fmt(row.speedMedian)} ${fmt(row.speedP10)} ${fmt(row.speedP90)}  ${fmt(row.withinDirectionSdDeg, 1).padStart(16)}  ${fmt(row.betweenDirectionSdDeg, 1).padStart(18)}`,
    );
  }

  console.log('\n=== (3) 入れ替わり割合(生成。窓 600 km、雲は上位 20%。系列の平均 ± SD) ===');
  console.log('類               系列  lag [h]   窓    ずらしなし        ずらしあり');
  for (const row of renewalTable) {
    for (const lag of row.lags) {
      console.log(
        `${row.label.padEnd(14, ' ')}  ${String(row.seriesCount).padStart(4)}  ${String(lag.lagH).padStart(7)}  ${String(lag.windowCount).padStart(4)}`
        + `  ${fmt(lag.renewalNoShift, 3)} ± ${fmt(lag.renewalNoShiftSd, 3)}  ${fmt(lag.renewalBestShift, 3)} ± ${fmt(lag.renewalBestShiftSd, 3)}`,
      );
    }
  }

  console.log('\n=== (4) 雲を運ぶ風 [m/s](生成。地表付近・上層の速さの中央値、層間シア、上層の向きSD) ===');
  console.log('類               系列  地表付近  上層   シア  上層の向きSD[°]');
  for (const row of windTable) {
    console.log(
      `${row.label.padEnd(14, ' ')}  ${String(row.seriesCount).padStart(4)}  ${fmt(row.surfaceMedianMs)} ${fmt(row.upperMedianMs)} ${fmt(row.shearMedianMs)}  ${fmt(row.upperDirectionSdDeg, 1).padStart(14)}`,
    );
  }

  // 実写との距離。report.json があれば類ごとの値と、無ければ報告書の目安の範囲と比べる
  // (範囲の内側なら偏差 0、外なら近い側の端までの相対偏差)。tau が null(24 h でも
  // 1/e を切らない)は lag の上限 24 h で数える。
  let distanceTable;
  let distanceSource;
  const outside = (gen, lo, hi) => {
    if (gen === null) return null;
    if (gen >= lo && gen <= hi) return 0;
    return gen < lo ? (lo - gen) / lo : (gen - hi) / hi;
  };
  if (existsSync(referenceReportPath)) {
    distanceSource = 'reference-motion/report.json';
    const ref = JSON.parse(readFileSync(referenceReportPath, 'utf8'));
    const refTau = new Map(ref.tables.tau.map((r) => [r.class, r.tauHours]));
    const refMotion = new Map(ref.tables.motion.map((r) => [r.class, r]));
    const refRenewal = new Map(ref.tables.renewal.map((r) => [r.class, r]));
    const point = (gen, refValue) => (refValue === null || refValue === undefined ? null : outside(gen, refValue, refValue));
    distanceTable = CLASSES.map(([cls, label]) => {
      const tauGen = tauTable.find((r) => r.class === cls).tauHours;
      const tauRef = refTau.get(cls);
      const motionGen = motionTable.find((r) => r.class === cls);
      const motionRef = refMotion.get(cls);
      const renewalGen = renewalTable.find((r) => r.class === cls).lags.find((l) => l.lagH === 10);
      const renewalRef = refRenewal.get(cls)?.lags.find((l) => l.lagH === 10);
      const entries = {
        speedMedian: point(motionGen.speedMedian, motionRef?.speedMedian),
        tau: SCALES_KM.map((_, s) => point(tauGen[s] ?? 24, tauRef?.[s] ?? 24)),
        renewalNoShift10h: point(renewalGen?.renewalNoShift, renewalRef?.renewalNoShift),
        renewalBestShift10h: point(renewalGen?.renewalBestShift, renewalRef?.renewalBestShift),
      };
      const flat = [entries.speedMedian, ...entries.tau, entries.renewalNoShift10h, entries.renewalBestShift10h]
        .filter((v) => v !== null);
      return {
        class: cls, label, ...entries,
        distance: flat.length === 0 ? null : mean(flat),
      };
    });
  } else {
    distanceSource = '依頼文の実写の目安(範囲)';
    const bench = REFERENCE_BENCHMARK;
    distanceTable = CLASSES.map(([cls, label]) => {
      const tauGen = tauTable.find((r) => r.class === cls).tauHours;
      const motionGen = motionTable.find((r) => r.class === cls);
      const renewalGen = renewalTable.find((r) => r.class === cls).lags.find((l) => l.lagH === 10);
      const speedBand = bench.speedMedianMs[cls] ?? bench.speedMedianMs.default;
      const p90Band = bench.speedP90Ms.default;
      const entries = {
        speedMedian: outside(motionGen.speedMedian, ...speedBand),
        speedP90: outside(motionGen.speedP90, ...p90Band),
        tau: SCALES_KM.map((scale) => outside(tauGen[SCALES_KM.indexOf(scale)] ?? 24, ...bench.tauHours[scale])),
        renewalNoShift10h: cls === 'japan'
          ? outside(renewalGen?.renewalNoShift, bench.japanRenewal10h.noShift, bench.japanRenewal10h.noShift)
          : null,
        renewalBestShift10h: cls === 'japan'
          ? outside(renewalGen?.renewalBestShift, bench.japanRenewal10h.bestShift, bench.japanRenewal10h.bestShift)
          : null,
      };
      const flat = [entries.speedMedian, entries.speedP90, ...entries.tau, entries.renewalNoShift10h, entries.renewalBestShift10h]
        .filter((v) => v !== null);
      return {
        class: cls, label, ...entries,
        distance: flat.length === 0 ? null : mean(flat),
      };
    });
  }
  const distance = mean(distanceTable.map((r) => r.distance));
  console.log(`\n=== (5) 実写との距離(${distanceSource}。範囲外までの相対偏差の類内平均) ===`);
  for (const row of distanceTable) {
    const cells = [row.speedMedian, row.speedP90, ...row.tau, row.renewalNoShift10h, row.renewalBestShift10h]
      .map((v) => (v === null || v === undefined ? '  n/a' : `${(v * 100).toFixed(0)}%`).padStart(6)).join(' ');
    console.log(`${row.label.padEnd(14, ' ')}  ${cells}   距離 ${fmt(row.distance === null ? null : row.distance * 100, 0)}%`);
  }
  console.log('(列: 速さ中央値・P90・τ150/300/600/1200・入替10hずらしなし/あり)');
  console.log(`類の平均の距離: ${fmt(distance === null ? null : distance * 100, 0)}%`);

  const report = {
    tool: 'cloud-lab-motion-compare',
    variant: variantName,
    kmPerPx: KM_PER_PX, sizePx: SIZE_PX,
    periods: PERIODS.map((p) => ({ name: p.name, startHours: p.startHours })),
    scalesKm: SCALES_KM, lagsH: LAGS_H, renewalLagsH: RENEWAL_LAGS_H,
    coldness: '雲頂高度から気温減率 6.5 K/km で雲頂温度、放射率 1 − e^−τ の 2 層放射で輝度温度、閾値 0 ℃・飽和 −70 ℃。地表は赤道 299 K・極 277 K の緯度連続関数',
    tables: { tau: tauTable, motion: motionTable, renewal: renewalTable, wind: windTable, distance: distanceTable },
    distanceSource, distanceFromReference: distance,
    series: results,
  };
  const outPath = variantName === 'base'
    ? reportPath
    : path.join(outDir, `report-${variantName.replace(/[^\w.-]/g, '_')}.json`);
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${path.relative(root, outPath)}`);
  return report;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
