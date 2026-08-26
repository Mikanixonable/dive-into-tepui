// レンズ効果が画面の絵へ当てる核。**どれも係数の総和が 1 で、正規化でそれを保証する** —
// 直書きの係数だと、あとで刻みを変えたときに総和が静かに 1 からずれ、レンズ段が光を増やす
// (あるいは減らす)ようになってしまう。総和が 1 でありさえすれば、レンズ段は光を配り直す
// だけの線形写像に留まる(その拡張性の話は lens-pass.ts の冒頭)。
//
// **半精度浮動小数点の上限(65504)を跨がないのも、総和が 1 であることに掛かっている** —
// 出力が入力の最大値(太陽面の 4.62e4)を超えないので、Inf も NaN も構造的に起きない。
import * as THREE from 'three/webgpu';
import { screenUV, texture, vec2, vec3 } from 'three/tsl';
import type { Vec2Uniform, Vec3Node } from '../tsl-types';

// 条の軸の数。1 本の軸が両側へ伸びるので、条は 6 本になる。
const STREAK_AXES = 3;
// 片側のタップ数 [読み元のテクセル]。**間隔は 1 テクセル固定** — 間隔を空けると、タップの
// 1 つ 1 つが光源の複製として点々に見えてしまい、条にならない。
const STREAK_TAPS = 28;
// 条の減衰長 [読み元のテクセル]。
const STREAK_FALLOFF = 10;

// 絞りの反射像 [倍率, 重み, 色み]。**倍率が負なので像は画面中心を挟んだ反対側へ出る。**
// **絶対値は 1 未満に留める** — 1 を超えると読む位置が画面の外へ出て、縁の画素が引き伸ばされる。
// 重みの和は 1 で、色みは加重平均が白になるよう正規化してから使う(そうしないとゴーストが
// 光量を色ごとに増減させてしまう)。
const GHOSTS: readonly (readonly [number, number, readonly [number, number, number]])[] = [
  [-0.30, 0.40, [1.00, 0.78, 0.55]],
  [-0.55, 0.35, [0.60, 0.90, 1.00]],
  [-0.80, 0.25, [0.85, 1.00, 0.80]],
];

// ノードの和。**平衡木で畳む** — 左畳みにすると括弧が項数ぶん深く入れ子になり、WGSL の
// パーサが再帰の上限に当たってシェーダの生成ごと落ちる(例外ではなく検証エラーとして出る)。
function sumOf(terms: readonly Vec3Node[]): Vec3Node {
  let level = terms;
  while (level.length > 1) {
    const merged: Vec3Node[] = [];
    for (let i = 0; i < level.length; i += 2) {
      merged.push(i + 1 < level.length ? level[i]!.add(level[i + 1]!) : level[i]!);
    }
    level = merged;
  }
  return level[0]!;
}

// source の (x, y) テクセルぶんずれた点を読む。
function tapAt(source: THREE.Texture, texel: Vec2Uniform, x: number, y: number): Vec3Node {
  return texture(source, screenUV.add(vec2(x, y).mul(texel))).rgb;
}

// 縮小。書き込み先が読み元のちょうど半分の解像度なので、半テクセルずらした双一次の 4 点が
// そのまま 4x4 の箱平均になる。
export function boxDownsample(source: THREE.Texture, texel: Vec2Uniform): Vec3Node {
  const tap = (x: number, y: number): Vec3Node => tapAt(source, texel, x, y);
  return sumOf([tap(-0.5, -0.5), tap(0.5, -0.5), tap(-0.5, 0.5), tap(0.5, 0.5)]).mul(0.25);
}

// 拡大((1,2,1 / 2,4,2 / 1,2,1) / 16 のテント)。
export function tentUpsample(source: THREE.Texture, texel: Vec2Uniform): Vec3Node {
  const tap = (x: number, y: number): Vec3Node => tapAt(source, texel, x, y);
  const corners = sumOf([tap(-1, -1), tap(1, -1), tap(-1, 1), tap(1, 1)]);
  const edges = sumOf([tap(0, -1), tap(-1, 0), tap(1, 0), tap(0, 1)]);
  return sumOf([corners, edges.mul(2), tap(0, 0).mul(4)]).mul(1 / 16);
}

// 放射状の条。画面に固定した向きへ、指数減衰のタップを両側へ積む。**向きは光源ではなく画面が
// 決める** — カメラを回しても条は光源に貼り付いて回らない。条の長さと太さは読み元の解像度が
// 決めるので、どの段から引くかは呼び出し側が選ぶ。
export function radialStreak(source: THREE.Texture, texel: Vec2Uniform): Vec3Node {
  const taps: Vec3Node[] = [];
  let total = 0;
  for (let axis = 0; axis < STREAK_AXES; axis++) {
    const angle = (Math.PI * axis) / STREAK_AXES;
    for (let step = 0; step < STREAK_TAPS; step++) {
      const distance = step + 1;
      const weight = Math.exp(-distance / STREAK_FALLOFF);
      for (const side of [1, -1]) {
        const x = side * Math.cos(angle) * distance;
        const y = side * Math.sin(angle) * distance;
        taps.push(tapAt(source, texel, x, y).mul(weight));
        total += weight;
      }
    }
  }
  return sumOf(taps).mul(1 / total);
}

// 絞りの反射像。画面中心を軸に像を縮めて反対側へ置き直したものを、色みを変えて数枚重ねる。
// **縮めた像は同じ光が狭い面積へ集まる**ので、倍率の 2 乗を掛けて光量を戻す。ずらし幅は画面に
// 対する割合なので、読み元のテクセル寸法は要らない。
export function apertureGhosts(source: THREE.Texture): Vec3Node {
  const center = vec2(0.5, 0.5);
  const meanTint = [0, 1, 2].map(
    (channel) => GHOSTS.reduce((sum, [, weight, tint]) => sum + weight * tint[channel]!, 0),
  );
  return sumOf(GHOSTS.map(([scale, weight, tint]) => {
    const gain = weight * scale * scale;
    const balanced = vec3(
      (tint[0] / meanTint[0]!) * gain, (tint[1] / meanTint[1]!) * gain, (tint[2] / meanTint[2]!) * gain,
    );
    return texture(source, center.add(screenUV.sub(center).mul(scale))).rgb.mul(balanced);
  }));
}
