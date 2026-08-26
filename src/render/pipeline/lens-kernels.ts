// レンズ効果が画面の絵へ当てる核。**どれも係数の総和が 1 で、正規化でそれを保証する** —
// 直書きの係数だと、あとで刻みを変えたときに総和が静かに 1 からずれ、レンズ段が光を増やす
// (あるいは減らす)ようになってしまう。総和が 1 でありさえすれば、レンズ段は光を配り直す
// だけの線形写像に留まる(その拡張性の話は lens-pass.ts の冒頭)。
//
// **半精度浮動小数点の上限(65504)を跨がないのも、総和が 1 であることに掛かっている** —
// 出力が入力の最大値(太陽面の 4.62e4)を超えないので、Inf も NaN も構造的に起きない。
import * as THREE from 'three/webgpu';
import { and, greaterThan, lessThan, screenUV, select, texture, vec2, vec3 } from 'three/tsl';
import type { Vec2Node, Vec2Uniform, Vec3Node } from '../tsl-types';

// 条の 1 パスあたりのタップ数。**パスをまたぐ刻みをこの数と同じにする。**
const STREAK_TAPS = 12;
// 条の減衰長 [読み元のテクセル]。
const STREAK_FALLOFF = 50;

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

// **画面の外は黒として読む。** WebGPU にはボーダー色が無いので、クランプで縁の画素が引き伸ばされる
// のはシェーダ側で打ち消すしかない。**明るさではなく位置だけで決まる重み**なので、入力に対する
// 線形性は崩れない(この段が閾値を持たないという規則には触れない)。
//
// **画面の端では核の総和が 1 を下回るが、それでよい** — 画面の外へ出た光は戻ってこない。
// 正規化し直すと端だけが明るくなる。総和が 1 を**超えない**ことは保たれるので、半精度の上限の
// 担保も崩れない。
function sampleInside(source: THREE.Texture, uv: Vec2Node): Vec3Node {
  const inside = and(
    and(greaterThan(uv.x, 0), lessThan(uv.x, 1)),
    and(greaterThan(uv.y, 0), lessThan(uv.y, 1)),
  );
  return select(inside, texture(source, uv).rgb, vec3(0));
}

// 光を広げる側のタップ。(x, y) は読み元のテクセル数で測る。
function spreadAt(source: THREE.Texture, texel: Vec2Uniform, x: number, y: number): Vec3Node {
  return sampleInside(source, screenUV.add(vec2(x, y).mul(texel)));
}

// **縮小のタップはマスクを通さない。** 縮小がしているのは「画面の中を平均する」再サンプリング
// であって、画面の外の光を作っているのではない。ゼロ埋めすると各段の縁のテクセルが本来より
// 暗くなり、画面の縁に暗いふちが出る。
function resampleAt(source: THREE.Texture, texel: Vec2Uniform, x: number, y: number): Vec3Node {
  return texture(source, screenUV.add(vec2(x, y).mul(texel))).rgb;
}

// 縮小。**2x2 の平均だと核が角ばる。** 箱は可分なので等高線が四角く、それが 5 段ぶん積み上がって
// ハローの角として残る。13 タップ(2x2 の群を、中央に 1 つと四隅に 4 つ)へ広げると 1 段あたりの
// 核が丸みを帯び、ハローが滑らかで広くなる。
//
// 中央の群が 1/2、四隅の群が 1/8 ずつで**総和 1**。タップ位置が中心について対称なので、核の
// 重心は動かない。**明るさで分岐する外れ値除去(Karis average)は入れない** — 非線形なので、
// この段が閾値を持たないという規則に触れる。
//
// **サブピクセル移動に対するちらつきは、これでは減らない(実測)。** この場面のちらつきは
// 太陽自身のラスタライズ — 1px を切った円盤の被覆率が量子化されること — が支配していて、
// 縮小より上流にある。
export function downsample(source: THREE.Texture, texel: Vec2Uniform): Vec3Node {
  const tap = (x: number, y: number): Vec3Node => resampleAt(source, texel, x, y);
  // 中央の 2x2(読み元の 1 テクセル刻み)と、それを囲む 3x3 の格子(2 テクセル刻み)。
  const inner = sumOf([tap(-1, -1), tap(1, -1), tap(-1, 1), tap(1, 1)]);
  const corner = (x: number, y: number): Vec3Node =>
    sumOf([tap(x, y), tap(0, y), tap(x, 0), tap(0, 0)]);
  const outer = sumOf([corner(-2, -2), corner(2, -2), corner(-2, 2), corner(2, 2)]);
  return sumOf([inner.mul(0.125), outer.mul(0.03125)]);
}

// 拡大((1,2,1 / 2,4,2 / 1,2,1) / 16 のテント)。
export function tentUpsample(source: THREE.Texture, texel: Vec2Uniform): Vec3Node {
  const tap = (x: number, y: number): Vec3Node => spreadAt(source, texel, x, y);
  const corners = sumOf([tap(-1, -1), tap(1, -1), tap(-1, 1), tap(1, 1)]);
  const edges = sumOf([tap(0, -1), tap(-1, 0), tap(1, 0), tap(0, 1)]);
  return sumOf([corners, edges.mul(2), tap(0, 0).mul(4)]).mul(1 / 16);
}

// 条の 1 パス。angle の向きへ、パス番号で決まる刻みのタップを**片側だけ**積む。**向きは光源
// ではなく画面が決める** — カメラを回しても条は光源に貼り付いて回らない。
//
// **1 つのパスの中では刻みを空けない。** 空けるとタップ 1 つ 1 つが光源の複製として点々に見え、
// 条にならない。代わりに**パスをまたいで刻みをタップ数倍する** — 前のパスの出力が既にタップ数
// ぶんの幅を持っているので、次のパスが同じ数だけ刻みを空けても間がちょうど埋まる。
// **これで条の長さと太さの結合が切れる**: 長さはパス数に対して指数で伸び、太さは読み元の段だけが
// 決める。1 テクセル刻みで積んでいたときは、長さを稼ぐには粗い段から引くしかなかった。
//
// **タップを片側だけにするのが要。** 両側にすると、距離 d に届く経路が複数でき(たとえば
// 12 進んで 3 戻る)、そのどれもが「進んだ総量」ぶん減衰した重みを持つ。結果として核は
// exp(-d/減衰長) から周期的に凹み、**刻みの周期で明暗の縞が見える。** 片側だけなら、タップ距離の
// 組み合わせは d のタップ数進法の表現そのものになって一意に決まり、合成した核は距離に対する
// 素直な指数になる。**条 1 本につき 1 本の鎖**が要り、6 本の条なら 6 本の鎖になる。
//
// **鎖どうしを混ぜないこと。** 1 つのパスで複数の向きをまとめて処理すると、次のパスがその結果を
// さらに別の向きへ広げて「星の星」になる。
export function streakPass(
  source: THREE.Texture, texel: Vec2Uniform, angle: number, pass: number,
): Vec3Node {
  const stride = STREAK_TAPS ** pass;
  const taps: Vec3Node[] = [];
  let total = 0;
  for (let step = 0; step < STREAK_TAPS; step++) {
    const distance = step * stride;
    const weight = Math.exp(-distance / STREAK_FALLOFF);
    const x = Math.cos(angle) * distance;
    const y = Math.sin(angle) * distance;
    taps.push(spreadAt(source, texel, x, y).mul(weight));
    total += weight;
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
    return sampleInside(source, center.add(screenUV.sub(center).mul(scale))).mul(balanced);
  }));
}
