// tools/screen-space-error.mjs の指標を、合成した誤差で理論値と照らす。
//
// 使い方: node tools/screen-space-error-test.mjs。失敗した検査を並べて終了コード 1 で終わる。
import assert from 'node:assert/strict';
import { bandsOf, errorMetrics, gaussianNoise, uniformRandom, BAND_SCALES } from './screen-space-error.mjs';

// 実際の撮影と同じ寸法 [画素]。
const WIDTH = 960;
const HEIGHT = 540;
// 帯と残りの箱の一辺 [画素](区間スコアの重みは 1/s)。
const TERM_SCALES = [...BAND_SCALES, 2 * BAND_SCALES.at(-1)];
// 標準正規分布で |Z| > 3 となる確率(区間スコアの α)。
const GAUSSIAN_TAIL = 0.0026997960632601866;
// 超過の項の幅の項に対する比の理論値。誤差が単位分散の白色雑音で粒がその標準偏差のとき、帯ごとに(重み 1/s によらず)
// (2/α)·E[max(0, |Z| − 3)] / (2·3)、E[max(0, |Z| − 3)] = 2(φ(3) − 3(1 − Φ(3)))。
const GAUSSIAN_EXCESS_RATIO = (2 / GAUSSIAN_TAIL) * 2 * (0.0044318484119380075 - 3 * 0.0013498980316301035) / 6;
// 白色雑音で許す R(s) の範囲と、超過と幅の比の範囲。粒は窓の中央値から推すので、推定の揺らぎのぶん超過は理論値より
// 大きく出る。
const WHITE_R_RANGE = [0.98, 1.02];
const WHITE_EXCESS_RATIO_RANGE = [0.09, 0.13];
// 拡大した雑音の R(s)/R(1) を理論値と照らす相対の許容幅。粗い帯ほど独立な標本が少なく(32 px の帯で数千)、帯の RMS が
// 数 % 揺らぐ。
const UPSCALED_R_TOLERANCE = 0.05;

// 3 成分とも種を変えた白色雑音の平面の組と、その基準の 0 の組。
function noiseImage(seed, width, height, sigma = 1) {
  const count = width * height;
  return {
    candidate: [0, 1, 2].map((c) => gaussianNoise(seed + c, count, sigma)),
    reference: [0, 1, 2].map(() => new Float32Array(count)),
  };
}

// 平面 values(width × height)を、一辺 factor 倍へ双一次で拡大する。画素の中心どうしを合わせ、端は寄せる。
function bilinearUpscale(values, width, height, factor) {
  const [outWidth, outHeight] = [width * factor, height * factor];
  const out = new Float32Array(outWidth * outHeight);
  const at = (x, y) => values[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];
  for (let y = 0; y < outHeight; y++) {
    const v = (y + 0.5) / factor - 0.5;
    const y0 = Math.floor(v);
    for (let x = 0; x < outWidth; x++) {
      const u = (x + 0.5) / factor - 0.5;
      const x0 = Math.floor(u);
      const [fx, fy] = [u - x0, v - y0];
      out[y * outWidth + x] = (1 - fx) * (1 - fy) * at(x0, y0) + fx * (1 - fy) * at(x0 + 1, y0)
        + (1 - fx) * fy * at(x0, y0 + 1) + fx * fy * at(x0 + 1, y0 + 1);
    }
  }
  return out;
}

