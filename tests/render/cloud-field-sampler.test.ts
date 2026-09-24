import * as assert from 'node:assert/strict';
import { cloudDetailTileWeight } from '../../src/render/cloud/cloud-field-sampler';
import { test } from '../harness';

export function register(): void {
  test('cloud detail tile: angular blend is zero outside, smooth at the seam, and full inside', () => {
    const outerCos = Math.cos(0.08);
    const fullDetailCos = Math.cos(0.05);
    const blendMidpoint = (outerCos + fullDetailCos) / 2;

    assert.equal(cloudDetailTileWeight(outerCos - 0.01, outerCos, fullDetailCos), 0);
    assert.equal(cloudDetailTileWeight(outerCos, outerCos, fullDetailCos), 0);
    assert.ok(Math.abs(cloudDetailTileWeight(blendMidpoint, outerCos, fullDetailCos) - 0.5) < 1e-12);
    assert.equal(cloudDetailTileWeight(fullDetailCos, outerCos, fullDetailCos), 1);
    assert.equal(cloudDetailTileWeight(fullDetailCos + 0.001, outerCos, fullDetailCos), 1);
  });

  test('cloud detail tile: blend boundaries must describe a non-empty angular band', () => {
    assert.throws(() => cloudDetailTileWeight(0, 0.5, 0.5), RangeError);
    assert.throws(() => cloudDetailTileWeight(0, -1.1, 0), RangeError);
    assert.throws(() => cloudDetailTileWeight(0, 0, 1.1), RangeError);
    assert.throws(() => cloudDetailTileWeight(1.1, -0.5, 0.5), RangeError);
  });
}
