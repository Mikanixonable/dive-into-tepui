// 地表 render-lab の画像比較に使う、画像形式へ依存しない数値契約。
// ここでは合否を決めず、観測値と目安のしきい値を同じ結果へ残す。

export const EARTH_SURFACE_ADJACENT_THRESHOLD = 2 / 255;

// Capture の条件は、撮影環境が変わっても結果を比較できるようコード側で固定する。
// これは実際のデータを持つかどうかとは独立した、検証ケースの識別子である。
export const EARTH_SURFACE_CAPTURE_VIEWPORT = { width: 1920, height: 1080 } as const;
export const EARTH_SURFACE_CAPTURE_FRAMES = 300;

export const EARTH_SURFACE_CAPTURE_CASES = [
  'himalaya-50km', 'himalaya-200km', 'himalaya-2000km', 'equator', 'latitude-60',
  'north-pole', 'south-pole', 'date-line', 'coast', 'blue-land', 'ice',
  'negative-elevation-land', 'seabed', 'schematic', 'lod-fallback',
] as const;

export type EarthSurfaceCaptureCase = typeof EARTH_SURFACE_CAPTURE_CASES[number];
export type EarthSurfaceCaptureStatus = 'complete' | 'unavailable' | 'failed';

export interface EarthSurfaceCaptureEnvironment {
  readonly browser: string | null;
  readonly backend: string | null;
  readonly webgpu: 'available' | 'unavailable' | 'unknown';
  readonly drawingBuffer: 'available' | 'unavailable' | 'unknown';
}

export interface EarthSurfaceCaptureReplayScenario {
  readonly id: string;
  readonly status: 'covered-by-tests' | 'unavailable';
  readonly test: string | null;
}

export interface EarthSurfaceCaptureBuffer {
  readonly status: EarthSurfaceCaptureStatus;
  readonly path: string | null;
  readonly sha256: string | null;
  readonly byteLength: number | null;
  readonly reason: string | null;
}

export interface EarthSurfaceCaptureCaseResult {
  readonly caseName: EarthSurfaceCaptureCase;
  readonly status: EarthSurfaceCaptureStatus;
  readonly datasetId: string | null;
  readonly viewport: typeof EARTH_SURFACE_CAPTURE_VIEWPORT;
  readonly projection: string;
  readonly sunAzimuthDeg: number;
  readonly selectedZ: number | null;
  readonly errorPx: number | null;
  readonly frontier: readonly string[];
  readonly fallbackRate: number | null;
  readonly httpDecodeWaitMs: number | null;
  readonly gpuLayers: number | null;
  readonly pageTableUpdates: number | null;
  readonly encodedBytes: number | null;
  readonly payloadBytes: number | null;
  readonly gpuP95Ms: number | null;
  readonly frames: number;
  readonly color: EarthSurfaceCaptureBuffer;
  readonly normal: EarthSurfaceCaptureBuffer;
  readonly depth: EarthSurfaceCaptureBuffer;
  readonly reason: string | null;
}

export interface EarthSurfaceCaptureDocument {
  readonly schemaVersion: 2;
  readonly capturedAt: string;
  readonly environment: EarthSurfaceCaptureEnvironment;
  readonly viewport: typeof EARTH_SURFACE_CAPTURE_VIEWPORT;
  readonly framesPerCase: number;
  readonly replayScenarios: readonly EarthSurfaceCaptureReplayScenario[];
  readonly cases: readonly EarthSurfaceCaptureCaseResult[];
}

export const EARTH_SURFACE_CAPTURE_CASE_SET: ReadonlySet<string> = new Set(EARTH_SURFACE_CAPTURE_CASES);

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

const unavailableBuffer = (reason: string): EarthSurfaceCaptureBuffer => ({
  status: 'unavailable', path: null, sha256: null, byteLength: null, reason,
});

// ブラウザやWebGPUが無い実行環境でも、ケースを落とさず「測れていない」として保存する。
// 単色の代替画像を作らないため、画像の不在が成功画像と混同されない。
export function createUnavailableEarthSurfaceCapture(input: {
  readonly capturedAt: string;
  readonly reason: string;
  readonly environment?: Partial<EarthSurfaceCaptureEnvironment>;
}): EarthSurfaceCaptureDocument {
  const environment: EarthSurfaceCaptureEnvironment = {
    browser: input.environment?.browser ?? null,
    backend: input.environment?.backend ?? null,
    webgpu: input.environment?.webgpu ?? 'unavailable',
    drawingBuffer: input.environment?.drawingBuffer ?? 'unavailable',
  };
  return {
    schemaVersion: 2,
    capturedAt: input.capturedAt,
    environment,
    viewport: EARTH_SURFACE_CAPTURE_VIEWPORT,
    framesPerCase: EARTH_SURFACE_CAPTURE_FRAMES,
    replayScenarios: [
      { id: 'out-of-order-arrival', status: 'covered-by-tests', test: 'tests/render/earth-surface-resident.test.ts' },
      { id: 'http-404', status: 'covered-by-tests', test: 'tests/render/earth-surface-request.test.ts' },
      { id: 'http-408-429-5xx', status: 'covered-by-tests', test: 'tests/render/earth-surface-request.test.ts' },
      { id: 'network-failure', status: 'covered-by-tests', test: 'tests/render/earth-surface-request.test.ts' },
      { id: '128-layer-capacity', status: 'covered-by-tests', test: 'tests/render/earth-surface-resident.test.ts' },
      { id: 'dispose-and-generation', status: 'covered-by-tests', test: 'tests/render/earth-surface-request.test.ts' },
      { id: 'mipmap-disabled', status: 'covered-by-tests', test: 'tests/render/earth-surface-gpu.test.ts' },
    ],
    cases: EARTH_SURFACE_CAPTURE_CASES.map((caseName) => ({
      caseName,
      status: 'unavailable',
      datasetId: null,
      viewport: EARTH_SURFACE_CAPTURE_VIEWPORT,
      projection: 'ellipsoid-equirectangular',
      sunAzimuthDeg: 0,
      selectedZ: null,
      errorPx: null,
      frontier: [],
      fallbackRate: null,
      httpDecodeWaitMs: null,
      gpuLayers: null,
      pageTableUpdates: null,
      encodedBytes: null,
      payloadBytes: null,
      gpuP95Ms: null,
      frames: EARTH_SURFACE_CAPTURE_FRAMES,
      color: unavailableBuffer(input.reason),
      normal: unavailableBuffer(input.reason),
      depth: unavailableBuffer(input.reason),
      reason: input.reason,
    })),
  };
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
