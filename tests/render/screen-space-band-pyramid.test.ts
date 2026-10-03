// 近傍拡散補正の段ごとの代表の選び方と、帯の縮小・粗い段からの拡大と合流の重みを、双線形の重みの和と象限、面の数ごとの
// 選び方、一様な値の恒等で検査する。
import * as assert from 'node:assert/strict';
import { bool, float, vec2, vec3 } from 'three/tsl';
import { coarseNeighbors, mergedCorrection, weightedBands } from '../../src/render/pipeline/screen-space/band-pyramid';
import { secondNearest } from '../../src/render/pipeline/screen-space/screen-space-input-pyramid';
import { test } from '../harness';
import { evaluateShaderNode } from './tsl-node-evaluator';
import type { Vec3Node } from '../../src/render/tsl-types';

// 差が tolerance 以内であることを検査する。
function near(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`);
}

// ベクトルのノードの成分。
function componentsOf(node: unknown): number[] {
  return evaluateShaderNode(node) as number[];
}

// 成分 [x, y, z] の vec3 定数ノード。
function vectorNode([x, y, z]: readonly number[]): Vec3Node {
  return vec3(x!, y!, z!);
}

export function register(): void {
  test('screen space band pyramid: 粗い段の 4 画素の双線形の重みは和が 1 で、画素を含む粗い画素が 9/16、斜向かいが 1/16', () => {
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1], [6, 9]] as const) {
      const label = `(${x}, ${y})`;
      const neighbors = coarseNeighbors(vec2(x, y)).map(({ texel, weight }) => ({
        texel: componentsOf(texel), weight: evaluateShaderNode(weight) as number,
      }));
      near(neighbors.reduce((sum, { weight }) => sum + weight, 0), 1, 1e-12, `${label} 和`);
      // 隣は、画素が粗い画素の中で寄っている側にある。
      const containing = [Math.floor(x / 2), Math.floor(y / 2)];
      const side = [x % 2 === 0 ? -1 : 1, y % 2 === 0 ? -1 : 1];
      for (const { texel, weight } of neighbors) {
        const offset = texel.map((coordinate, axis) => coordinate - containing[axis]!);
        assert.ok(offset.every((d, axis) => d === 0 || d === side[axis]), `${label} ${texel}`);
        const expected = (offset[0] === 0 ? 3 / 4 : 1 / 4) * (offset[1] === 0 ? 3 / 4 : 1 / 4);
        near(weight, expected, 1e-12, `${label} ${texel}`);
      }
    }
  });

  test('screen space band pyramid: 代表は面のある子のうち視点から 2 番目に近いもの、面が 1 つならそれ、無ければ子 0', () => {
    // 子ごとの [面があるか, 視点からの深さ] と、選ばれるべき子。子 i の G バッファの画素は (i, 10i) とする。
    const cases: readonly { children: readonly (readonly [boolean, number])[]; expected: number }[] = [
      { children: [[true, 5], [true, 2], [true, 9], [true, 3]], expected: 3 },
      { children: [[true, 1], [true, 2], [true, 5], [true, 6]], expected: 1 },
      { children: [[true, 5], [true, 6], [true, 1], [true, 2]], expected: 3 },
      { children: [[true, 8], [true, 1], [true, 3], [true, 2]], expected: 3 },
      { children: [[true, 4], [false, 1], [true, 7], [false, 0.5]], expected: 2 },
      { children: [[false, 1], [false, 2], [true, 6], [false, 3]], expected: 2 },
      { children: [[false, 1], [false, 2], [false, 3], [false, 4]], expected: 0 },
    ];
    for (const { children, expected } of cases) {
      const chosen = secondNearest(children.map(([hasSurface, distance], index) => ({
        hasSurface: bool(hasSurface), distance: float(distance), texel: vec2(index, 10 * index),
      })));
      assert.deepStrictEqual(componentsOf(chosen), [expected, 10 * expected], JSON.stringify(children));
    }
  });

  test('screen space band pyramid: 縮小は子の重みで正規化した平均で、一様な帯は重みによらず戻り、重みが無ければ 0', () => {
    const bands = [[0.5, -1, 2], [3, 0, -0.25]];
    for (const weights of [[1, 1, 1, 1], [1, 0.3, 0, 2], [0, 0, 1e-3, 0]]) {
      const reduced = weightedBands(weights.map((weight) => ({
        weight: float(weight), bands: bands.map(vectorNode),
      }))).map(componentsOf);
      for (const [band, values] of reduced.entries()) {
        for (const [channel, value] of values.entries()) near(value, bands[band]![channel]!, 1e-12, `${weights}`);
      }
    }
    // 重みに比例して混ざる。
    const mixed = weightedBands([
      { weight: float(1), bands: [vectorNode([4, 0, -4])] }, { weight: float(3), bands: [vectorNode([0, 8, 4])] },
    ]).map(componentsOf);
    assert.deepStrictEqual(mixed, [[1, 6, 2]]);
    const empty = weightedBands([0, 0, 0, 0].map((weight) => ({
      weight: float(weight), bands: bands.map(vectorNode),
    }))).map(componentsOf);
    assert.deepStrictEqual(empty, [[0, 0, 0], [0, 0, 0]]);
  });

  test('screen space band pyramid: 合流は、粗い段の C が一様なら面の重みによらず D + T を返す', () => {
    const direct = [1, 2, 3];
    const remainder = [-0.5, 4, 0.25];
    for (const surfaceWeights of [[1, 1, 1, 1], [0, 0, 0, 0], [1, 0.2, 0, 0.7]]) {
      const coarse = coarseNeighbors(vec2(5, 2)).map(({ weight }, index) => ({
        weight: weight.mul(surfaceWeights[index]!), value: vectorNode(remainder),
      }));
      const merged = componentsOf(mergedCorrection(vectorNode(direct), vectorNode(remainder), coarse));
      for (const [channel, value] of merged.entries()) {
        near(value, direct[channel]! + remainder[channel]!, 1e-12, `${surfaceWeights}`);
      }
    }
  });
}
