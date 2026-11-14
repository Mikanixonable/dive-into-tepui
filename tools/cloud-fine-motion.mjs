// 描画の時系列撮影と実写の可視時系列を、尺度帯ごとに動きで比べる特徴量。
// 比較の単位は (地域, 梯子) の対で、生成と実写の両方に同じ時刻梯子 [0,1,2,4,8] h の場が
// ある (同じ箱・同じ画素数へ切り出したもの)。帯域だけを抜いた場 (DoG) で測る —
// 帯域の動きと生滅だけを見るため。相関は重なり域だけのピアソン相関で、箱は全球面と
// 違って経度方向に巻かない (巻くと箱の東西の端が互いに写り込む)。
// 移流は 2 h の lag で探し (相関が最も高く、ずらしが読みやすい)、生滅の相関曲線は
// その移流を時刻に比例して外挿したずらしで読む — 模様を追いかけながら「形が保たれる
// 時間」を測る (追いかけなければ、移流だけで相関が落ちて生滅と区別がつかない)。
// 場は { width, height, data } (0..1 の輝度) で受ける。PNG の復号と箱の対応付けは
// 呼び出し側 (cloud-lab-compare) が行い、ここは純粋な特徴量だけを持つ。

import { crossingTime } from './cloud-motion.mjs';
import {
  bandPassField, FINE_BANDS, FINE_PRIMARY_LADDER, orientationDifferenceDeg,
} from './cloud-fine-structure.mjs';
import { cropField } from './gray-image.mjs';

// 動きのサンプル時刻 [h] と、移流を探す時刻差 [h]。
export const FINE_MOTION_SAMPLE_HOURS = [0, 1, 2, 4, 8];
export const FINE_MOTION_DRIFT_LAG_HOURS = 2;
// 1/e 交差時間の打ち切り [h]。相関が梯子の端までに 1/e を切らなかったら、τ はこの値より
// 長いことしか分からない。距離では端の値を代わりにする (cloud-distances.mjs とそろえる)。
export const FINE_MOTION_TAU_CENSOR_HOURS = 8;
// 移流の探索で見る速さの上限 [m/s]。この速さ × 時刻差が探すずらしの幅になる。
// これを超える移流は窓の端で止まり、clipped として記録する。嵐の移動は 20 m/s に
// 届くので、15 m/s では実写の大帯の移流が窓の端に当たった (2026-11-14 の初回計測で
// npac/natl 2000 km の [2000–200] 帯が clipped) ため 25 m/s に広げた。
const DRIFT_MAX_SPEED_MS = 25;
// 移流の探索で場を間引く倍率。探索は間引いた場で行い、ずらしは元の画素へ直す。
const DOWNSAMPLE = 4;
// 陸海の層別で枠を割る格子 (3×3)。
const TILE_GRID = 3;

// 場を factor × factor の箱平均で間引く。端の余りは切り捨てる。
function downsampleField(field, factor) {
  const width = Math.floor(field.width / factor);
  const height = Math.floor(field.height / factor);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          sum += field.data[(y * factor + dy) * field.width + (x * factor + dx)];
        }
      }
      out[y * width + x] = sum / (factor * factor);
    }
  }
  return { width, height, data: out };
}

// a と、b を (dx, dy) だけずらしたもののピアソン相関。重なり域だけで取る —
// dx が東への移動、dy が南への移動 (行の向き) が正。重なりが場の半分を切ったら 0 を返す。
function overlapCorrelation(a, b, dx, dy) {
  const { width, height } = a;
  const x0 = Math.max(0, -dx);
  const x1 = Math.min(width, width - dx);
  const y0 = Math.max(0, -dy);
  const y1 = Math.min(height, height - dy);
  const count = (x1 - x0) * (y1 - y0);
  if (count <= 0 || count < (width * height) / 2) return 0;
  let meanA = 0;
  let meanB = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      meanA += a.data[y * width + x];
      meanB += b.data[(y + dy) * width + (x + dx)];
    }
  }
  meanA /= count;
  meanB /= count;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const da = a.data[y * width + x] - meanA;
      const db = b.data[(y + dy) * width + (x + dx)] - meanB;
      covariance += da * db;
      varianceA += da * da;
      varianceB += db * db;
    }
  }
  return covariance / Math.sqrt(varianceA * varianceB + 1e-30);
}

// 相関が最大になるずらし (dx, dy) を総当たりで探す。重なりだけの相関で、箱は巻かない。
function bestShiftNoWrap(a, b, maxDx, maxDy) {
  let best = { dx: 0, dy: 0, correlation: -Infinity };
  for (let dy = -maxDy; dy <= maxDy; dy++) {
    for (let dx = -maxDx; dx <= maxDx; dx++) {
      const correlation = overlapCorrelation(a, b, dx, dy);
      if (correlation > best.correlation) best = { dx, dy, correlation };
    }
  }
  return best;
}

