// 地表 render-lab の画像比較に使う、画像形式へ依存しない数値契約。
// ここでは合否を決めず、観測値と目安のしきい値を同じ結果へ残す。

export const EARTH_SURFACE_ADJACENT_THRESHOLD = 2 / 255;

export interface EarthSurfaceAdjacentDifference {
  readonly sampleCount: number;
  readonly maxAbsoluteDifference: number;
  readonly meanAbsoluteDifference: number;
  readonly threshold: number;
  readonly exceedsThreshold: boolean;
}

export interface RgbaRangeCheck {
  readonly valid: boolean;
  readonly finite: boolean;
  readonly inRange: boolean;
  readonly componentCount: number;
  readonly invalidIndex: number | null;
}

export interface EarthSurfaceImageMetric {
  readonly caseName: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface EarthSurfaceMetrics {
  readonly schemaVersion: 1;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly cases: readonly EarthSurfaceImageMetric[];
}

// 8bit値を0..1へ正規化した隣接差を集計する。隣接する画素・チャンネルを平坦化した列を
// 受け取るため、PNGのデコーダやGPUへ依存せず、タイル境界の検査にも再利用できる。
export function measureAdjacent8BitDifference(
  samples: readonly number[],
  threshold = EARTH_SURFACE_ADJACENT_THRESHOLD,
): EarthSurfaceAdjacentDifference {
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new RangeError('threshold must be a finite non-negative number');
  }
  if (samples.some((sample) => !Number.isInteger(sample) || sample < 0 || sample > 255)) {
    throw new RangeError('samples must contain 8bit unsigned integers');
  }

  let maxAbsoluteDifference = 0;
  let sumAbsoluteDifference = 0;
  for (let index = 1; index < samples.length; index++) {
    const difference = Math.abs(samples[index]! - samples[index - 1]!) / 255;
    maxAbsoluteDifference = Math.max(maxAbsoluteDifference, difference);
    sumAbsoluteDifference += difference;
  }
  const sampleCount = Math.max(0, samples.length - 1);
  const meanAbsoluteDifference = sampleCount === 0 ? 0 : sumAbsoluteDifference / sampleCount;
  return {
    sampleCount,
    maxAbsoluteDifference,
    meanAbsoluteDifference,
    threshold,
    exceedsThreshold: maxAbsoluteDifference > threshold,
  };
}

// RGBAの各成分を線形化前の0..1値として検査する。lengthも4の倍数である必要がある。
// NaN/Infinityを範囲検査だけで通さないため、finiteとinRangeを分けて返す。
export function checkRgbaRange(rgba: readonly number[]): RgbaRangeCheck {
  let finite = true;
  let inRange = rgba.length % 4 === 0;
  let invalidIndex: number | null = rgba.length % 4 === 0 ? null : rgba.length;
  for (const [index, value] of rgba.entries()) {
    if (!Number.isFinite(value)) {
      finite = false;
      invalidIndex ??= index;
    } else if (value < 0 || value > 1) {
      inRange = false;
      invalidIndex ??= index;
    }
  }
  return {
    valid: finite && inRange && rgba.length > 0,
    finite,
    inRange,
    componentCount: rgba.length,
    invalidIndex,
  };
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
}

// 撮影結果を固定スキーマへ正規化する。ケース順は名前順にそろえ、JSON.stringifyの結果を
// 実行順へ依存させない。画像の合否やしきい値による丸めはここでは行わない。
export function normalizeEarthSurfaceMetrics(input: {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly cases: readonly EarthSurfaceImageMetric[];
}): EarthSurfaceMetrics {
  const { width, height } = input.viewport;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError('viewport dimensions must be positive safe integers');
  }
  const cases = input.cases.map((entry) => {
    assertString(entry.caseName, 'caseName');
    assertString(entry.sha256, 'sha256');
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new TypeError('sha256 must be lowercase hexadecimal SHA-256');
    if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) throw new RangeError('byteLength must be a non-negative safe integer');
    return { caseName: entry.caseName, sha256: entry.sha256, byteLength: entry.byteLength };
  }).sort((left, right) => left.caseName < right.caseName ? -1 : left.caseName > right.caseName ? 1 : 0);
  if (new Set(cases.map((entry) => entry.caseName)).size !== cases.length) {
    throw new RangeError('caseName must be unique');
  }
  return {
    schemaVersion: 1,
    viewport: { width, height },
    cases,
  };
}
