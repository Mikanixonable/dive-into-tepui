// レンズ効果が画面の絵へ当てる核。**どれも係数の総和が 1 で、正規化でそれを保証する** —
// 直書きの係数だと、あとで刻みを変えたときに総和が静かに 1 からずれ、核が光を増やす(あるいは
// 減らす)ようになってしまう。総和が 1 なら出力は入力の最大値(太陽面の 4.62e4)を超えないので、
// 半精度浮動小数点の上限(65504)を跨ぐことも構造的に起きない。
import * as THREE from 'three/webgpu';
import { and, greaterThan, lessThan, screenSize, screenUV, select, texture, vec2, vec3 } from 'three/tsl';
import type { Vec2Node, Vec2Uniform, Vec3Node } from '../tsl-types';

// 条の 1 パスあたりのタップ数。**パスをまたぐ刻みをこの数と同じにする。**
const STREAK_TAPS = 12;
// 条の減衰長 [読み元のテクセル]。
const STREAK_FALLOFF = 50;

// scale と power を測る基準の半径 [画面の高さ]。半径写像はここで scale そのものになる。
const GHOST_REFERENCE_RADIUS = 0.5;
// 半径写像を丸める芯の半径 [画面の高さ]。power が 1 未満の枚は中心へ寄るほど光を集めるので、
// **この芯で頭打ちにしないと画面中心の 1 画素だけが際限なく明るくなる。**
const GHOST_CORE_RADIUS = 0.12;

// ゴースト 1 枚をぼかすタップの間隔 [読み元のテクセル] と、その配り方。縮小段の核は支持が四角い
// ので、1 点で読むと光点が角ばった板として写る。**四方へ散らしてから平均すると角が取れて丸い像に
// なる。** 間隔を読み元のテクセルより広げると、1 つの像ではなく 4 つの複製として散らばる —
// **大きなぼけは環ではなく、粗い読み元が作る。**
const GHOST_TAP_RADIUS = 0.85;
const GHOST_TAPS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// ゴーストの読み元。**締まったものから順に、1 段ずつ粗くなる縮小段を 3 枚と、滲みの像を 1 枚。**
// 滲みの像は、解像度は 1 枚目と同じまま中身が画面いっぱいへ広がっているので、倍率を上げて光軸へ
// 寄せても大きく薄いままでいる。
export type GhostSources = readonly [THREE.Texture, THREE.Texture, THREE.Texture, THREE.Texture];
// 読み元 1 テクセルが、ゴーストの出力の何テクセルにあたるか。**ぼけ具合ではなく解像度の比**で、
// タップの間隔をこれに合わせることが、像が 4 つへ割れないことを担保している。
const GHOST_SOURCE_TEXELS: readonly [number, number, number, number] = [1, 2, 4, 1];

// 絞りの反射像 1 枚。**どのパラメータも光軸(画面中心)まわりの回転と可換**で、それが像を光点と
// 中心を結ぶ直線の上へ並べる。
type Ghost = {
  // GHOST_REFERENCE_RADIUS での倍率。**読む位置に掛かる**ので、像はこの逆数に拡大される。
  // 負なら中心を挟んだ反対側。
  readonly scale: number;
  // 半径写像の指数。1 なら純粋な拡大縮小になる。
  readonly power: number;
  // 読み元。GhostSources の並びを指す。
  readonly softness: 0 | 1 | 2 | 3;
  // 核のうちこの 1 枚が持つ配分。**表の総和で正規化してから使う。**
  readonly weight: number;
  // コーティングの干渉による色み。**加重平均が白になるよう正規化してから使う**(そうしないと
  // ゴーストが光量を色ごとに増減させてしまう)。
  readonly tint: readonly [number, number, number];
  // 色収差。チャンネルごとに倍率をこの割合だけずらす。
  readonly dispersion: number;
};

