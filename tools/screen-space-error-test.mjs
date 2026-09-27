// tools/screen-space-error.mjs の指標を、合成した誤差で理論値と照らす。
//
// 使い方: node tools/screen-space-error-test.mjs。失敗した検査を並べて終了コード 1 で終わる。
import assert from 'node:assert/strict';
import { errorMetrics, ERROR_SCALES } from './screen-space-error.mjs';

// 全面の検査の寸法と、印の縁と画像の端が効く検査の寸法 [画素]。
const [WIDTH, HEIGHT] = [480, 270];
const [SMALL_WIDTH, SMALL_HEIGHT] = [240, 135];
// 白色雑音の場を重ねる枚数(1 枚が 3 成分)。粗いスケールほど独立な標本が少ないので、場を重ねて揺らぎを抑える。
const WHITE_FIELDS = 8;
const SMALL_WHITE_FIELDS = 24;
// 白色雑音での 1/R(s) = RMS(σ̃_s)/RMS(L_s) の理論値。s ≥ 2 は 1。s = 1 は雑音 H_1 = e − G_1∗e の分散
// E[H²] = 1 − 2ĝ(0) + Σĝ² が 1 より小さく、画像の内側で sqrt(0.7613) = 0.872。
const WHITE_FINEST_RATIO = 0.872;
// 1/R(s) の許容幅。場を重ねても標本が足りない粗いスケールは、場ごとの値の標準誤差の 3 倍まで広げる。
const WHITE_RATIO_TOLERANCE = 0.05;
const FINEST_RATIO_TOLERANCE = 0.03;
// 誤差の振幅(q)。偽の構造の罰の分母の下限 ε = 3e-4 が効かない大きさ。
const AMPLITUDE = 1;

// 種 seed の一様乱数(mulberry32)。
function uniformRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

// 種 seed の、標準偏差 sigma の白色ガウス雑音の平面(count 画素)。
function gaussianNoise(seed, count, sigma) {
  const random = uniformRandom(seed);
  return Float32Array.from({ length: count }, () => sigma * Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random()));
}

// 3 成分とも種を変えた、標準偏差 AMPLITUDE の白色雑音の平面の組。
const whiteImage = (seed, width, height) => [0, 1, 2].map((c) => gaussianNoise(seed + c, width * height, AMPLITUDE));

// 平面 values を、標準偏差 sigma [画素]・半径 3σ のガウスで均す。画像の外は除いて重みを正規化する。
function gaussianBlurOf(values, width, height, sigma) {
  const radius = Math.ceil(3 * sigma);
  const kernel = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)));
  const pass = (source, dx, dy) => Float32Array.from({ length: width * height }, (_, p) => {
    const [x, y] = [p % width, Math.floor(p / width)];
    let [sum, weight] = [0, 0];
    for (let i = -radius; i <= radius; i++) {
      const [nx, ny] = [x + i * dx, y + i * dy];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      sum += kernel[i + radius] * source[ny * width + nx];
      weight += kernel[i + radius];
    }
    return sum / weight;
  });
  return pass(pass(values, 1, 0), 0, 1);
}

// 白色雑音を標準偏差 sigma [画素] のガウスで均した滑らかなムラ(3 成分)を、成分をまとめた RMS が AMPLITUDE になる
// よう揃えたもの。
function muraImage(seed, width, height, sigma) {
  const planes = whiteImage(seed, width, height).map((plane) => gaussianBlurOf(plane, width, height, sigma));
  const rms = Math.sqrt(planes.reduce((sum, plane) => sum + plane.reduce((s, v) => s + v * v, 0), 0) / (3 * width * height));
  return planes.map((plane) => plane.map((v) => (AMPLITUDE / rms) * v));
}

const zeroImage = (width, height) => [0, 1, 2].map(() => new Float32Array(width * height));
const fullMask = (width, height) => new Uint8Array(width * height).fill(1);
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

// 誤差 candidate を 0 の収束先と比べた指標。
const metricsOf = (candidate, mask, width, height) => errorMetrics(candidate, zeroImage(width, height), mask, width, height);
// 偽の構造の項の、雑音の項に対する比。
const falseStructureRatioOf = (metrics) => metrics.falseStructureTerm / metrics.noiseTerm;
const format = (values, digits = 3) => values.map((v) => v.toFixed(digits)).join(' / ');

// 種を変えた fields 枚の白色雑音の、スケールごとの 1/R(s) を場をまとめた値と、場ごとの値の標準誤差。σ̃ の和は場に
// よらずほぼ一定なので、場をまとめた値は 1 / sqrt(mean R(s)²)。
function whiteHonestRatiosOf(mask, width, height, fields) {
  const rs = Array.from({ length: fields }, (_, k) => metricsOf(whiteImage(100 + 3 * k, width, height), mask, width, height).r);
  return ERROR_SCALES.map((_, j) => {
    const values = rs.map((r) => 1 / r[j]);
    const mean = values.reduce((sum, v) => sum + v, 0) / fields;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (fields - 1);
    return { ratio: 1 / Math.sqrt(rs.reduce((sum, r) => sum + r[j] ** 2, 0) / fields), error: Math.sqrt(variance / fields) };
  });
}

