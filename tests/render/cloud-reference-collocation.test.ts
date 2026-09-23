// スカラー照合を矩形の厳密な交差面積と比較する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  collocateAbiScalarToFootprint,
  type AbiCollocationPoint,
  type AbiScalarSourcePixel,
} from '../../tools/cloud-reference/abi-collocation';

const target = rectangle(0, 0, 2, 1);

function rectangle(left: number, bottom: number, right: number, top: number): readonly AbiCollocationPoint[] {
  return [
    { x: left, y: bottom }, { x: right, y: bottom },
    { x: right, y: top }, { x: left, y: top },
  ];
}

function source(
  footprint: readonly AbiCollocationPoint[],
  value: number | null,
  validMask = true,
): AbiScalarSourcePixel {
  return { footprint, value, validMask };
}

/** 独立した合成幾何で被覆率と面積加重を固定する。 */
export function register(): void {
  test('ABI collocation: partial overlap reports exact area and masks insufficient output', () => {
    const result = collocateAbiScalarToFootprint([source(rectangle(0, 0, 1, 1), 8)], target, 0.6);
    assert.equal(result.validOverlapArea, 1);
    assert.equal(result.targetArea, 2);
    assert.equal(result.validCoverageFraction, 0.5);
    assert.equal(result.sufficientCoverage, false);
    assert.equal(result.value, null);
  });

  test('ABI collocation: valid mask and missing values remove their overlap from coverage', () => {
    const result = collocateAbiScalarToFootprint([
      source(rectangle(0, 0, 1, 1), 10, false),
      source(rectangle(1, 0, 2, 1), null),
    ], target, 0);
    assert.equal(result.validOverlapArea, 0);
    assert.equal(result.validCoverageFraction, 0);
    assert.equal(result.value, null);
  });

  test('ABI collocation: different source areas use overlap area weights', () => {
    const result = collocateAbiScalarToFootprint([
      source(rectangle(0, 0, 1, 1), 2),
      source(rectangle(1, 0, 2, 1), 8),
    ], target, 1);
    assert.equal(result.value, 5);
    assert.equal(result.validCoverageFraction, 1);
  });

  test('ABI collocation: reversed polygon orientation yields the same exact overlap', () => {
    const reversed = [...rectangle(0, 0, 1, 1)].reverse();
    const result = collocateAbiScalarToFootprint([source(reversed, 6)], target, 0.5);
    assert.equal(result.validOverlapArea, 1);
    assert.equal(result.value, 6);
    assert.equal(result.validCoverageFraction, 0.5);
  });

  test('ABI collocation: full coverage conserves the area integral across subdivisions', () => {
    const pieces = [
      source(rectangle(0, 0, 1, 1), 3),
      source(rectangle(1, 0, 2, 1), 9),
    ];
    const result = collocateAbiScalarToFootprint(pieces, target, 1);
    const sourceIntegral = pieces.reduce((sum, pixel) => {
      const vertices = pixel.footprint;
      const area = (vertices[1]!.x - vertices[0]!.x) * (vertices[2]!.y - vertices[1]!.y);
      return sum + area * pixel.value!;
    }, 0);
    assert.equal(result.validCoverageFraction, 1);
    assert.equal(result.value! * result.targetArea, sourceIntegral);
  });

  test('ABI collocation: overlapping sources are rejected even when their total area is below target area', () => {
    assert.throws(() => collocateAbiScalarToFootprint([
      source(rectangle(0, 0, 0.6, 1), 3),
      source(rectangle(0.4, 0, 1, 1), 9),
    ], target, 0));
  });

  test('ABI collocation: area remains stable for polygons far from the local origin', () => {
    const offset = 1e12;
    const farTarget = rectangle(offset, offset, offset + 2, offset + 1);
    const result = collocateAbiScalarToFootprint([
      source(rectangle(offset, offset, offset + 2, offset + 1), 7),
    ], farTarget, 1);
    assert.equal(result.targetArea, 2);
    assert.equal(result.validCoverageFraction, 1);
    assert.equal(result.value, 7);
  });

  test('ABI collocation: rejects degenerate, concave, overlapping and malformed inputs', () => {
    assert.throws(() => collocateAbiScalarToFootprint([], rectangle(0, 0, 0, 1), 0));
    assert.throws(() => collocateAbiScalarToFootprint([
      source([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0.5 }, { x: 2, y: 1 }, { x: 0, y: 1 }], 1),
    ], target, 0));
    assert.throws(() => collocateAbiScalarToFootprint([
      source(rectangle(0, 0, 1.5, 1), 1), source(rectangle(0.5, 0, 2, 1), 2),
    ], target, 0));
    assert.throws(() => collocateAbiScalarToFootprint([], target, 1.1));
    assert.throws(() => collocateAbiScalarToFootprint([source(rectangle(0, 0, 1, 1), Number.NaN)], target, 0));
  });
}
