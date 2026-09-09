import * as assert from 'node:assert/strict';
import { maxMipLevelOf } from '../../src/render/cloud/baked-field';
import { test } from '../harness';

interface LodCase {
  readonly footprint: number;
  readonly expectedExplicitLod: number;
}

// 本番の CloudFieldSampler.lodForWidth() と同じ入力条件を、GPUを使わずに再生するfixture。
// fieldWidth=8、radius=1では texelWidth=π/4 < 1 なので、契約上の下限式は width/1 になる。
const FIELD_WIDTH = 8;
const RADIUS = 1;
const MAX_LOD = maxMipLevelOf(FIELD_WIDTH, 4);
const FIXED_LOD = 1;
const MIP_VALUES = [0, 1, 2, 3] as const;
const CASES: readonly LodCase[] = [
  { footprint: 0.5, expectedExplicitLod: 0 },
  { footprint: 1, expectedExplicitLod: 0 },
  { footprint: 2, expectedExplicitLod: 1 },
  { footprint: 4, expectedExplicitLod: 2 },
  { footprint: 8, expectedExplicitLod: 3 },
  // max LODを越える入力。実装契約では最後の実在レベルへクランプする。
  { footprint: 32, expectedExplicitLod: 3 },
];

function explicitLod(footprint: number): number {
  const texelWidth = (RADIUS * 2 * Math.PI) / FIELD_WIDTH;
  return Math.min(MAX_LOD, Math.max(0, Math.log2(footprint / Math.max(texelWidth, 1))));
}

function sampleMip(values: readonly number[], lod: number): number {
  const lower = Math.floor(lod);
  const upper = Math.min(lower + 1, values.length - 1);
  const fraction = lod - lower;
  return values[lower]! * (1 - fraction) + values[upper]! * fraction;
}

function meanAbsoluteDifference(left: readonly number[], right: readonly number[]): number {
  assert.equal(left.length, right.length);
  return left.reduce((sum, value, index) => sum + Math.abs(value - right[index]!), 0) / left.length;
}

export function register(): void {
  test('cloud lod comparison: fixedとwidth-basedを同一fixtureで再現する', () => {
    const explicitLods = CASES.map(({ footprint }) => explicitLod(footprint));
    const fixedOutput = CASES.map(() => sampleMip(MIP_VALUES, FIXED_LOD));
    const explicitOutput = explicitLods.map((lod) => sampleMip(MIP_VALUES, lod));

    assert.deepEqual(explicitLods, CASES.map(({ expectedExplicitLod }) => expectedExplicitLod));
    assert.deepEqual(fixedOutput, [1, 1, 1, 1, 1, 1]);
    assert.deepEqual(explicitOutput, [0, 0, 1, 2, 3, 3]);
    assert.equal(meanAbsoluteDifference(fixedOutput, explicitOutput), 7 / 6);
  });

  test('cloud lod comparison: max LODはテクスチャ寸法から求め入力をクランプする', () => {
    assert.equal(maxMipLevelOf(1, 1), 0);
    assert.equal(maxMipLevelOf(FIELD_WIDTH, 4), 3);
    assert.equal(maxMipLevelOf(1024, 512), 10);
    assert.equal(explicitLod(Number.POSITIVE_INFINITY), MAX_LOD);
    assert.equal(explicitLod(0), 0);
  });
}
