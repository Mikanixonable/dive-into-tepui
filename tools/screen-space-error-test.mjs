// 描画テスト環境が測る近傍拡散補正の画質の指標を、合成した誤差で理論値と照らす。
//
// 使い方: 先に .render-lab/ を組み(webpack --config webpack.render-lab.config.js --mode production)、
// node tools/screen-space-error-test.mjs。失敗した検査を並べて終了コード 1 で終わる。
import assert from 'node:assert/strict';
import { withLab } from './screen-space-lab.mjs';

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
// 誤差の振幅(q)。偽の構造の罰の分母の下限 ε が効かない大きさ。
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

// 左半分に辺 CHECKER_BLOCK [画素] の市松で ±AMPLITUDE を置き、右半分を 0 とした、鋭い構造を持つ収束先の補正(3 成分とも
// 同じ)。
const CHECKER_BLOCK = 8;
function leftCheckerImage(width, height) {
  const plane = Float32Array.from({ length: width * height }, (_, p) => {
    const [x, y] = [p % width, Math.floor(p / width)];
    if (x >= width / 2) return 0;
    return (Math.floor(x / CHECKER_BLOCK) + Math.floor(y / CHECKER_BLOCK)) % 2 === 0 ? AMPLITUDE : -AMPLITUDE;
  });
  return [0, 1, 2].map(() => plane.slice());
}

// 平面の組 planes(幅 width)を左右に反転したもの。
const mirroredImage = (planes, width) => planes.map((plane) => plane.map((_, p) => {
  const x = p % width;
  return plane[p - x + (width - 1 - x)];
}));

const zeroImage = (width, height) => [0, 1, 2].map(() => new Float32Array(width * height));
const fullMask = (width, height) => new Uint8Array(width * height).fill(1);
const failures = [];

