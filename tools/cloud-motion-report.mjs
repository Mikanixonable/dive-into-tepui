// .cloud-lab/reference-motion/ の実写の赤外時系列へ cloud-motion-metrics の指標を当て、箱の類ごとの
// 表を標準出力へ出し、report.json へ保存する。冷たさの場は帯 13 カラーマップから輝度温度を
// 復元して作る。計測は 8 km/px へ 4×4 で平均して落とした場で行う(NCC の探索を現実的な時間に
// 収めるため)。使い方: npm run cloud-lab:motion-report
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';
import {
  coldnessField,
  invertBrightnessTemperature,
  parseBand13Colormap,
  validateBand13Colormap,
} from './cloud-brightness-temperature.mjs';
import {
  blockMotion,
  DIRECTION_MIN_SPEED_MS,
  renewalFraction,
  scaleDecorrelation,
  summarizeBlocks,
} from './cloud-motion-metrics.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, '.cloud-lab', 'reference-motion');

const DOWN = 4;
// 雲とみる冷たさの閾値 [℃]。高層雲の閾値 −30 ℃ では日本付近の箱で正の画素が 1 割前後しか無く、
// 上位 20% の分位が 0 に潰れて雲のマスクと正規化の窓が成り立たないため、雲全般の 0 ℃ を使う。
const CLOUD_THRESHOLD_C = 0;
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

// 画素を DOWN × DOWN で平均して、km/px を DOWN 倍にした場。
function downsample({ width, height, data }) {
  const w = Math.floor(width / DOWN);
  const h = Math.floor(height / DOWN);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = 0; dy < DOWN; dy++) {
        for (let dx = 0; dx < DOWN; dx++) sum += data[(y * DOWN + dy) * width + x * DOWN + dx];
      }
      out[y * w + x] = sum / (DOWN * DOWN);
    }
  }
  return { width: w, height: h, data: out };
}

