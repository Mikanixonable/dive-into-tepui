import {
  createUnavailableEarthSurfaceCapture,
  EARTH_SURFACE_CAPTURE_CASES,
  EARTH_SURFACE_CAPTURE_FRAMES,
  EARTH_SURFACE_CAPTURE_VIEWPORT,
} from '../../src/render/earth-surface-metrics';
import type { EarthSurfaceCaptureDocument } from '../../src/render/earth-surface-metrics';

export interface EarthSurfaceCaptureInput {
  readonly cases: readonly string[];
  readonly viewport: { readonly width: number; readonly height: number };
  readonly frames: number;
}

function matchesFixedCases(cases: readonly string[]): boolean {
  return cases.length === EARTH_SURFACE_CAPTURE_CASES.length
    && cases.every((value, index) => value === EARTH_SURFACE_CAPTURE_CASES[index]);
}

function assertInput(input: EarthSurfaceCaptureInput): void {
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

// Earth専用の実データ接続は、bundle/manifestの実体が利用可能になった段階で差し替える。
// いまはAPIを先に公開し、固定条件を検証したうえで「データ未投入」を返す。
export function createEarthSurfaceCaptureApi(): (input: EarthSurfaceCaptureInput) => EarthSurfaceCaptureDocument {
  return (input) => {
    assertInput(input);
    return createUnavailableEarthSurfaceCapture({
      capturedAt: new Date().toISOString(),
      reason: 'earth surface dataset is not available',
    });
  };
}
