// 近傍拡散補正のフレームごとのジッターの列と、走査の代表の写像を、本番の静止画との一致・ブロックの中に収まること・
// 一巡で全ての位置を巡ることの不変条件で検査する。
import * as assert from 'node:assert/strict';
import { ivec2, vec2 } from 'three/tsl';
import {
  frameJitterAt, frameJitterForHistoryCap, type JitterSource,
} from '../../src/render/pipeline/screen-space/frame-jitter';
import { REPRESENTATIVE_STEPS, gbufferTexelOf } from '../../src/render/pipeline/screen-space/hemisphere-scan';
import { test } from '../harness';
import { evaluateShaderNode } from './tsl-node-evaluator';

const BOTH: readonly JitterSource[] = ['seed', 'scanRepresentative'];
// 走査の画素の幅 [描画バッファの画素] の候補。
const CELL_SIZES = [1, 2, 4, 8];

// 画素 pixel の、ブロックの中の位置 representative(ブロックの幅に対する割合)の代表の G バッファの画素。gbufferSize と
// pixelSize は描画バッファと走査の解像度 [px]。評価器の割り算は実数なので、GPU の整数の割り算に合わせて切り捨てる。
function texelOf(
  pixel: readonly [number, number], representative: readonly [number, number],
  gbufferSize: readonly [number, number], pixelSize: readonly [number, number],
): readonly [number, number] {
  const steps = representative.map((fraction) => Math.round(fraction * REPRESENTATIVE_STEPS)) as [number, number];
  const [x, y] = evaluateShaderNode(gbufferTexelOf(
    vec2(...pixel), ivec2(...steps), vec2(...gbufferSize), vec2(...pixelSize))) as number[];
  return [Math.floor(x!), Math.floor(y!)];
}

export function register(): void {
  test('frame jitter: 履歴の上限 1 は静止画の位相、上限が大きいと指定源、null は変更なし', () => {
    for (const frame of [0, 1, 7]) {
      assert.deepEqual(frameJitterForHistoryCap(frame, BOTH, 1, 4), frameJitterAt(frame, [], 4));
      assert.deepEqual(frameJitterForHistoryCap(frame, BOTH, 8, 4), frameJitterAt(frame, BOTH, 4));
      assert.equal(frameJitterForHistoryCap(frame, null, 8, 4), null);
    }
    assert.throws(() => frameJitterForHistoryCap(0, BOTH, 0, 4), RangeError);
  });

  test('frame jitter: フレーム 0 は、どの入力を動かしても本番の静止画(seed (0, 0)・代表はブロックの中心)に一致する', () => {
    for (const cellSize of CELL_SIZES) {
      const jitter = frameJitterAt(0, BOTH, cellSize);
      assert.deepEqual(jitter.seed, [0, 0]);
      assert.deepEqual(jitter.scanJitter, { kind: 'grid', fraction: [0.5, 0.5] });
    }
  });

  test('frame jitter: 動かさない入力は、どのフレームでも本番の静止画の値のまま', () => {
    for (const frame of [1, 7, 100]) {
      assert.deepEqual(frameJitterAt(frame, ['scanRepresentative'], 4).seed, [0, 0]);
      assert.equal(frameJitterAt(frame, ['seed'], 4).scanJitter, null);
      assert.deepEqual(frameJitterAt(frame, [], 4), { seed: [0, 0], scanJitter: null });
    }
  });

  test('frame jitter: seed は 0 以上 1 未満で、隣り合うフレームで変わる', () => {
    let previous = frameJitterAt(0, ['seed'], 4).seed;
    for (let frame = 1; frame < 256; frame++) {
      const { seed } = frameJitterAt(frame, ['seed'], 4);
      for (const component of seed) assert.ok(component >= 0 && component < 1, `seed ${seed} at frame ${frame}`);
      assert.notDeepEqual(seed, previous);
      previous = seed;
    }
  });

  test('frame jitter: 走査の代表は、走査の画素の幅の 2 乗のフレームで、ブロックの全ての画素を 1 度ずつ巡る', () => {
    for (const cellSize of CELL_SIZES) {
      const visited = new Set<string>();
      for (let frame = 0; frame < cellSize * cellSize; frame++) {
        const { scanJitter } = frameJitterAt(frame, BOTH, cellSize);
        assert.ok(scanJitter?.kind === 'grid');
        const [x, y] = texelOf([3, 5], scanJitter.fraction, [8 * cellSize, 8 * cellSize], [8, 8]);
        assert.ok(x >= 3 * cellSize && x < 4 * cellSize && y >= 5 * cellSize && y < 6 * cellSize, `(${x}, ${y})`);
        visited.add(`${x},${y}`);
      }
      assert.equal(visited.size, cellSize * cellSize);
      // 次の巡りは最初と同じ順。
      assert.deepEqual(frameJitterAt(cellSize * cellSize, BOTH, cellSize).scanJitter, frameJitterAt(0, BOTH, cellSize).scanJitter);
    }
  });

  test('frame jitter: 走査の画素の幅が 2 の冪でないか、フレームが負なら投げる', () => {
    assert.throws(() => frameJitterAt(0, BOTH, 3), RangeError);
    assert.throws(() => frameJitterAt(-1, BOTH, 4), RangeError);
    assert.throws(() => frameJitterAt(1.5, BOTH, 4), RangeError);
  });

  test('scan representative: ブロックの中心の代表は、解像度 1/4 で走査の画素 p の G バッファの画素 4p + 2', () => {
    for (const [px, py] of [[0, 0], [7, 3], [239, 134]] as const) {
      assert.deepEqual(texelOf([px, py], [0.5, 0.5], [960, 540], [240, 135]), [4 * px + 2, 4 * py + 2]);
    }
  });

  test('scan representative: ブロックの中の位置を 0 以上 1 未満で動かしても、代表は走査の画素が受け持つブロックに収まる', () => {
    const sizes = [[[960, 540], [240, 135]], [[959, 539], [240, 135]], [[960, 540], [480, 270]], [[960, 540], [960, 540]]] as const;
    for (const [gbufferSize, pixelSize] of sizes) {
      for (const pixel of [[0, 0], [1, 2], [101, 77], [pixelSize[0] - 1, pixelSize[1] - 1]] as const) {
        for (const fraction of [0, 0.125, 0.5, 0.875, 15 / 16]) {
          const [x, y] = texelOf(pixel, [fraction, fraction], gbufferSize, pixelSize);
          const ratio = [gbufferSize[0] / pixelSize[0], gbufferSize[1] / pixelSize[1]];
          assert.ok(x >= Math.floor(pixel[0] * ratio[0]!) && x < (pixel[0] + 1) * ratio[0]!, `x ${x} of ${pixel} at ${fraction}`);
          assert.ok(y >= Math.floor(pixel[1] * ratio[1]!) && y < (pixel[1] + 1) * ratio[1]!, `y ${y} of ${pixel} at ${fraction}`);
          assert.ok(x < gbufferSize[0] && y < gbufferSize[1]);
        }
      }
    }
  });
}
