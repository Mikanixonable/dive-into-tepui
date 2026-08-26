// レンズ効果が画面の絵へ当てる核。**どれも係数の総和が 1 で、正規化でそれを保証する** —
// 直書きの係数だと、あとで刻みを変えたときに総和が静かに 1 からずれ、レンズ段が光を増やす
// (あるいは減らす)ようになってしまう。総和が 1 でありさえすれば、レンズ段は光を配り直す
// だけの線形写像に留まる(その拡張性の話は lens-pass.ts の冒頭)。
//
// **半精度浮動小数点の上限(65504)を跨がないのも、総和が 1 であることに掛かっている** —
// 出力が入力の最大値(太陽面の 4.62e4)を超えないので、Inf も NaN も構造的に起きない。
import * as THREE from 'three/webgpu';
import { and, greaterThan, lessThan, screenSize, screenUV, select, texture, vec2, vec3 } from 'three/tsl';
import type { Vec2Node, Vec2Uniform, Vec3Node } from '../tsl-types';

// 条の 1 パスあたりのタップ数。**パスをまたぐ刻みをこの数と同じにする。**
const STREAK_TAPS = 12;
// 条の減衰長 [読み元のテクセル]。
const STREAK_FALLOFF = 50;

// ゴースト 1 枚を読むタップの間隔 [読み元のテクセル] と、その配り方。縮小段の核は支持が四角いので、
// 1 点で読むと光点が角ばった板として写る。**四方へ散らしてから平均すると角が取れて丸い像になる。**
const GHOST_TAP_RADIUS = 0.65;
const GHOST_TAPS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// ゴーストの読み元。**1 段ずつ粗くなる縮小段を、細かいほうから並べる**(タップの間隔が段の粗さに
// 比例することが、この並びに掛かっている)。
export type GhostSources = readonly [THREE.Texture, THREE.Texture, THREE.Texture];

// 絞りの反射像 1 枚。
type Ghost = {
  // 画面中心を基準に像へ掛かる倍率 [横, 縦]。**負なら中心を挟んだ反対側**へ出て、絶対値が
  // 小さいほど遠く、大きく写る。
  readonly scale: readonly [number, number];
  // 倍率を掛ける前に像を回す角 [rad]。
  readonly angle: number;
  // 放射軸からのずらし [画面の高さに対する割合]。
  readonly offset: readonly [number, number];
  // 読み元。GhostSources の並びを指し、大きいほど輪郭の緩い像になる。
  readonly softness: 0 | 1 | 2;
  // 核のうちこの 1 枚が持つ配分。**表の総和で正規化してから使う。**
  readonly weight: number;
  // コーティングの干渉による色み。**加重平均が白になるよう正規化してから使う**(そうしないと
  // ゴーストが光量を色ごとに増減させてしまう)。
  readonly tint: readonly [number, number, number];
  // 色収差。チャンネルごとに倍率をこの割合だけずらす。
  readonly dispersion: number;
};