// 帯を測れる条件。長い側は枠の幅に収まり、短い側はナイキスト (2 px) より長いこと。
// cloud-fine-structure.mjs の bandMeasurable と同じ取り方。
function bandMeasurable(band, frameWidthKm, kmPerPx) {
  return band.hiKm <= frameWidthKm && band.loKm >= 2 * kmPerPx;
}

// 移流の測定結果を [m/s] へ換算し、渡された平均風 (null なら風との比較をしない) との
// 向きの差と速さ比を添える。cloud-lab-compare.mjs の driftOf と同じ形。
function driftOfShift(shift, lagHours, kmPerPx, windMs) {
  const driftEast = (shift.dx * kmPerPx * 1000) / (lagHours * 3600);
  const driftNorth = (-shift.dy * kmPerPx * 1000) / (lagHours * 3600);
  const driftSpeed = Math.hypot(driftEast, driftNorth);
  const base = {
    shiftTexels: [shift.dx, shift.dy],
    correlation: shift.correlation,
    driftMs: { east: driftEast, north: driftNorth },
    driftSpeedMs: driftSpeed,
  };
  if (windMs === null) {
    return { ...base, windMs: null, windSpeedMs: null, angleDeg: null, speedRatio: null };
  }
  const windSpeed = Math.hypot(windMs.east, windMs.north);
  const angleDeg = driftSpeed > 0 && windSpeed > 0
    ? (Math.acos(Math.min(1, Math.max(-1, (driftEast * windMs.east + driftNorth * windMs.north)
      / (driftSpeed * windSpeed)))) * 180) / Math.PI
    : null;
  return {
    ...base,
    windMs,
    windSpeedMs: windSpeed,
    angleDeg,
    speedRatio: windSpeed > 0 ? driftSpeed / windSpeed : null,
  };
}

// 1 つの帯の、片側 (生成か実写) の動き。bandFields はサンプル時刻ごとの帯域場。
// 移流は driftLagHours の lag で間引いた場から探し、生滅の相関曲線はその移流を
// 時刻に比例して外挿したずらしで、元の解像度の場から読む。
function measureBandSide(bandFields, sampleHours, driftLagHours, kmPerPx, windMs) {
  const lagIndex = sampleHours.indexOf(driftLagHours);
  const base = bandFields[0];
  const lagged = bandFields[lagIndex];
  const downKmPerPx = kmPerPx * DOWNSAMPLE;
  const maxDx = Math.ceil((DRIFT_MAX_SPEED_MS * driftLagHours * 3600) / 1000 / downKmPerPx);
  const maxDy = Math.max(2, Math.ceil(maxDx / 2));
  const downBase = downsampleField(base, DOWNSAMPLE);
  const downLagged = downsampleField(lagged, DOWNSAMPLE);
  const found = bestShiftNoWrap(downBase, downLagged, maxDx, maxDy);
  const clipped = Math.abs(found.dx) >= maxDx || Math.abs(found.dy) >= maxDy;
  const shiftFull = { dx: found.dx * DOWNSAMPLE, dy: found.dy * DOWNSAMPLE, correlation: found.correlation };
  const drift = { ...driftOfShift(shiftFull, driftLagHours, kmPerPx, windMs), clipped };
  // 生滅の相関曲線。時刻 0 の相関は 1。lag ごとのずらしは移流を時刻に比例して外挿する。
  const correlations = [1];
  for (let i = 1; i < sampleHours.length; i++) {
    const hours = sampleHours[i];
    const dx = Math.round((shiftFull.dx * hours) / driftLagHours);
    const dy = Math.round((shiftFull.dy * hours) / driftLagHours);
    correlations.push(overlapCorrelation(base, bandFields[i], dx, dy));
  }
  const tauHours = crossingTime(sampleHours, correlations, 1 / Math.E);
  return { drift, correlations, tauHours };
}

