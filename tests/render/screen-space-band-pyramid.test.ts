// 近傍拡散補正の段ごとの代表の選び方と、帯の縮小・粗い段からの拡大と合流を、テントの重み、面の数ごとの選び方、
// 実効画素数の定義、合流の混合比の極限、一様な値の恒等で検査する。
import * as assert from 'node:assert/strict';
import { bool, float, ivec2, vec2, vec3 } from 'three/tsl';
import {
  effectivePixelsOf, mergedCorrection, packedReducedBands, packedTextureCount, tentNeighbors,
  unpackedBands, weightedBands, type ParentPixel,
} from '../../src/render/pipeline/screen-space/band-pyramid';
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

// 段 k の画素 pixel を囲む段 k + 1 の 3×3 画素。面の重みは surfaceAt(画素 pixel を含む段 k + 1 の画素からのずれ)、
// C_{k+1} はどれも value、実効画素数はどれも parentPixels、均された割合はどれも parentShare。
function parentsAround(
  pixel: readonly [number, number], surfaceAt: (offset: readonly number[]) => number, value: readonly number[],
  parentPixels: number, parentShare = 1,
): ParentPixel[] {
  const containing = pixel.map((coordinate) => Math.floor(coordinate / 2));
  return tentNeighbors(vec2(pixel[0], pixel[1])).map(({ texel, weight }) => {
    const offset = componentsOf(texel).map((coordinate, axis) => coordinate - containing[axis]!);
    return {
      interpolationWeight: weight, surface: float(surfaceAt(offset)), value: vectorNode(value),
      effectivePixels: float(parentPixels), smoothedShare: float(parentShare),
      containsPixel: bool(offset.every((d) => d === 0)),
    };
  });
}

// 段 k の画素の実効画素数 n_T と、それを囲む親の実効画素数 m の組。段 0 は n_T = 1。
const PIXEL_COUNTS = [{ own: 1, parent: 4 }, { own: 4, parent: 16 }, { own: 2.5, parent: 7 }] as const;
// 合流を確かめる段 k の画素。
const MERGE_PIXELS = [[0, 0], [1, 0], [0, 1], [5, 2], [6, 9]] as const;