// 白色雑音の 1/R(s) が理論値の許容幅に入るか確かめる。
function assertWhiteHonestRatios(mask, width, height, fields) {
  const ratios = whiteHonestRatiosOf(mask, width, height, fields);
  console.log(`    1/R(s) ${format(ratios.map((r) => r.ratio))}(標準誤差 ${format(ratios.map((r) => r.error))})`);
  for (const [j, { ratio, error }] of ratios.entries()) {
    const [expected, tolerance] = j === 0 ? [WHITE_FINEST_RATIO, FINEST_RATIO_TOLERANCE] : [1, WHITE_RATIO_TOLERANCE];
    const allowed = Math.max(tolerance, 3 * error);
    assert.ok(Math.abs(ratio - expected) <= allowed, `s = ${ERROR_SCALES[j]}: 1/R ${ratio}(${expected} ± ${allowed})`);
  }
}

check('誤差 0 なら S も G も 0', () => {
  const metrics = metricsOf(zeroImage(SMALL_WIDTH, SMALL_HEIGHT), fullMask(SMALL_WIDTH, SMALL_HEIGHT), SMALL_WIDTH, SMALL_HEIGHT);
  assert.equal(metrics.score, 0);
  assert.equal(metrics.g, 0);
});

check('全面の白色雑音: RMS(σ̃_s)/RMS(L_s) が s ≥ 2 で 1、s = 1 で 0.872', () => {
  assertWhiteHonestRatios(fullMask(WIDTH, HEIGHT), WIDTH, HEIGHT, WHITE_FIELDS);
});

check('印の縁と画像の端を含む白色雑音: RMS(σ̃_s)/RMS(L_s) が s ≥ 2 で 1、s = 1 で 0.872', () => {
  // 左の 40 列と、中ほどの半径 30 の円を外した印。
  const mask = Uint8Array.from({ length: SMALL_WIDTH * SMALL_HEIGHT }, (_, p) => {
    const [x, y] = [p % SMALL_WIDTH, Math.floor(p / SMALL_WIDTH)];
    return x >= 40 && (x - 140) ** 2 + (y - 67) ** 2 > 30 ** 2 ? 1 : 0;
  });
  assertWhiteHonestRatios(mask, SMALL_WIDTH, SMALL_HEIGHT, SMALL_WHITE_FIELDS);
});

const mask = fullMask(WIDTH, HEIGHT);
const white = metricsOf(whiteImage(10, WIDTH, HEIGHT), mask, WIDTH, HEIGHT);
console.log(`  白色雑音: 雑音 ${white.noiseTerm.toFixed(4)}  偽の構造 ${white.falseStructureTerm.toFixed(4)}  R(s) ${format(white.r)}`);

check('孤立した輝点: 偽の構造の項の雑音の項に対する比が、正直な白色雑音以下(輝点が自分で説明される)', () => {
  const spot = zeroImage(WIDTH, HEIGHT);
  for (const plane of spot) plane[(HEIGHT / 2) * WIDTH + WIDTH / 2] = AMPLITUDE;
  const metrics = metricsOf(spot, mask, WIDTH, HEIGHT);
  console.log(`    偽の構造 / 雑音: 輝点 ${falseStructureRatioOf(metrics).toFixed(2)}、白色雑音 ${falseStructureRatioOf(white).toFixed(2)}`);
  assert.ok(falseStructureRatioOf(metrics) <= falseStructureRatioOf(white), `輝点 ${falseStructureRatioOf(metrics)}`);
});

// 同じエネルギーの、大きさの違うムラ。
const muraSigmas = [4, 8, 16, 32];
const muras = muraSigmas.map((sigma) => metricsOf(muraImage(20, WIDTH, HEIGHT, sigma), mask, WIDTH, HEIGHT));

check('滑らかなムラ(σ = 8): 偽の構造の項が白色雑音の比の 10 倍を超え、R(s) が 4 px 以上の帯で 10 を超える', () => {
  const mura = muras[muraSigmas.indexOf(8)];
  console.log(`    偽の構造 / 雑音 ${falseStructureRatioOf(mura).toFixed(1)}  R(s) ${format(mura.r, 1)}`);
  assert.ok(falseStructureRatioOf(mura) > 10 * falseStructureRatioOf(white), `偽の構造 / 雑音 ${falseStructureRatioOf(mura)}`);
  for (const [j, s] of ERROR_SCALES.entries()) {
    if (s >= 4) assert.ok(mura.r[j] > 10, `R(${s}) = ${mura.r[j]}`);
  }
});

check('同じエネルギーのムラは、大きいほど偽の構造の項が小さい', () => {
  console.log(`    σ = ${muraSigmas.join(' / ')}: 偽の構造 ${format(muras.map((m) => m.falseStructureTerm), 4)}`);
  for (let k = 1; k < muras.length; k++) {
    assert.ok(muras[k].falseStructureTerm < muras[k - 1].falseStructureTerm, `σ = ${muraSigmas[k]} が σ = ${muraSigmas[k - 1]} 以上`);
  }
});

check('誤差を 3 倍にすると、S も 3 倍になる', () => {
  const noise = whiteImage(30, WIDTH, HEIGHT);
  const mura = muraImage(40, WIDTH, HEIGHT, 8);
  const mixed = noise.map((plane, c) => plane.map((v, p) => v + mura[c][p]));
  const base = metricsOf(mixed, mask, WIDTH, HEIGHT);
  const tripled = metricsOf(mixed.map((plane) => plane.map((v) => 3 * v)), mask, WIDTH, HEIGHT);
  console.log(`    S ${base.score.toFixed(4)} → ${tripled.score.toFixed(4)}(比 ${(tripled.score / base.score).toFixed(4)})`);
  assert.ok(Math.abs(tripled.score / base.score - 3) <= 0.03, `比 ${tripled.score / base.score}`);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} 件が落ちた: ${failures.join(', ')}`);
  process.exitCode = 1;
}