// 1 つの帯の、陸海の層別の生滅。枠を TILE_GRID × TILE_GRID に割り、陸らしさの平均が
// 0.5 を超えるタイルを陸、残りを海として、タイルごとの τ を平均する。タイルの τ は
// 対の移流 (driftShift) を時刻に比例して外挿したずらしで読む (タイルごとに探さない)。
// landField が無ければ測れない (null)。
function measureBandStrata(bandFields, sampleHours, driftLagHours, driftShift, landField) {
  if (landField === null) return null;
  const { width, height } = bandFields[0];
  const tileW = Math.floor(width / TILE_GRID);
  const tileH = Math.floor(height / TILE_GRID);
  const classes = { land: [], sea: [] };
  for (let ty = 0; ty < TILE_GRID; ty++) {
    for (let tx = 0; tx < TILE_GRID; tx++) {
      const x0 = tx * tileW;
      const y0 = ty * tileH;
      let landSum = 0;
      for (let y = y0; y < y0 + tileH; y++) {
        for (let x = x0; x < x0 + tileW; x++) landSum += landField.data[y * width + x];
      }
      const landMean = landSum / (tileW * tileH);
      const tile = (field) => cropField(field, x0, y0, tileW, tileH);
      const correlations = [1];
      for (let i = 1; i < sampleHours.length; i++) {
        const hours = sampleHours[i];
        const dx = Math.round((driftShift.dx * hours) / driftLagHours);
        const dy = Math.round((driftShift.dy * hours) / driftLagHours);
        correlations.push(overlapCorrelation(tile(bandFields[0]), tile(bandFields[i]), dx, dy));
      }
      const tauHours = crossingTime(sampleHours, correlations, 1 / Math.E);
      classes[landMean > 0.5 ? 'land' : 'sea'].push(tauHours);
    }
  }
  const summarize = (taus) => {
    const finite = taus.filter((value) => value !== null);
    return {
      tiles: taus.length,
      finiteTiles: finite.length,
      // 1/e を切らなかったタイル (null) は梯子の端 8 h で打ち切られたものとして数える。
      // 陸海の層別の τ は打ち切り込みの平均で、打ち切りの扱いは距離側とそろえる。
      tauHours: taus.length === 0 ? null
        : taus.reduce((sum, value) => sum + (value ?? FINE_MOTION_TAU_CENSOR_HOURS), 0) / taus.length,
    };
  };
  return { land: summarize(classes.land), sea: summarize(classes.sea) };
}

// 1 つの対 (地域, 梯子) の時系列の動き。generated / reference はサンプル時刻ごとの
// 場 (同じ箱・同じ画素数へ切り出したもの) の並び。windMs は箱の平均の地表風 [m/s]
// (t=0、null なら風との比較をしない)。landField は同じ格子の陸らしさ 0..1 の場
// (null なら層別は測らない)。返す値は生の特徴量で、距離への落とし方は
// cloud-distances.mjs が決める。
export function measureFineMotionPair({
  generated, reference, kmPerPx, ladder, sampleHours, driftLagHours, windMs, landField,
}) {
  const frameWidthKm = generated[0].width * kmPerPx;
  const bands = [];
  const strata = [];
  for (const band of FINE_BANDS) {
    const key = `${band.loKm}-${band.hiKm}`;
    const primary = FINE_PRIMARY_LADDER[key] === ladder;
    if (!bandMeasurable(band, frameWidthKm, kmPerPx)) continue;
    const generatedBands = generated.map((field) => bandPassField(field, kmPerPx, band.loKm, band.hiKm));
    const referenceBands = reference.map((field) => bandPassField(field, kmPerPx, band.loKm, band.hiKm));
    const generatedSide = measureBandSide(
      generatedBands, sampleHours, driftLagHours, kmPerPx, windMs);
    const referenceSide = measureBandSide(
      referenceBands, sampleHours, driftLagHours, kmPerPx, windMs);
    bands.push({
      ...band,
      primary,
      generated: generatedSide,
      reference: referenceSide,
    });
    const generatedStrata = measureBandStrata(
      generatedBands, sampleHours, driftLagHours,
      { dx: generatedSide.drift.shiftTexels[0], dy: generatedSide.drift.shiftTexels[1] }, landField);
    const referenceStrata = measureBandStrata(
      referenceBands, sampleHours, driftLagHours,
      { dx: referenceSide.drift.shiftTexels[0], dy: referenceSide.drift.shiftTexels[1] }, landField);
    strata.push({
      ...band,
      primary,
      generated: generatedStrata,
      reference: referenceStrata,
    });
  }
  return { bands, strata };
}

// 筋の向き [°] (東から反時計回り、0..180) と風 (東・北成分 [m/s]) のずれ。
// 風向も同じ軸 (0..180) へ直し、向きの差と揃い (1 が風と平行) を返す。風が無ければ null。
export function windRelativeAlignment(orientationDeg, windMs) {
  if (windMs === null) return null;
  const speed = Math.hypot(windMs.east, windMs.north);
  if (speed <= 0) return null;
  const windDeg = ((Math.atan2(windMs.north, windMs.east) * 180) / Math.PI % 180 + 180) % 180;
  const deltaDeg = orientationDifferenceDeg(orientationDeg, windDeg);
  return { windDeg, deltaDeg, alignment: Math.cos((deltaDeg * Math.PI) / 180) };
}
