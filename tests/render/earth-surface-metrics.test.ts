// 地表画像比較の数値契約を、ブラウザやPNGデコーダなしで固定する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  EARTH_SURFACE_ADJACENT_THRESHOLD,
  checkRgbaRange,
  measureAdjacent8BitDifference,
  normalizeEarthSurfaceMetrics,
} from '../../src/render/earth-surface-metrics';

export function register(): void {
  test('earth surface metrics: 隣接差0と2/255境界を丸めず記録する', () => {
    const zero = measureAdjacent8BitDifference([12, 12, 12]);
    assert.equal(zero.maxAbsoluteDifference, 0);
    assert.equal(zero.meanAbsoluteDifference, 0);
    assert.equal(zero.exceedsThreshold, false);

    const boundary = measureAdjacent8BitDifference([0, 2, 0]);
    assert.equal(boundary.maxAbsoluteDifference, EARTH_SURFACE_ADJACENT_THRESHOLD);
    assert.equal(boundary.meanAbsoluteDifference, EARTH_SURFACE_ADJACENT_THRESHOLD);
    assert.equal(boundary.exceedsThreshold, false);
  });

  test('earth surface metrics: 目安しきい値を超える隣接差を合格へ丸めない', () => {
    const result = measureAdjacent8BitDifference([0, 3]);
    assert.equal(result.maxAbsoluteDifference, 3 / 255);
    assert.equal(result.meanAbsoluteDifference, 3 / 255);
    assert.equal(result.exceedsThreshold, true);
  });

  test('earth surface metrics: RGBAのfiniteと0..1範囲を個別に検査する', () => {
    assert.deepEqual(checkRgbaRange([0, 0.5, 1, 0]), {
      valid: true, finite: true, inRange: true, componentCount: 4, invalidIndex: null,
    });
    assert.equal(checkRgbaRange([0, 0.5, 1.01, 0]).valid, false);
    assert.equal(checkRgbaRange([0, Number.NaN, 1, 0]).finite, false);
    assert.equal(checkRgbaRange([0, 1, 0]).valid, false);
  });

  test('earth surface metrics: JSONキー順とケース順を正規化する', () => {
    const metrics = normalizeEarthSurfaceMetrics({
      viewport: { height: 540, width: 960 },
      cases: [
        { caseName: 'earth-terminator', sha256: 'b'.repeat(64), byteLength: 20 },
        { caseName: 'earth', sha256: 'a'.repeat(64), byteLength: 10 },
      ],
    });
    assert.deepEqual(metrics.cases.map((entry) => entry.caseName), ['earth', 'earth-terminator']);
    assert.equal(JSON.stringify(metrics), '{"schemaVersion":1,"viewport":{"width":960,"height":540},"cases":[{"caseName":"earth","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","byteLength":10},{"caseName":"earth-terminator","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","byteLength":20}]}');
  });
}