export function register(): void {
  test('screen space band pyramid: 3×3 テントは含む親を中心に対称で、重みの和が 1', () => {
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1], [6, 9]] as const) {
      const neighbors = tentNeighbors(vec2(x, y)).map(({ texel, weight }) => ({
        texel: componentsOf(texel), weight: evaluateShaderNode(weight) as number,
      }));
      const center = [Math.floor(x / 2), Math.floor(y / 2)];
      assert.strictEqual(neighbors.length, 9);
      near(neighbors.reduce((sum, neighbor) => sum + neighbor.weight, 0), 1, 1e-12, `(${x}, ${y}) 和`);
      for (const neighbor of neighbors) {
        const offset = neighbor.texel.map((coordinate, axis) => coordinate - center[axis]!);
        assert.ok(offset.every((delta) => delta >= -1 && delta <= 1), `(${x}, ${y}) ${neighbor.texel}`);
        const expected = (offset[0] === 0 ? 2 : 1) * (offset[1] === 0 ? 2 : 1) / 16;
        near(neighbor.weight, expected, 1e-12, `(${x}, ${y}) ${neighbor.texel}`);
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
        hasSurface: bool(hasSurface), distance: float(distance),
        surface: { texel: ivec2(index, 10 * index), depth: float(index), encodedNormal: vec2(index, -index) },
      })));
      // 選ばれた子の面が、座標・深度・法線のそろった値で返る。
      assert.deepStrictEqual(componentsOf(chosen.texel), [expected, 10 * expected], JSON.stringify(children));
      assert.deepStrictEqual([componentsOf(chosen.depth)].flat(), [expected], JSON.stringify(children));
      assert.deepStrictEqual(componentsOf(chosen.encodedNormal), [expected, -expected], JSON.stringify(children));
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

  test('screen space band pyramid: 縮小の実効画素数は、等しい重みなら子の 4 倍、重みを持つ子が 1 つならその子の値、重みが無ければ 0', () => {
    const effectivePixels = (weights: readonly number[], pixels: readonly number[]): number =>
      evaluateShaderNode(effectivePixelsOf(weights.map((weight, index) => ({
        weight: float(weight), effectivePixels: float(pixels[index]!),
      })))) as number;
    for (const pixels of [1, 4, 2.5]) {
      for (const weight of [1, 0.3]) {
        near(effectivePixels([weight, weight, weight, weight], [pixels, pixels, pixels, pixels]), 4 * pixels, 1e-12,
          `等しい重み ${weight}、子 ${pixels}`);
        near(effectivePixels([0, weight, 0, 0], [16, pixels, 16, 16]), pixels, 1e-12, `子 1 つ ${weight}、子 ${pixels}`);
      }
    }
    // 1 未満の子の実効画素数は 1 とみなす。
    near(effectivePixels([1, 1, 1, 1], [0, 0, 0, 0]), 4, 1e-12, '子 0');
    // 偏った重みでは (Σw)² / Σw² へ減る(Kish の実効標本数)。
    near(effectivePixels([1, 0.5, 0, 0], [1, 1, 1, 1]), 1.5 ** 2 / 1.25, 1e-12, '偏った重み');
    assert.strictEqual(effectivePixels([0, 0, 0, 0], [1, 1, 1, 1]), 0);
  });

  test('screen space band pyramid: 段 1 以降の帯は段 0 と同じ並びで、実効画素数を最後のテクスチャの w に、余りを 0 に持つ', () => {
    for (let count = 2; count <= 5; count++) {
      for (let level = 1; level < count; level++) {
        const label = `${count} 帯の段 ${level}`;
        const values = Array.from({ length: count - level }, (_, band) => [band + 0.25, -band - 0.5, 3 * band + 1]);
        const packed = packedReducedBands(values.map(vectorNode), float(37.5));
        // 帯の rgb と実効画素数の 1 チャンネルを持つ枚数。
        const textureCount = Math.ceil((3 * (count - level) + 1) / 4);
        assert.strictEqual(packedTextureCount(count, level), textureCount, label);
        assert.strictEqual(packed.length, textureCount, label);
        const channels = packed.flatMap((value) => evaluateShaderNode(value) as number[]);
        const spare = channels.slice(3 * values.length, -1);
        assert.strictEqual(channels.at(-1), 37.5, label);
        assert.deepStrictEqual(spare, Array(spare.length).fill(0), label);
        const unpacked = unpackedBands(packed, values.length).map((band) => evaluateShaderNode(band));
        assert.deepStrictEqual(unpacked, values, label);
      }
    }
  });

  test('screen space band pyramid: 合流は、粗い段の C が一様で T と等しければ、面の重みと実効画素数によらず D + T を返す', () => {
    const direct = [1, 2, 3];
    const remainder = [-0.5, 4, 0.25];
    for (const surfaces of [Array(9).fill(1), Array(9).fill(0), [1, 0.2, 0, 0.7, 0.3, 1, 0, 0.4, 0.8]]) {
      for (const { own, parent } of PIXEL_COUNTS) {
        const parents = parentsAround([5, 2], () => 0, remainder, parent)
          .map((parentPixel, index) => ({ ...parentPixel, surface: float(surfaces[index]!) }));
        const merged = componentsOf(
          mergedCorrection(vectorNode(direct), vectorNode(remainder), float(own), parents).correction);
        for (const [channel, value] of merged.entries()) {
          near(value, direct[channel]! + remainder[channel]!, 1e-12, `${surfaces} n_T ${own}`);
        }
      }
    }
  });

  test('screen space band pyramid: 合流の混合比は、平らなら 1、自分を含む親だけが合えば 1、対角4親だけなら 4m / (4m + n_T)、どれも合わなければ 0', () => {
    // D = T = 0 で親の C をどれも 1 にすると、C_k の各成分が混合比 α になる。
    const ratioOf = (pixel: readonly [number, number], surfaceAt: (offset: readonly number[]) => number,
      own: number, parent: number): number => {
      const parents = parentsAround(pixel, surfaceAt, [1, 1, 1], parent);
      return componentsOf(
        mergedCorrection(vectorNode([0, 0, 0]), vectorNode([0, 0, 0]), float(own), parents).correction)[0]!;
    };
    for (const pixel of MERGE_PIXELS) {
      for (const { own, parent } of PIXEL_COUNTS) {
        const label = `(${pixel}) n_T ${own} m ${parent}`;
        near(ratioOf(pixel, () => 1, own, parent), 1, 1e-12, `${label} 平ら`);
        near(ratioOf(pixel, (offset) => (offset.every((d) => d === 0) ? 1 : 0), own, parent), 1, 1e-12,
          `${label} 自分を含む親`);
        near(ratioOf(pixel, (offset) => (offset.every((d) => d !== 0) ? 1 : 0), own, parent),
          4 * parent / (4 * parent + own),
          1e-12, `${label} 斜向かい`);
        near(ratioOf(pixel, () => 0, own, parent), 0, 1e-12, `${label} 合わない`);
      }
    }
  });

  test('screen space band pyramid: 合流の出力の均された割合は、混合比 × 親の均された割合', () => {
    const parentShare = 0.375;
    for (const pixel of MERGE_PIXELS) {
      for (const surfaces of [() => 1, (offset: readonly number[]) => (offset.every((d) => d !== 0) ? 1 : 0), () => 0]) {
        for (const { own, parent } of PIXEL_COUNTS) {
          // D = T = 0 で親の C をどれも 1 にすると、C_k の各成分が混合比 α になる。
          const { correction, smoothedShare } = mergedCorrection(vectorNode([0, 0, 0]), vectorNode([0, 0, 0]),
            float(own), parentsAround(pixel, surfaces, [1, 1, 1], parent, parentShare));
          near(evaluateShaderNode(smoothedShare) as number, componentsOf(correction)[0]! * parentShare, 1e-12,
            `(${pixel}) n_T ${own} m ${parent}`);
        }
      }
    }
  });

}
