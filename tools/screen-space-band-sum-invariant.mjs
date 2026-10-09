// 4帯の和が帯1の raw に一致するという不変条件の検査。判定は画素ごとの半精度の丸め幅で行う。
import { unpackedBand } from './screen-space-lab.mjs';
import { signedPng } from './screen-space-chain-runs.mjs';

const POSITION_LIMIT = 256;
const HALF_SUBNORMAL_SPACING = 2 ** -24;
const HALF_NORMAL_MINIMUM = 2 ** -14;
const HALF_MANTISSA_BITS = 10;

// 半精度で値 x の近くに並ぶ数の間隔(丸め幅)。
export function halfSpacing(x) {
  const magnitude = Math.abs(x);
  if (magnitude < HALF_NORMAL_MINIMUM) return HALF_SUBNORMAL_SPACING;
  let exponent = Math.floor(Math.log2(magnitude));
  if (2 ** (exponent + 1) <= magnitude) exponent++;
  else if (2 ** exponent > magnitude) exponent--;
  return 2 ** (exponent - HALF_MANTISSA_BITS);
}

// 帯0が raw に当たる1帯の撮影 raw(画素ごとに RGBA)と、4帯 bands(画素ごとに RGB の並び × 帯数)を比べる。
// 画素・成分ごとの許容は、raw と各帯の値の半精度の丸め幅の和。
// 返り値は stats(平均絶対差・RMS・最大絶対差・許容を超えた数と位置)と、画素ごとに RGB の raw − 4帯和 difference。
export function bandSumInvariant(raw, bands) {
  const pixels = raw.length / 4;
  const difference = new Float32Array(pixels * 3);
  const exceeded = [];
  const exceededPixels = new Set();
  let exceededCount = 0, sum = 0, squares = 0, maximumAbsolute = 0, maximumRatio = 0;
  for (let p = 0; p < pixels; p++) for (let c = 0; c < 3; c++) {
    const i = p * 3 + c;
    const rawValue = raw[p * 4 + c];
    let bandSum = 0, tolerance = halfSpacing(rawValue);
    for (const band of bands) {
      bandSum += band[i];
      tolerance += halfSpacing(band[i]);
    }
    const delta = rawValue - bandSum;
    difference[i] = delta;
    sum += Math.abs(delta);
    squares += delta * delta;
    maximumAbsolute = Math.max(maximumAbsolute, Math.abs(delta));
    maximumRatio = Math.max(maximumRatio, Math.abs(delta) / tolerance);
    if (Math.abs(delta) > tolerance) {
      exceededCount++;
      exceededPixels.add(p);
      if (exceeded.length < POSITION_LIMIT) exceeded.push({ pixel: p, channel: c, raw: rawValue, difference: delta, tolerance });
    }
  }
  const count = pixels * 3;
  return { stats: { meanAbsolute: sum / count, rms: Math.sqrt(squares / count), maximumAbsolute,
    maximumToleranceRatio: maximumRatio, roundingExceeded: { count: exceededCount, pixelCount: exceededPixels.size, firstPositions: exceeded } }, difference };
}

// 白色雑音のパス pass で、1帯の撮影と tier の撮影を比べる。呼ぶとき lab は tier の描画を終えた状態になる。
export async function captureBandSumInvariant(lab, tier, pass) {
  await lab.setTier({ ...tier, bandCount: 1 });
  await lab.setWhiteNoisePass(pass);
  await lab.render();
  const raw = await lab.readFloat('band-sum', 4);
  await lab.setTier(tier);
  await lab.render();
  const packed = [];
  for (let texture = 0; texture < 3; texture++) packed.push(await lab.readFloat(`packed-bands-${texture}`, 4));
  return bandSumInvariant(raw, Array.from({ length: tier.bandCount }, (_, band) => unpackedBand(packed, band)));
}

// 差の地図 PNG と、飽和しない最大の 2 の冪の係数 gain(表示は 0.5 + gain × 差)。
export function invariantMapOf(difference) {
  const maximum = difference.reduce((m, value) => Math.max(m, Math.abs(value)), 0);
  const gain = maximum === 0 ? 1 : 2 ** Math.floor(Math.log2(0.5 / maximum));
  return { gain, png: signedPng(difference, 3, 0.5 / gain) };
}
