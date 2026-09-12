// 正八角形絞りのPSF近似が、光量を保った連続な回折ローブを作ることを固定する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  APERTURE_PSF_DIRECTIONS,
  APERTURE_PSF_PASSES,
  aperturePsfRelativeIntensity,
} from '../../src/render/pipeline/aperture-psf';

const EPSILON = 1e-12;

export function register(): void {
  test('aperture psf: 正八角形の辺法線から8本の腕を作る', () => {
    assert.equal(APERTURE_PSF_DIRECTIONS.length, 8);
    for (let i = 0; i < APERTURE_PSF_DIRECTIONS.length / 2; i++) {
      const [x, y] = APERTURE_PSF_DIRECTIONS[i]!;
      const [oppositeX, oppositeY] = APERTURE_PSF_DIRECTIONS[i + 4]!;
      assert.ok(Math.abs(x + oppositeX) < EPSILON);
      assert.ok(Math.abs(y + oppositeY) < EPSILON);
    }
  });

  test('aperture psf: 各段の係数和が1で全係数が正', () => {
    assert.equal(APERTURE_PSF_PASSES.length, 2);
    for (const taps of APERTURE_PSF_PASSES) {
      assert.ok(taps.every((tap) => tap.weight > 0));
      const sum = taps.reduce((total, tap) => total + tap.weight, 0);
      assert.ok(Math.abs(sum - 1) < EPSILON, `係数和 ${sum}`);
    }
  });

  test('aperture psf: 多段合成後も支持端まで同じ比率で滑らかに減衰する', () => {
    const [fine, coarse] = APERTURE_PSF_PASSES;
    assert.ok(fine !== undefined && coarse !== undefined);
    const combined: number[] = [];
    for (const coarseTap of coarse) {
      for (const fineTap of fine) combined.push(coarseTap.weight * fineTap.weight);
    }
    for (let distance = 1; distance < combined.length; distance++) {
      const actualRatio = combined[distance]! / combined[distance - 1]!;
      const expectedRatio = aperturePsfRelativeIntensity(distance)
        / aperturePsfRelativeIntensity(distance - 1);
      assert.ok(Math.abs(actualRatio - expectedRatio) < EPSILON, `${distance} texelで比率 ${actualRatio}`);
    }
    const edge = aperturePsfRelativeIntensity(combined.length - 1);
    assert.ok(edge <= 1 / 4096 + EPSILON, `支持端の相対強度 ${edge}`);
  });
}
