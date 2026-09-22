// 描画テスト環境の地表の計測の口。CDP から渡る計測条件を固定条件と照らし、地表の計測結果の文書を返す。
import {
  createUnavailableEarthSurfaceCapture,
  EARTH_SURFACE_CAPTURE_CASES,
  EARTH_SURFACE_CAPTURE_FRAMES,
  EARTH_SURFACE_CAPTURE_VIEWPORT,
} from '../../src/render/earth-surface-metrics';
import type { EarthSurfaceCaptureDocument } from '../../src/render/earth-surface-metrics';

// 地表の計測条件。ケースの並び・画面の大きさ・フレーム数は、どれも固定条件と一致しなければならない。
export interface EarthSurfaceCaptureInput {
  readonly cases: readonly string[];
  readonly viewport: { readonly width: number; readonly height: number };
  readonly frames: number;
}

// cases が固定のケースと、並びの順まで一致するか。
function matchesFixedCases(cases: readonly string[]): boolean {
  return cases.length === EARTH_SURFACE_CAPTURE_CASES.length
    && cases.every((value, index) => value === EARTH_SURFACE_CAPTURE_CASES[index]);
}

// input が固定の計測条件と一致しなければ RangeError を投げる。
function assertInput(input: EarthSurfaceCaptureInput): void {
  // 条件は結果どうしを比べるために固定してあるので、1 つでも違えば計測を始めない。
  if (!matchesFixedCases(input.cases)) {
    throw new RangeError('Earth surface capture cases must match the fixed T5 case list');
  }
  if (input.viewport.width !== EARTH_SURFACE_CAPTURE_VIEWPORT.width
    || input.viewport.height !== EARTH_SURFACE_CAPTURE_VIEWPORT.height) {
    throw new RangeError('Earth surface capture viewport must be 1920x1080');
  }
  if (input.frames !== EARTH_SURFACE_CAPTURE_FRAMES) {
    throw new RangeError('Earth surface capture frames must be 300');
  }
}

// 地表の計測の口を作る。口は計測条件を検証し、計測結果の文書を返す。条件が固定条件と違えば投げる。
// TODO: 地表の実データ(bundle / manifest)が使えるようになったら、実データの計測へ差し替える。
// それまでは「データ未投入」の文書を返す。
export function createEarthSurfaceCaptureApi(): (input: EarthSurfaceCaptureInput) => EarthSurfaceCaptureDocument {
  return (input) => {
    assertInput(input);
    return createUnavailableEarthSurfaceCapture({
      capturedAt: new Date().toISOString(),
      reason: 'earth surface dataset is not available',
    });
  };
}
