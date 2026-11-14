// cloud-motion-metrics の自己検査。解けた答えの分かる合成場へ物差しを当てる。(a) 一様に東へ
// 10 m/s で動く場で速さ 10 ± 1 m/s・向き 0°、(b) 動かない場で速さ 0、(c) 時刻ごとに独立な雑音で
// 尺度ごとの相関が 1 時間後にほぼ 0、(d) 20 m/s で動く場で入れ替わりのずらしなしの版が大きく、
// ずらしありの版が小さいこと、(e) 停止した場で入れ替わりが 0、(f) 正負が
// 入れ替わった場で入れ替わり割合が 1、(g) 移流する場で小さい尺度ほど減衰が速いこと、
// (h) 移流する場で入れ替わりが lag に対して単調に増えること。判定に 1 つでも失敗すれば非 0 で終わる。
// 使い方: npm run cloud-motion:selftest
import {
  blockMotion,
  renewalFraction,
  scaleDecorrelation,
} from './cloud-motion-metrics.mjs';

const KM_PER_PX = 8;
const N = 250;

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failures.push(name);
}

// 乱数(再現できる seed)。
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// minWavelength–maxWavelength km に対数等間隔の波長 count 本の正弦波の重ね合わせ。
// 0..1 の場。x は東、y は南へ増える。
function makePattern(seed, minWavelength = 150, maxWavelength = 400, count = 8) {
  const rand = mulberry32(seed);
  const modes = Array.from({ length: count }, (_, i) => {
    const wavelength = minWavelength
      * Math.pow(maxWavelength / minWavelength, count === 1 ? 0.5 : i / (count - 1));
    const angle = rand() * 2 * Math.PI;
    return {
      k: (2 * Math.PI) / wavelength,
      kx: Math.cos(angle),
      ky: Math.sin(angle),
      phase: rand() * 2 * Math.PI,
    };
  });
  return (xKm, yKm) => {
    let sum = 0;
    for (const m of modes) sum += Math.cos(m.k * (m.kx * xKm + m.ky * yKm) + m.phase);
    return 0.5 + sum / (2 * modes.length);
  };
}

// 時刻 hours に、場が東へ speedMs で動いた後の画像。
function sampleField(pattern, speedMs, hours) {
  const shiftKm = (speedMs * hours * 3600) / 1000;
  const data = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      data[y * N + x] = pattern(((x + 0.5) * KM_PER_PX) - shiftKm, (y + 0.5) * KM_PER_PX);
    }
  }
  return { width: N, height: N, data };
}

// (a) 一様な東向きの移流。
{
  const pattern = makePattern(1);
  const frames = [0, 3, 6].map((hours) => ({ hours, field: sampleField(pattern, 10, hours) }));
  const result = blockMotion(frames, KM_PER_PX, { blockKm: 500, lagH: 3, maxSpeedMs: 80, minPeak: 0.4 });
  const dirMeanDeg = (Math.atan2(result.meanVector.v, result.meanVector.u) * 180) / Math.PI;
  check(
    '(a) 一様移流の速さ',
    result.blockCount > 0 && Math.abs(result.speedMedian - 10) <= 1,
    `中央値 ${result.speedMedian?.toFixed(2)} m/s(ブロック ${result.blockCount})、10 ± 1 m/s`,
  );
  check(
    '(a) 一様移流の向き',
    Math.abs(dirMeanDeg) <= 2 && result.directionCircularStdDeg < 5,
    `平均の向き ${dirMeanDeg.toFixed(2)}°、円周標準偏差 ${result.directionCircularStdDeg?.toFixed(2)}°`,
  );
}

// (b) 動かない場。
{
  const pattern = makePattern(2);
  const frames = [0, 3, 6].map((hours) => ({ hours, field: sampleField(pattern, 0, hours) }));
  const result = blockMotion(frames, KM_PER_PX, { blockKm: 500, lagH: 3, maxSpeedMs: 80, minPeak: 0.4 });
  check(
    '(b) 動かない場の速さ',
    result.blockCount > 0 && result.speedMedian < 0.5,
    `中央値 ${result.speedMedian?.toFixed(3)} m/s(ブロック ${result.blockCount})、0 近傍`,
  );
}

// (c) 時刻ごとに独立な雑音。
{
  const rand = mulberry32(3);
  const frames = Array.from({ length: 25 }, (_, hours) => ({
    hours,
    field: { width: N, height: N, data: Float32Array.from({ length: N * N }, () => rand()) },
  }));
  const result = scaleDecorrelation(frames, KM_PER_PX, [150, 300, 600, 1200], [1]);
  const lag1 = result.correlations.map((row) => row[0]);
  check(
    '(c) 独立雑音の 1 時間相関',
    lag1.every((c) => c !== null && Math.abs(c) < 0.15),
    `尺度 150/300/600/1200 km の lag 1 h 相関 ${lag1.map((c) => c.toFixed(3)).join(' / ')}`,
  );
}