function loadColdField(file, entries) {
  const image = decodePng(readFileSync(path.join(root, file)));
  const bt = invertBrightnessTemperature(image, entries);
  let undecoded = 0;
  let cold = 0;
  for (const v of bt.data) if (Number.isNaN(v)) undecoded++;
  const field = coldnessField(bt, CLOUD_THRESHOLD_C);
  for (const v of field.data) if (v > 0) cold++;
  return {
    field: downsample(field),
    undecodedFraction: undecoded / bt.data.length,
    coldPositiveFraction: cold / field.data.length,
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

// 方向の円周統計 [°]。系列ごとの平均の向きや、その向きどうしのばらつきに使う。
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

const fmt = (v, digits = 1) => (v === null || v === undefined || Number.isNaN(v) ? '  n/a' : v.toFixed(digits).padStart(6));

function main() {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const entries = parseBand13Colormap(readFileSync(path.join(dir, manifest.colormap.file), 'utf8'));
  validateBand13Colormap(entries);

  const results = [];
  for (const record of manifest.series) {
    const frames = [...record.frames].sort((a, b) => a.hours - b.hours).map((frame) => {
      const { field, undecodedFraction, coldPositiveFraction } = loadColdField(frame.file, entries);
      return { hours: frame.hours, field, undecodedFraction, coldPositiveFraction };
    });
    const plain = frames.map(({ hours, field }) => ({ hours, field }));
    const decorrelation = scaleDecorrelation(plain, manifest.kmPerPx * DOWN, SCALES_KM, LAGS_H);
    const motion = blockMotion(plain, manifest.kmPerPx * DOWN, {
      blockKm: 500, lagH: 3, maxSpeedMs: 80, minPeak: 0.4, centerLatDeg: record.centerLat,
    });
    const renewal = renewalFraction(plain, manifest.kmPerPx * DOWN, { thresholdQuantile: 0.8, boxKm: 600, lagsH: RENEWAL_LAGS_H });
    const undecoded = mean(frames.map((f) => f.undecodedFraction));
    const coldPositive = mean(frames.map((f) => f.coldPositiveFraction));
    results.push({
      box: record.box, class: record.class, start: record.start, centerLat: record.centerLat,
      frameCount: frames.length, missingCount: record.missing.length,
      undecodedFraction: undecoded, coldPositiveFraction: coldPositive,
      decorrelation, motion, renewal,
    });
    console.log(
      `${record.box} ${record.start}: 枚 ${frames.length}、欠測 ${record.missing.length}、`
      + `復元できない画素 ${(undecoded * 100).toFixed(1)}%、冷たさ > 0 の画素 ${(coldPositive * 100).toFixed(1)}%、`
      + `ブロック ${motion.blockCount}`,
    );
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

  console.log('\n=== (1) 尺度ごとの 1/e 時間 tau [h](箱の類ごとに、系列の平均の相関曲線から) ===');
  console.log(`類               系列  ${SCALES_KM.map((s) => `${s} km`.padStart(8)).join('')}`);
  for (const row of tauTable) {
    console.log(`${row.label.padEnd(14, ' ')}  ${String(row.seriesCount).padStart(4)}  ${row.tauHours.map((t) => fmt(t, 1).padStart(8)).join('')}`);
  }

  console.log('\n=== (2) 速さ [m/s] と向き(lagH = 3。箱の類ごとにブロックを集めた値) ===');
  console.log('類               系列  ブロック 動くブロック   中央値   P10    P90   箱の中の向きSD[°]  箱どうしの向きSD[°]');
  for (const row of motionTable) {
    console.log(
      `${row.label.padEnd(14, ' ')}  ${String(row.seriesCount).padStart(4)}  ${String(row.blockCount).padStart(7)}  ${String(row.movingBlockCount).padStart(9)}`
      + `  ${fmt(row.speedMedian)} ${fmt(row.speedP10)} ${fmt(row.speedP90)}  ${fmt(row.withinDirectionSdDeg, 1).padStart(16)}  ${fmt(row.betweenDirectionSdDeg, 1).padStart(18)}`,
    );
  }

  console.log('\n=== (3) 入れ替わり割合(窓 600 km、雲は上位 20%(正の画素が 20% 未満の場では正の画素すべて)。系列の平均 ± SD) ===');
  console.log('類               系列  lag [h]   窓    ずらしなし        ずらしあり');
  for (const row of renewalTable) {
    for (const lag of row.lags) {
      console.log(
        `${row.label.padEnd(14, ' ')}  ${String(row.seriesCount).padStart(4)}  ${String(lag.lagH).padStart(7)}  ${String(lag.windowCount).padStart(4)}`
        + `  ${fmt(lag.renewalNoShift, 3)} ± ${fmt(lag.renewalNoShiftSd, 3)}  ${fmt(lag.renewalBestShift, 3)} ± ${fmt(lag.renewalBestShiftSd, 3)}`,
      );
    }
  }
  const japanMorning = renewalTable.find((r) => r.class === 'japan')?.lags.find((l) => l.lagH === 10);
  if (japanMorning) {
    console.log(
      `\n日本付近の朝→夕(約 10 h)の入れ替わり: ずらしなし ${fmt(japanMorning.renewalNoShift, 3)} ± ${fmt(japanMorning.renewalNoShiftSd, 3)}、`
      + `ずらしあり ${fmt(japanMorning.renewalBestShift, 3)} ± ${fmt(japanMorning.renewalBestShiftSd, 3)}`,
    );
  }

  const report = {
    tool: 'cloud-motion-report',
    sourceManifest: 'reference-motion/manifest.json',
    kmPerPx: manifest.kmPerPx * DOWN,
    scalesKm: SCALES_KM, lagsH: LAGS_H, renewalLagsH: RENEWAL_LAGS_H,
    tables: { tau: tauTable, motion: motionTable, renewal: renewalTable },
    series: results,
  };
  writeFileSync(path.join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log('\nwrote .cloud-lab/reference-motion/report.json');
}

main();