// 絞りの反射像。**配分を総和で正規化するので、枚数を増やせば 1 枚あたりは薄くなる。**
//
// **倍率の積の絶対値は 1 以下に留める。** 1 を超える枚は同じ光を狭い面積へ集めるので、その画素が
// 入力の最大値を超える — 半精度浮動小数点の余裕は太陽面(4.62e4)と上限(65504)の 1.4 倍しかない。
const GHOSTS: readonly Ghost[] = [
  { scale: [-0.17, -0.18], angle: 0.1, offset: [0, 0], softness: 2, weight: 0.05, tint: [1.00, 0.74, 0.45], dispersion: 0.012 },
  { scale: [-0.24, -0.23], angle: -0.14, offset: [0, 0], softness: 2, weight: 0.05, tint: [0.95, 0.68, 1.00], dispersion: 0.014 },
  { scale: [0.28, 0.30], angle: 0.12, offset: [0, 0], softness: 2, weight: 0.05, tint: [1.00, 0.62, 0.48], dispersion: 0.012 },
  { scale: [-0.34, -0.32], angle: -0.08, offset: [0, 0], softness: 1, weight: 0.07, tint: [0.48, 0.84, 1.00], dispersion: 0.012 },
  { scale: [-0.42, -0.45], angle: 0.16, offset: [0, 0], softness: 1, weight: 0.07, tint: [0.60, 1.00, 0.68], dispersion: 0.01 },
  { scale: [-0.52, -0.50], angle: -0.12, offset: [0, 0], softness: 1, weight: 0.08, tint: [0.84, 0.56, 1.00], dispersion: 0.012 },
  { scale: [-0.62, -0.60], angle: 0.06, offset: [0.015, -0.008], softness: 1, weight: 0.08, tint: [1.00, 0.88, 0.62], dispersion: 0.008 },
  { scale: [-0.75, -0.72], angle: -0.18, offset: [0, 0], softness: 1, weight: 0.08, tint: [0.55, 0.74, 1.00], dispersion: 0.01 },
  { scale: [-0.88, -0.85], angle: 0.1, offset: [0, 0], softness: 0, weight: 0.07, tint: [1.00, 0.95, 0.82], dispersion: 0.006 },
  { scale: [-1.02, -0.95], angle: -0.05, offset: [0, 0], softness: 0, weight: 0.06, tint: [0.78, 0.62, 1.00], dispersion: 0.006 },
  { scale: [-1.30, -0.72], angle: 0.34, offset: [0, 0], softness: 1, weight: 0.05, tint: [0.66, 1.00, 0.92], dispersion: 0.008 },
  { scale: [0.55, 0.58], angle: -0.1, offset: [0, 0], softness: 1, weight: 0.06, tint: [0.72, 0.88, 1.00], dispersion: 0.008 },
  { scale: [0.80, 0.75], angle: 0.14, offset: [0.012, 0.01], softness: 0, weight: 0.05, tint: [0.70, 1.00, 0.74], dispersion: 0.008 },
  { scale: [1.15, 0.62], angle: -0.4, offset: [0, 0], softness: 1, weight: 0.05, tint: [1.00, 0.72, 0.95], dispersion: 0.01 },
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

// 1 枚ぶんの像。**チャンネルごとに倍率をわずかにずらして 3 回読む**ので、輪郭に色収差の縁が出る。
// share は正規化済みの配分、meanTint は色みの加重平均。
function ghostSheet(
  source: THREE.Texture, ghost: Ghost, share: number, meanTint: readonly [number, number, number],
): Vec3Node {
  const center = vec2(0.5, 0.5);
  // 回転と非等方な倍率が縦横で歪まないよう、画素が正方になる座標へ直してから掛ける。
  const stretch = vec2(screenSize.x.div(screenSize.y), 1);
  const local = screenUV.sub(center).mul(stretch);
  const [scaleX, scaleY] = ghost.scale;
  const cos = Math.cos(ghost.angle);
  const sin = Math.sin(ghost.angle);
  const channel = (index: 0 | 1 | 2): Vec3Node => {
    // 中央のチャンネルが表の倍率そのもので、両端がその前後へずれる。
    const dispersed = 1 + (index - 1) * ghost.dispersion;
    const x = scaleX * dispersed;
    const y = scaleY * dispersed;
    const warped = vec2(
      local.x.mul(cos * x).add(local.y.mul(-sin * y)),
      local.x.mul(sin * x).add(local.y.mul(cos * y)),
    ).add(vec2(ghost.offset[0], ghost.offset[1]));
    // 広がった像は同じ光が広い面積へ散るので、倍率の行列式で光量を戻す。
    const gain = share * Math.abs(x * y) * (ghost.tint[index] / meanTint[index]);
    const uv = center.add(warped.div(stretch));
    const reach = GHOST_TAP_RADIUS * 2 ** ghost.softness;
    const spread = vec2(reach, reach).div(screenSize);
    const ring = GHOST_TAPS.map(([dx, dy]) => sampleInside(source, uv.add(vec2(dx, dy).mul(spread))));
    return sumOf(ring).mul(gain / GHOST_TAPS.length);
  };
  return vec3(channel(0).r, channel(1).g, channel(2).b);
}

// 絞りの反射像。像をアフィン変換で置き直したものを、色み・硬さ・向きを変えて重ねる。
export function apertureGhosts(sources: GhostSources): Vec3Node {
  const totalWeight = GHOSTS.reduce((sum, ghost) => sum + ghost.weight, 0);
  const meanOf = (index: 0 | 1 | 2): number =>
    GHOSTS.reduce((sum, ghost) => sum + ghost.weight * ghost.tint[index], 0) / totalWeight;
  const meanTint: readonly [number, number, number] = [meanOf(0), meanOf(1), meanOf(2)];
  return sumOf(GHOSTS.map(
    (ghost) => ghostSheet(sources[ghost.softness], ghost, ghost.weight / totalWeight, meanTint),
  ));
}
