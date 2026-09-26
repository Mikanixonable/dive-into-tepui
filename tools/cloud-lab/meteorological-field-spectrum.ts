// 局所格子場の二次元パワースペクトルを方向別に集計する計測。
// 実数入力のスペクトル対称性を使い、波数ベクトルの方位を半周へ畳んで bin へ積算する。
import type { CloudFieldPlane } from './meteorological-field-measures';

export interface DirectionalSpectrum {
  // 方位 bin 幅 [rad]。bin i は [i * width, (i+1) * width)。
  readonly azimuthBinWidthRad: number;
  // 直流成分を除いた、方位 bin ごとのパワー和。
  readonly azimuthBinPowers: readonly number[];
  // 最大パワーを持つ bin。全パワー零の場では -1。
  readonly peakBinIndex: number;
  // 最大パワーを持つ周波数成分の方位 [rad](半周へ畳んだもの)。全パワー零では null。
  readonly peakComponentAzimuthRad: number | null;
  // 全パワーに対する最大 bin の割合。全パワー零では 0。
  readonly directionalConcentration: number;
}

function requirePowerOfTwo(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || (value & (value - 1)) !== 0) {
    throw new RangeError(`${name} must be a power of two`);
  }
}

// 反復 radix-2 FFT。re/im は長さ n の作業配列で、結果へ上書きされる。
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let index = 0, j = 0; index < n; index += 1) {
    if (index < j) {
      const tmpRe = re[index]!; re[index] = re[j]!; re[j] = tmpRe;
      const tmpIm = im[index]!; im[index] = im[j]!; im[j] = tmpIm;
    }
    let bit = n >> 1;
    while (bit >= 1 && j >= bit) { j -= bit; bit >>= 1; }
    j += bit;
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angleStep = -2 * Math.PI / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k += 1) {
        const angle = angleStep * k;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const even = start + k;
        const odd = start + k + half;
        const oddRe = re[odd]! * cos - im[odd]! * sin;
        const oddIm = re[odd]! * sin + im[odd]! * cos;
        re[odd] = re[even]! - oddRe;
        im[odd] = im[even]! - oddIm;
        re[even] = re[even]! + oddRe;
        im[even] = im[even]! + oddIm;
      }
    }
  }
}

// 行・列の分離 FFT で |F|^2 を求め、波数ベクトルの方位を半周へ畳んで bin へ積算する。
// 平面の値はそのまま変換し、直流成分 (0,0) は bin へ含めない。
export function directionalPowerSpectrum(
  plane: CloudFieldPlane,
  azimuthBinCount: number,
): DirectionalSpectrum {
  if (!(plane.values instanceof Float32Array)
    || plane.values.length !== plane.width * plane.height) {
    throw new RangeError('plane values must be a Float32Array of width * height');
  }
  requirePowerOfTwo(plane.width, 'plane.width');
  requirePowerOfTwo(plane.height, 'plane.height');
  if (!Number.isSafeInteger(azimuthBinCount) || azimuthBinCount <= 0) {
    throw new RangeError('azimuthBinCount must be a positive integer');
  }
  const { width, height } = plane;

  const re = new Float64Array(width * height);
  const im = new Float64Array(width * height);
  for (let index = 0; index < plane.values.length; index += 1) re[index] = plane.values[index]!;

  const rowRe = new Float64Array(width);
  const rowIm = new Float64Array(width);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      rowRe[column] = re[row * width + column]!;
      rowIm[column] = 0;
    }
    fftInPlace(rowRe, rowIm);
    for (let column = 0; column < width; column += 1) {
      re[row * width + column] = rowRe[column]!;
      im[row * width + column] = rowIm[column]!;
    }
  }
  const columnRe = new Float64Array(height);
  const columnIm = new Float64Array(height);
  for (let column = 0; column < width; column += 1) {
    for (let row = 0; row < height; row += 1) {
      columnRe[row] = re[row * width + column]!;
      columnIm[row] = im[row * width + column]!;
    }
    fftInPlace(columnRe, columnIm);
    for (let row = 0; row < height; row += 1) {
      re[row * width + column] = columnRe[row]!;
      im[row * width + column] = columnIm[row]!;
    }
  }

  // インデックスから符号付き波数へ折り返す。
  const signedIndex = (index: number, size: number): number =>
    (index <= size / 2 ? index : index - size);
  const binPowers = new Array<number>(azimuthBinCount).fill(0);
  let peakBinIndex = -1;
  let peakComponentAzimuthRad: number | null = null;
  let peakPower = 0;
  let totalPower = 0;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const kx = signedIndex(column, width);
      const ky = signedIndex(row, height);
      if (kx === 0 && ky === 0) continue;
      const power = re[row * width + column]! ** 2 + im[row * width + column]! ** 2;
      let azimuth = Math.atan2(ky, kx);
      if (azimuth < 0) azimuth += Math.PI;
      const binIndex = Math.min(
        azimuthBinCount - 1, Math.floor(azimuth / Math.PI * azimuthBinCount));
      binPowers[binIndex]! += power;
      totalPower += power;
      if (power > peakPower) {
        peakPower = power;
        peakBinIndex = binIndex;
        peakComponentAzimuthRad = azimuth;
      }
    }
  }
  return {
    azimuthBinWidthRad: Math.PI / azimuthBinCount,
    azimuthBinPowers: binPowers,
    peakBinIndex,
    peakComponentAzimuthRad,
    directionalConcentration: totalPower === 0 ? 0 : binPowers[peakBinIndex]! / totalPower,
  };
}