// 絞りの反射像。1 行が 1 枚で、絵としては次のように読む。半径はどれも画面の高さを 1 として測る。
//
// - **scale と power が、像の位置と大きさを決める。** 中心から rp にある光点の像は、
//   `R × (rp / (R × scale))^(1/power)`(R は GHOST_REFERENCE_RADIUS)に出る。**scale の絶対値が
//   小さいほど遠く、大きく写り**、power を上げるほど像は R へ引き寄せられる — **scale だけで
//   位置が決まるのは power が 1 のときだけ。**
// - **power が、像の形を決める。** 放射方向の伸びが周方向の 1/power になるので、1 より大きい枚は
//   軸を横切る弧に、小さい枚は軸に沿う筋になる。
// - **softness が、ぼけ具合を決める。** scale と独立に選べるので、光軸の近くに大きく薄い像を、
//   遠くに締まった像を置ける。
// - **weight を総和で正規化する**ので、枚数を増やせば 1 枚あたりは薄くなる。
//
// **写像が光を集める度合い(ヤコビアン)の weight つき総和を 1 以下に保つ。** scale の絶対値が 1 を
// 超える枚は同じ光を狭い面積へ集めるので、総和が 1 を超えると画素が入力の最大値を跨ぎ、半精度
// 浮動小数点の余裕(太陽面 4.62e4 に対し上限 65504)を食い潰す。
const GHOSTS: readonly Ghost[] = [
  { scale: -0.30, power: 2.20, softness: 2, weight: 0.05, tint: [1.00, 0.74, 0.45], dispersion: 0.012 },
  { scale: -0.42, power: 1.00, softness: 1, weight: 0.06, tint: [0.95, 0.68, 1.00], dispersion: 0.014 },
  { scale: -0.52, power: 1.80, softness: 0, weight: 0.05, tint: [0.48, 0.84, 1.00], dispersion: 0.012 },
  { scale: -0.62, power: 0.60, softness: 1, weight: 0.07, tint: [0.60, 1.00, 0.68], dispersion: 0.01 },
  { scale: -0.72, power: 1.40, softness: 3, weight: 0.06, tint: [0.84, 0.56, 1.00], dispersion: 0.012 },
  { scale: -0.85, power: 1.00, softness: 0, weight: 0.07, tint: [1.00, 0.88, 0.62], dispersion: 0.008 },
  { scale: -1.05, power: 1.00, softness: 3, weight: 0.05, tint: [0.55, 0.74, 1.00], dispersion: 0.01 },
  { scale: -1.35, power: 0.75, softness: 1, weight: 0.035, tint: [1.00, 0.95, 0.82], dispersion: 0.006 },
  { scale: -1.80, power: 1.00, softness: 2, weight: 0.025, tint: [0.66, 1.00, 0.92], dispersion: 0.008 },
  { scale: 0.45, power: 2.00, softness: 1, weight: 0.05, tint: [1.00, 0.62, 0.48], dispersion: 0.012 },
  { scale: 0.65, power: 1.00, softness: 3, weight: 0.06, tint: [0.72, 0.88, 1.00], dispersion: 0.008 },
  { scale: 0.80, power: 0.55, softness: 0, weight: 0.06, tint: [0.70, 1.00, 0.74], dispersion: 0.008 },
  { scale: 1.15, power: 1.60, softness: 2, weight: 0.03, tint: [1.00, 0.72, 0.95], dispersion: 0.01 },
  { scale: 1.60, power: 1.00, softness: 3, weight: 0.025, tint: [0.78, 0.62, 1.00], dispersion: 0.006 },
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

// **画面の外は黒として読む。** WebGPU にボーダー色が無いので、クランプで縁の画素が引き伸ばされる
// のをシェーダ側で打ち消す。重みは明るさではなく位置だけで決まるので、入力に対する線形性は保つ。
// **画面の端で核の総和が 1 を下回るのはそれでよい** — 画面の外へ出た光は戻ってこないし、
// 正規化し直すと端だけが明るくなる。
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
// 核が光を配り直すだけの線形写像だという前提を壊す。
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
// 決める。
//
// **タップを片側だけにするのが要。** 両側にすると、距離 d に届く経路が複数でき(たとえば
// 12 進んで 3 戻る)、そのどれもが「進んだ総量」ぶん減衰した重みを持つ。結果として核は
// exp(-d/減衰長) から周期的に凹み、**刻みの周期で明暗の縞が見える。** 片側だけなら、タップ距離の
// 組み合わせは d のタップ数進法の表現そのものになって一意に決まり、合成した核は距離に対する
// 素直な指数になる。**向き 1 つにつき 1 本の鎖**が要る。
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

// 1 枚ぶんの像。**読む位置への倍率を半径だけの関数にする**ので、写像は光軸まわりの回転と可換に
// なり、像は光点と中心を結ぶ直線の上へ出る。share は正規化済みの weight、meanTint は tint の
// 加重平均。
function ghostSheet(
  sources: GhostSources, ghost: Ghost, share: number, meanTint: readonly [number, number, number],
): Vec3Node {
  const center = vec2(0.5, 0.5);
  // 画素が正方になる座標へ直してから掛ける。半径が縦横比で歪むと回転対称でなくなる。
  const stretch = vec2(screenSize.x.div(screenSize.y), 1);
  const local = screenUV.sub(center).mul(stretch);
  // 半径に対するべき乗。指数が 1 なら 1 で、そのとき写像は純粋な拡大縮小になる。
  const shape = local.dot(local).add(GHOST_CORE_RADIUS ** 2)
    .div(GHOST_REFERENCE_RADIUS ** 2).pow((ghost.power - 1) / 2);
  const source = sources[ghost.softness];
  const reach = GHOST_TAP_RADIUS * GHOST_SOURCE_TEXELS[ghost.softness];
  const spread = vec2(reach, reach).div(screenSize);
  const channel = (index: 0 | 1 | 2): Vec3Node => {
    // 中央のチャンネルが表の scale そのもので、両端がその前後へずれる。
    const scale = ghost.scale * (1 + (index - 1) * ghost.dispersion);
    // 周方向の伸びは scale そのもの、放射方向はその微分なので power 倍になる。
    const tangential = shape.mul(scale);
    const radial = tangential.mul(ghost.power);
    const uv = center.add(local.mul(tangential).div(stretch));
    // 広がった像は同じ光が広い面積へ散るので、写像のヤコビアンで光量を戻す。
    const gain = tangential.mul(radial).abs().mul(share * (ghost.tint[index] / meanTint[index]));
    const ring = GHOST_TAPS.map(([dx, dy]) => sampleInside(source, uv.add(vec2(dx, dy).mul(spread))));
    return sumOf(ring).mul(gain).mul(1 / GHOST_TAPS.length);
  };
  return vec3(channel(0).r, channel(1).g, channel(2).b);
}

// 絞りの反射像。光軸を中心に置き直した像を、色み・大きさ・伸びを変えて重ねる。
export function apertureGhosts(sources: GhostSources): Vec3Node {
  const totalWeight = GHOSTS.reduce((sum, ghost) => sum + ghost.weight, 0);
  const meanOf = (index: 0 | 1 | 2): number =>
    GHOSTS.reduce((sum, ghost) => sum + ghost.weight * ghost.tint[index], 0) / totalWeight;
  const meanTint: readonly [number, number, number] = [meanOf(0), meanOf(1), meanOf(2)];
  return sumOf(GHOSTS.map(
    (ghost) => ghostSheet(sources, ghost, ghost.weight / totalWeight, meanTint),
  ));
}