// (d) 20 m/s で動く場の入れ替わり。
{
  const pattern = makePattern(4);
  const frames = Array.from({ length: 13 }, (_, hours) => ({ hours, field: sampleField(pattern, 20, hours) }));
  const [row] = renewalFraction(frames, KM_PER_PX, { thresholdQuantile: 0.8, boxKm: 600, lagsH: [6] });
  check(
    '(d) 入れ替わりのずらし',
    row.renewalNoShift !== null && row.renewalBestShift !== null
      && row.renewalNoShift - row.renewalBestShift > 0.2 && row.renewalBestShift < row.renewalNoShift,
    `ずらしなし ${row.renewalNoShift?.toFixed(3)}、ずらしあり ${row.renewalBestShift?.toFixed(3)}(窓 ${row.windowCount})`,
  );
}

// (e) 停止した場。雲マスクが全く同じなら入れ替わりは 0(相関 1 に相当)。
// 止まった場・ゆっくり動くだけの場の減衰時間は scaleDecorrelation では検査しない —
// 画素ごとの時間平均を引くので、止まった場の異常は 0、ゆっくり移流する場の異常は時間に
// 線形な 1 方向の成分になり、相関が ±1 に潰れて意味を持たないため。
{
  const pattern = makePattern(5, 120, 1900, 16);
  const frames = [0, 6, 12, 24].map((hours) => ({ hours, field: sampleField(pattern, 0, 0) }));
  const rows = renewalFraction(frames, KM_PER_PX, { thresholdQuantile: 0.8, boxKm: 600, lagsH: [6, 12, 24] });
  check(
    '(e) 停止した場の入れ替わり',
    rows.every((r) => r.renewalNoShift === 0 && r.renewalBestShift === 0),
    `ずらしなし 6/12/24 h = ${rows.map((r) => r.renewalNoShift).join(' / ')}`,
  );
}

// (f) 正負が入れ替わった場。雲マスク(上位 20%)は完全にずれるので入れ替わり割合は 1。
{
  const pattern = makePattern(7);
  const a = sampleField(pattern, 0, 0);
  const b = { width: N, height: N, data: Float32Array.from(a.data, (v) => -v) };
  const [row] = renewalFraction(
    [{ hours: 0, field: a }, { hours: 1, field: b }],
    KM_PER_PX,
    { thresholdQuantile: 0.8, boxKm: 600, lagsH: [1] },
  );
  check(
    '(f) 完全に入れ替わった場',
    row.renewalNoShift === 1,
    `ずらしなし ${row.renewalNoShift}`,
  );
}

// (g) 一様移流する広帯域の場の尺度ごとの減衰。小さい尺度ほど 1/e を早く切る。
{
  const pattern = makePattern(8, 120, 1900, 16);
  const frames = Array.from({ length: 25 }, (_, hours) => ({ hours, field: sampleField(pattern, 10, hours) }));
  const result = scaleDecorrelation(frames, KM_PER_PX, [150, 300, 600, 1200], [1, 2, 4, 8, 12, 24]);
  const tau = result.tauHours.map((t) => (t === null ? Infinity : t));
  check(
    '(g) 尺度ごとの減衰時間',
    tau[0] < tau[1] && tau[1] <= tau[2] && tau[2] <= tau[3] && tau[0] < 4,
    `tau 150/300/600/1200 km = ${result.tauHours.map((t) => (t === null ? '>24' : t.toFixed(1))).join(' / ')} h`,
  );
}

// (h) 10 m/s で移流する場の入れ替わりは lag に対して増える。波長は窓(600 km)より十分
// 大きく取る — 小さい波長では 24 時間のずらしが周期をまたいで入れ替わりが再び減るため。
{
  const pattern = makePattern(9, 1500, 1900, 3);
  const frames = Array.from({ length: 25 }, (_, hours) => ({ hours, field: sampleField(pattern, 10, hours) }));
  const rows = renewalFraction(frames, KM_PER_PX, { thresholdQuantile: 0.8, boxKm: 600, lagsH: [6, 12, 24] });
  const values = rows.map((r) => r.renewalNoShift);
  check(
    '(h) 入れ替わりの lag 単調性',
    values.every((v) => v !== null && v >= 0 && v <= 1) && values[0] <= values[1] && values[1] <= values[2],
    `ずらしなし 6/12/24 h = ${values.map((v) => v?.toFixed(3)).join(' / ')}`,
  );
}

if (failures.length > 0) {
  console.log(`失敗: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('すべて PASS');