// 検査 name を走らせ、落ちたら並べて続ける。
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  - ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  FAIL - ${name}\n    ${error.message}`);
  }
}

// スコア(偽の構造の項)の、雑音の強さ N に対する比。
const falseStructureRatioOf = (metrics) => metrics.score / metrics.noiseTerm;
const format = (values, digits = 3) => values.map((v) => v.toFixed(digits)).join(' / ');

await withLab(async (lab) => {
  const scales = await lab.errorScales();
  // 誤差 candidate を 0 の収束先と比べた指標。
  const metricsOf = (candidate, mask, width, height) => (
    lab.errorMetrics(candidate, zeroImage(width, height), mask, width, height));

  // 種を変えた fields 枚の白色雑音の、スケールごとの 1/R(s) を場をまとめた値と、場ごとの値の標準誤差。σ̃ の和は場に
  // よらずほぼ一定なので、場をまとめた値は 1 / sqrt(mean R(s)²)。
  async function whiteHonestRatiosOf(mask, width, height, fields) {
    const rs = [];
    for (let k = 0; k < fields; k++) {
      rs.push((await metricsOf(whiteImage(100 + 3 * k, width, height), mask, width, height)).r);
    }
    return scales.map((_, j) => {
      const values = rs.map((r) => 1 / r[j]);
      const mean = values.reduce((sum, v) => sum + v, 0) / fields;
      const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (fields - 1);
      return { ratio: 1 / Math.sqrt(rs.reduce((sum, r) => sum + r[j] ** 2, 0) / fields), error: Math.sqrt(variance / fields) };
    });
  }

  // 白色雑音の 1/R(s) が理論値の許容幅に入るか確かめる。
  async function assertWhiteHonestRatios(mask, width, height, fields) {
    const ratios = await whiteHonestRatiosOf(mask, width, height, fields);
    console.log(`    1/R(s) ${format(ratios.map((r) => r.ratio))}(標準誤差 ${format(ratios.map((r) => r.error))})`);
    for (const [j, { ratio, error }] of ratios.entries()) {
      const [expected, tolerance] = j === 0 ? [WHITE_FINEST_RATIO, FINEST_RATIO_TOLERANCE] : [1, WHITE_RATIO_TOLERANCE];
      const allowed = Math.max(tolerance, 3 * error);
      assert.ok(Math.abs(ratio - expected) <= allowed, `s = ${scales[j]}: 1/R ${ratio}(${expected} ± ${allowed})`);
    }
  }

  await check('誤差 0 なら S も G も 0', async () => {
    const [width, height] = [SMALL_WIDTH, SMALL_HEIGHT];
    const metrics = await metricsOf(zeroImage(width, height), fullMask(width, height), width, height);
    assert.equal(metrics.score, 0);
    assert.equal(metrics.g, 0);
  });

  await check('全面の白色雑音: RMS(σ̃_s)/RMS(L_s) が s ≥ 2 で 1、s = 1 で 0.872', async () => {
    await assertWhiteHonestRatios(fullMask(WIDTH, HEIGHT), WIDTH, HEIGHT, WHITE_FIELDS);
  });

  await check('印の縁と画像の端を含む白色雑音: RMS(σ̃_s)/RMS(L_s) が s ≥ 2 で 1、s = 1 で 0.872', async () => {
    // 左の 40 列と、中ほどの半径 30 の円を外した印。
    const mask = Uint8Array.from({ length: SMALL_WIDTH * SMALL_HEIGHT }, (_, p) => {
      const [x, y] = [p % SMALL_WIDTH, Math.floor(p / SMALL_WIDTH)];
      return x >= 40 && (x - 140) ** 2 + (y - 67) ** 2 > 30 ** 2 ? 1 : 0;
    });
    await assertWhiteHonestRatios(mask, SMALL_WIDTH, SMALL_HEIGHT, SMALL_WHITE_FIELDS);
  });

  const mask = fullMask(WIDTH, HEIGHT);
  const white = await metricsOf(whiteImage(10, WIDTH, HEIGHT), mask, WIDTH, HEIGHT);
  console.log(`  白色雑音: 雑音 ${white.noiseTerm.toFixed(4)}  偽の構造 ${white.score.toFixed(4)}  R(s) ${format(white.r)}`);

  // 同じエネルギーの、大きさの違うムラ。σ = 1・4・16 は盲検の場 n2・n8・n32(特徴の大きさ 2・8・32 px)と同じ均し方。
  const muraSigmas = [1, 4, 8, 16];
  const muras = [];
  for (const sigma of muraSigmas) muras.push(await metricsOf(muraImage(20, WIDTH, HEIGHT, sigma), mask, WIDTH, HEIGHT));

  await check('孤立した輝点: 偽の構造の項の雑音の項に対する比が、白色雑音と同じ桁(2 倍以下)で、滑らかなムラ(σ = 8)の 1/100 以下(輝点は雑音に数え、ムラに数えない)', async () => {
    const spot = zeroImage(WIDTH, HEIGHT);
    for (const plane of spot) plane[(HEIGHT / 2) * WIDTH + WIDTH / 2] = AMPLITUDE;
    const metrics = await metricsOf(spot, mask, WIDTH, HEIGHT);
    const muraRatio = falseStructureRatioOf(muras[muraSigmas.indexOf(8)]);
    console.log(`    偽の構造 / 雑音: 輝点 ${falseStructureRatioOf(metrics).toFixed(2)}、白色雑音 ${falseStructureRatioOf(white).toFixed(2)}、ムラ ${muraRatio.toFixed(1)}`);
    assert.ok(falseStructureRatioOf(metrics) <= 2 * falseStructureRatioOf(white), `輝点 ${falseStructureRatioOf(metrics)}`);
    assert.ok(falseStructureRatioOf(metrics) <= muraRatio / 100, `輝点 ${falseStructureRatioOf(metrics)}`);
  });

  await check('滑らかなムラ(σ = 8): 偽の構造の項が白色雑音の比の 10 倍を超え、R(s) が 4 px 以上の帯で 10 を超える', () => {
    const mura = muras[muraSigmas.indexOf(8)];
    console.log(`    偽の構造 / 雑音 ${falseStructureRatioOf(mura).toFixed(1)}  R(s) ${format(mura.r, 1)}`);
    assert.ok(falseStructureRatioOf(mura) > 10 * falseStructureRatioOf(white), `偽の構造 / 雑音 ${falseStructureRatioOf(mura)}`);
    for (const [j, s] of scales.entries()) {
      if (s >= 4) assert.ok(mura.r[j] > 10, `R(${s}) = ${mura.r[j]}`);
    }
  });

  await check('同じエネルギーのムラは、特徴の大きさ 8 px(σ = 4)が 2 px(σ = 1)と 32 px(σ = 16)より偽の構造の項が大きい', () => {
    console.log(`    σ = ${muraSigmas.join(' / ')}: 偽の構造 ${format(muras.map((m) => m.score), 4)}`);
    const termOf = (sigma) => muras[muraSigmas.indexOf(sigma)].score;
    assert.ok(termOf(4) > termOf(1), `σ = 4 が σ = 1 以下`);
    assert.ok(termOf(4) > termOf(16), `σ = 4 が σ = 16 以下`);
  });

  await check('誤差を 3 倍にすると、S も 3 倍になる', async () => {
    const noise = whiteImage(30, WIDTH, HEIGHT);
    const mura = muraImage(40, WIDTH, HEIGHT, 8);
    const mixed = noise.map((plane, c) => plane.map((v, p) => v + mura[c][p]));
    const base = await metricsOf(mixed, mask, WIDTH, HEIGHT);
    const tripled = await metricsOf(mixed.map((plane) => plane.map((v) => 3 * v)), mask, WIDTH, HEIGHT);
    console.log(`    S ${base.score.toFixed(4)} → ${tripled.score.toFixed(4)}(比 ${(tripled.score / base.score).toFixed(4)})`);
    assert.ok(Math.abs(tripled.score / base.score - 3) <= 0.03, `比 ${tripled.score / base.score}`);
  });

  // 覆い隠し(誤差の帯から収束先の同じ帯とそれを広げたものに当てた成分を除く局所の回帰)と、E_s の床 ε の並び。
  // 覆い隠さない値は、同じ誤差を 0 の収束先に対して測ったもの。
  const epsilons = await lab.falseStructureEpsilons();
  const metricsAgainst = (reference, error, width, height) => lab.errorMetrics(
    reference.map((plane, c) => plane.map((v, p) => v + error[c][p])), reference, fullMask(width, height),
    width, height);
  const unmaskedOf = (error, width, height) => metricsAgainst(zeroImage(width, height), error, width, height);
  // 指標 metrics の、ε の添字 k の Σ_s E_s。
  const totalOf = (metrics, k) => metrics.unweightedFalseStructure.reduce((sum, band) => sum + band[k], 0);
  // 全ての ε で、覆い隠した Σ_s E_s の覆い隠さないものに対する比が accepts を満たすか確かめる。
  const assertRatios = (masked, unmasked, accepts, label) => {
    const ratios = epsilons.map((_, k) => totalOf(masked, k) / totalOf(unmasked, k));
    console.log(`    ${label}: Σ_s E_s の覆い隠さないものに対する比(ε = ${epsilons.join(' / ')}) ${format(ratios)}`);
    for (const [k, ratio] of ratios.entries()) assert.ok(accepts(ratio), `${label}, ε = ${epsilons[k]}: ${ratio}`);
  };
  // 鋭い構造を左半分に持つ収束先と、そのぼけ G_σ∗q_B − q_B。
  const converged = leftCheckerImage(WIDTH, HEIGHT);
  const blurErrorOf = (sigma) => converged.map((plane) => (
    gaussianBlurOf(plane, WIDTH, HEIGHT, sigma).map((v, p) => v - plane[p])));

  await check('覆い隠し: 収束先 × 灰色の滑らかな倍率の誤差は Σ_s E_s が半分以下に減り、反転して収束先の平らな所へ置いたものは 1 割も減らない', async () => {
    const [multiplier] = muraImage(50, WIDTH, HEIGHT, 8);
    const following = converged.map((plane) => plane.map((v, p) => v * multiplier[p]));
    const mirrored = mirroredImage(following, WIDTH);
    assertRatios(await metricsAgainst(converged, following, WIDTH, HEIGHT), await unmaskedOf(following, WIDTH, HEIGHT),
      (ratio) => ratio <= 0.5, '収束先 × 倍率');
    assertRatios(await metricsAgainst(converged, mirrored, WIDTH, HEIGHT), await unmaskedOf(mirrored, WIDTH, HEIGHT),
      (ratio) => ratio >= 0.9, '反転');
  });

  await check('覆い隠し: 収束先のぼけ G_σ∗q_B − q_B は、σ = 1・2・4・8・16 のどれでも Σ_s E_s が 3 割以下に減る', async () => {
    for (const sigma of [1, 2, 4, 8, 16]) {
      const blur = blurErrorOf(sigma);
      assertRatios(await metricsAgainst(converged, blur, WIDTH, HEIGHT), await unmaskedOf(blur, WIDTH, HEIGHT),
        (ratio) => ratio <= 0.3, `ぼけ σ = ${sigma}`);
    }
  });

  await check('覆い隠し: 収束先と独立な白色雑音は、どの帯でも除いた割合が 15% 以下', async () => {
    const [width, height] = [2 * WIDTH, 2 * HEIGHT];
    const metrics = await metricsAgainst(whiteImage(70, width, height), whiteImage(80, width, height), width, height);
    console.log(`    除いた割合 ${format(metrics.removedFraction)}`);
    for (const [j, s] of scales.entries()) assert.ok(metrics.removedFraction[j] <= 0.15, `s = ${s}: ${metrics.removedFraction[j]}`);
  });

  await check('覆い隠し: 収束先の振幅の大きい所に置いた形を持たないムラは、Σ_s E_s が 3 割も減らない', async () => {
    // 白色雑音を σ = 8 で均した灰色の場に、収束先の振幅を σ = 8 で均した包絡 G_8∗|q_B| を掛けたもの。
    const [field] = muraImage(60, WIDTH, HEIGHT, 8);
    const envelope = gaussianBlurOf(converged[0].map(Math.abs), WIDTH, HEIGHT, 8);
    const shapeless = converged.map(() => field.map((v, p) => v * envelope[p]));
    assertRatios(await metricsAgainst(converged, shapeless, WIDTH, HEIGHT), await unmaskedOf(shapeless, WIDTH, HEIGHT),
      (ratio) => ratio >= 0.7, '形を持たないムラ');
  });
});

if (failures.length > 0) {
  console.error(`\n${failures.length} 件が落ちた: ${failures.join(', ')}`);
  process.exitCode = 1;
}