// 1/factor の画素ごとに独立な単位分散の白色雑音を bilinearUpscale で拡大したものの、帯と残り(BAND_SCALES の順と残り)の
// 分散の理論値。画面の端から離れた画素で、拡大と箱の平均の重みから数え、拡大の位相で平均する。factor = 1 なら
// 全解像度の白色雑音。
function upscaledBandVariances(factor) {
  // 1 次元で、画素 x に置いた一辺 s の箱の平均が、粗い画素 k から受ける重み(k ごとの表)。
  const boxWeights = (x, s) => {
    const weights = new Map();
    const lo = x - Math.floor(s / 2);
    for (let xp = lo; xp < lo + s; xp++) {
      const u = (xp + 0.5) / factor - 0.5;
      for (const k of [Math.floor(u), Math.floor(u) + 1]) {
        weights.set(k, (weights.get(k) ?? 0) + (1 - Math.abs(u - k)) / s);
      }
    }
    return weights;
  };
  const dot = (a, b) => [...a].reduce((sum, [k, w]) => sum + w * (b.get(k) ?? 0), 0);
  // 1 次元の箱どうしの重みの内積の、位相の平均。2 次元の重みは x と y の積で、x と y の位相は独立に回る。
  const norms = new Array(TERM_SCALES.length).fill(0);
  const crosses = new Array(TERM_SCALES.length - 1).fill(0);
  for (let phase = 0; phase < factor; phase++) {
    const boxes = TERM_SCALES.map((s) => boxWeights(phase, s));
    for (const [j, box] of boxes.entries()) {
      norms[j] += dot(box, box) / factor;
      if (j < crosses.length) crosses[j] += dot(box, boxes[j + 1]) / factor;
    }
  }
  // d_s = ē_s − ē_2s の分散は、ē_s·ē_s − 2ē_s·ē_2s + ē_2s·ē_2s の各内積を x と y で掛けたもの。
  return [...crosses.map((cross, j) => norms[j] ** 2 - 2 * cross ** 2 + norms[j + 1] ** 2), norms.at(-1) ** 2];
}

// 1 つ目の成分だけに plane を持ち、残りが 0 の組。
const firstComponentOnly = (plane) => [plane, new Float32Array(plane.length), new Float32Array(plane.length)];

// 平面を、間隔 spacing の 5×5 のタップへ、中心からのタップ数の距離で標準偏差 1 のガウスの重みで均す。画面の外の
// タップは除いて重みを正規化する。
function dense5x5(values, width, height, spacing) {
  const weights = [-2, -1, 0, 1, 2].map((i) => Math.exp(-i * i / 2));
  const out = new Float32Array(values.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let weight = 0;
      for (let j = -2; j <= 2; j++) {
        for (let i = -2; i <= 2; i++) {
          const [nx, ny] = [x + i * spacing, y + j * spacing];
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const w = weights[i + 2] * weights[j + 2];
          sum += w * values[ny * width + nx];
          weight += w;
        }
      }
      out[y * width + x] = sum / weight;
    }
  }
  return out;
}

const within = (actual, expected, tolerance) => Math.abs(actual - expected) <= tolerance;
const inRange = (value, [low, high]) => value >= low && value <= high;
const failures = [];

// 検査 name を走らせ、落ちたら並べて続ける。
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  - ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  FAIL - ${name}\n    ${error.message}`);
  }
}

check('帯と残りの和が元の平面に戻る(一部の画素を外した印でも)', () => {
  const values = gaussianNoise(1, WIDTH * HEIGHT);
  const random = uniformRandom(2);
  for (const mask of [new Uint8Array(values.length).fill(1), Uint8Array.from(values, () => (random() < 0.7 ? 1 : 0))]) {
    const { bands, residual } = bandsOf(values, mask, WIDTH, HEIGHT);
    let worst = 0;
    for (let p = 0; p < values.length; p++) {
      if (!mask[p]) continue;
      const sum = bands.reduce((s, band) => s + band[p], 0) + residual[p];
      worst = Math.max(worst, Math.abs(sum - values[p]));
    }
    assert.ok(worst <= 1e-6, `最大の差 ${worst}`);
  }
});

const allPixels = new Uint8Array(WIDTH * HEIGHT).fill(1);
const zeroImage = [0, 1, 2].map(() => new Float32Array(WIDTH * HEIGHT));
const formatR = (r) => r.map((v) => v.toFixed(3)).join(' / ');

check('誤差 0 なら S も G も 0', () => {
  const metrics = errorMetrics(zeroImage, zeroImage, allPixels, WIDTH, HEIGHT, 0.03);
  assert.equal(metrics.score, 0);
  assert.equal(metrics.g, 0);
});

check('全解像度の白色雑音: R(s) と超過と幅の比が白色雑音の範囲、裾の重さが正規分布の理論値', () => {
  const metrics = errorMetrics(noiseImage(10, WIDTH, HEIGHT).candidate, zeroImage, allPixels, WIDTH, HEIGHT, 0);
  const ratio = metrics.excessTerm / metrics.widthTerm;
  console.log(`    R(s) ${formatR(metrics.r)}  超過/幅 ${ratio.toFixed(4)}  裾 ${(100 * metrics.tail).toFixed(3)}%`);
  for (const [j, r] of metrics.r.entries()) assert.ok(inRange(r, WHITE_R_RANGE), `R(${BAND_SCALES[j]}) = ${r}`);
  assert.ok(inRange(ratio, WHITE_EXCESS_RATIO_RANGE), `超過/幅 ${ratio}(理論値 ${GAUSSIAN_EXCESS_RATIO})`);
  assert.ok(within(metrics.tail, GAUSSIAN_TAIL, 0.001), `裾 ${metrics.tail}`);
});

// 粒は表示の画素の揺らぎ d_1 から読むので、拡大した雑音の粒は小さく、4 px より粗い帯はそれで説明できないムラになる。
check('1/4 の画素ごとの白色雑音を双一次で拡大したもの: R(s)/R(1) が拡大の理論値、超過と幅の比が下界を超える', () => {
  const coarse = noiseImage(20, WIDTH / 4, HEIGHT / 4).candidate;
  const upscaled = coarse.map((plane) => bilinearUpscale(plane, WIDTH / 4, HEIGHT / 4, 4));
  const metrics = errorMetrics(upscaled, zeroImage, allPixels, WIDTH, HEIGHT, 0);
  const ratio = metrics.excessTerm / metrics.widthTerm;
  const measuredR = metrics.r.map((r) => r / metrics.r[0]);
  // 帯と残りの RMS の c_s に対する比を、d_1 で 1 に揃えたもの。粒 g は R(s) のどの帯にも同じく掛かるので、帯では
  // R(s)/R(1) の理論値になる。
  const white = upscaledBandVariances(1);
  const relative = upscaledBandVariances(4).map((v, j) => Math.sqrt(v / white[j]));
  const expectedR = relative.map((v) => v / relative[0]);
  // 超過と幅の比の下界。帯を標準偏差 R(s)·u_s の正規分布とみると、Jensen の不等式で E[max(0, |d_s| − 3u_s)] ≥
  // max(0, √(2/π)·R(s) − 3)·u_s。u_s = c_s·g の g は幅と超過の両方に掛かって消える。
  const weightedC = white.map((v, j) => Math.sqrt(v) / TERM_SCALES[j]);
  const width = weightedC.reduce((sum, c) => sum + 6 * c, 0);
  const excessFloor = weightedC.reduce(
    (sum, c, j) => sum + (2 / GAUSSIAN_TAIL) * c * Math.max(0, Math.sqrt(2 / Math.PI) * expectedR[j] - 3), 0);
  const ratioFloor = excessFloor / width;
  console.log(`    R(s) ${formatR(metrics.r)}  R(s)/R(1) ${formatR(measuredR)}`);
  console.log(`    R(s)/R(1) の理論値 ${formatR(expectedR.slice(0, measuredR.length))}`);
  console.log(`    超過/幅 ${ratio.toFixed(4)}(下界 ${ratioFloor.toFixed(4)})  裾 ${(100 * metrics.tail).toFixed(3)}%`);
  assert.ok(inRange(metrics.r[0], WHITE_R_RANGE), `R(1) = ${metrics.r[0]}`);
  for (const [j, r] of measuredR.entries()) {
    const expected = expectedR[j];
    assert.ok(within(r, expected, UPSCALED_R_TOLERANCE * expected), `R(${BAND_SCALES[j]})/R(1) = ${r}(${expected})`);
  }
  assert.ok(ratio >= ratioFloor, `超過/幅 ${ratio}(下界 ${ratioFloor})`);
});

check('1% の画素に 20 倍の外れ値を混ぜると裾の重さが 1% を超え、粒は 10% 以上動かない', () => {
  const clean = noiseImage(30, WIDTH, HEIGHT);
  const random = uniformRandom(31);
  const outliers = Uint8Array.from({ length: WIDTH * HEIGHT }, () => (random() < 0.01 ? 1 : 0));
  const dirty = clean.candidate.map((plane) => plane.map((v, p) => (outliers[p] ? 20 * v : v)));
  const before = errorMetrics(clean.candidate, clean.reference, allPixels, WIDTH, HEIGHT, 0);
  const after = errorMetrics(dirty, clean.reference, allPixels, WIDTH, HEIGHT, 0);
  // 幅の項は粒に比例する。
  const grainShift = after.widthTerm / before.widthTerm - 1;
  console.log(`    裾 ${(100 * after.tail).toFixed(3)}%  粒の変化 ${(100 * grainShift).toFixed(2)}%`);
  assert.ok(after.tail >= 0.01, `裾 ${after.tail}`);
  assert.ok(Math.abs(grainShift) < 0.1, `粒の変化 ${grainShift}`);
});

// 全解像度の白色雑音 σ = 1 を 256² 画素で。均しの誤差の分散は重みの二乗和で決まり、S は雑音の大きさに比例する。
// t = 0 では密な均しが均さない raw より悪く(粒が消えて、残った粗い帯を説明できない)、t が粒の 0.2 倍になると粗い帯の
// 超過が t に収まり、粒の小さいものほど良くなる。
check('理想化した均しの G が重みの二乗和に合い、S の順が t で入れ替わる', () => {
  const size = 256;
  const raw = gaussianNoise(40, size * size);
  const dense = dense5x5(raw, size, size, 1);
  const weights = [-2, -1, 0, 1, 2].map((i) => Math.exp(-i * i / 2));
  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  // 5×5 のガウスの重みの二乗和と中心の重み。
  const squareSum = (weights.reduce((sum, w) => sum + w * w, 0) / weightSum ** 2) ** 2;
  const center = (1 / weightSum) ** 2;
  const candidates = {
    'raw': { plane: raw, g: 1 },
    '標本 4 倍の raw': { plane: gaussianNoise(41, size * size, 0.5), g: 0.5 },
    '密な 5×5': { plane: dense, g: Math.sqrt(squareSum) },
    '半分だけ均す': { plane: raw.map((v, p) => 0.5 * v + 0.5 * dense[p]), g: Math.sqrt(0.25 + 0.25 * squareSum + 0.5 * center) },
    '密な 2 段': { plane: dense5x5(dense, size, size, 4), g: null },
  };
  const mask = new Uint8Array(size * size).fill(1);
  const zero = firstComponentOnly(new Float32Array(size * size));
  const scores = {};
  for (const [name, { plane, g }] of Object.entries(candidates)) {
    const metrics = [0, 0.05, 0.2].map((t) => errorMetrics(firstComponentOnly(plane), zero, mask, size, size, t));
    scores[name] = metrics.map((m) => m.score);
    console.log(`    ${name}: G ${metrics[0].g.toFixed(3)}  S ${scores[name].map((v) => v.toFixed(2)).join(' / ')}  R(s) ${metrics[0].r.map((v) => v.toFixed(2)).join(' / ')}`);
    if (g !== null) assert.ok(within(metrics[0].g, g, 0.05 * g), `${name} の G = ${metrics[0].g}(${g})`);
  }
  assert.ok(within(scores['標本 4 倍の raw'][0], scores.raw[0] / 2, 0.05 * scores.raw[0]), '標本 4 倍の S(0) が raw の半分');
  assert.ok(scores['密な 5×5'][0] > scores.raw[0], 't = 0 では密な均しが悪い');
  assert.ok(scores['密な 5×5'][2] < scores.raw[2] && scores['密な 2 段'][2] < scores['密な 5×5'][2], 't が粒の 0.2 倍なら均すほど良い');
});

if (failures.length > 0) {
  console.error(`\n${failures.length} 件が落ちた: ${failures.join(', ')}`);
  process.exitCode = 1;
}
