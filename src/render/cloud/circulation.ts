// 大気の大循環。単位方向を、そこに効く緯度帯の流れに乗せた「ノイズ空間の位置」へ写すのと、
// そこに効く平均風を返すのを担う。帯は赤道を挟んで鏡像に並ぶ 6 本で、境目では隣り合う 2 本が
// 重なる。角速度の表は層ごとに違うので持ち込みで受け取り、帯の中心緯度と混ぜ幅だけを層のあいだで
// 共有する。
//
// 東西の流れは自転軸まわりの回転、南北の流れは公転で作る。公転は、球を公転の中心から離してから
// 回すので、球の極は常に進行方向を向き、模様の湧き出し口は北極に、吸い込み口は南極に固定される
// (半径ぶんだけ離れた円弧なので、模様が入れ替わる時間の尺度では直進と区別が付かない)。角度は
// どちらも 2π で畳めるので、時刻がどれだけ進んでもノイズ空間の座標は有界に留まる。
import * as THREE from 'three/webgpu';
import {
  Fn, If, abs, clamp, cos, float, greaterThan, int, round, sign, sin, smoothstep, uniform, uniformArray, vec3,
} from 'three/tsl';
import { latitudeOf } from './sphere-frame';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node } from '../tsl-types';

// 1 本の帯で模様が進む角速度 [°/日]。east が東向き(経度の進み)、north が北向き(緯度の進み)。
// **速さ [m/s] ではなく角速度で持つ。** この流れは伸びではなく見えの動きを作るもので、移流が
// 使う風とは別の系統にある(突き合わせない)。角速度なら、帯が何日で 1 周するかを直接決められる。
export type CirculationBand = { readonly east: number; readonly north: number };

// 帯の表は北から南へ並び、中心緯度は FIRST_LATITUDE から BAND_SPACING 刻みで番号から出る。
const FIRST_LATITUDE = THREE.MathUtils.degToRad(75);
const BAND_SPACING = THREE.MathUtils.degToRad(30);

// 地表付近の帯。極偏東風・偏西風・貿易風が赤道を挟んで鏡像に並ぶ。
export const SURFACE_BANDS: readonly CirculationBand[] = [
  { east: -9, north: -1.6 }, // 極偏東風(北)
  { east: 11, north: 2.3 }, // 偏西風(北)
  { east: -5.6, north: -2.3 }, // 貿易風(北)
  { east: -5.6, north: 2.3 }, // 貿易風(南)
  { east: 11, north: -2.3 }, // 偏西風(南)
  { east: -9, north: 1.6 }, // 極偏東風(南)
];

// 巻雲の高さ(≈200 hPa)の帯。南北はどの帯でも地表付近と逆向きで、東西は中緯度だけが同じ西風の
// まま亜熱帯ジェットまで速くなり、熱帯と極では逆向きになる。
export const UPPER_BANDS: readonly CirculationBand[] = [
  { east: 18, north: 1.6 }, // 極(北)
  { east: 33, north: -2.3 }, // 亜熱帯ジェット(北)
  { east: 1.6, north: 2.3 }, // 熱帯(北)
  { east: 1.6, north: -2.3 }, // 熱帯(南)
  { east: 33, north: 2.3 }, // 亜熱帯ジェット(南)
  { east: 18, north: -1.6 }, // 極(南)
];

// 隣り合う帯を混ぜる幅(帯の間隔に対する比)。境目の 0°・±30°・±60° を中心に取る。狭いほど
// 逆向きに流れる 2 枚が重なる範囲が狭まり、広いほど向きの変わり方が滑らかになる。
const BLEND_WIDTH = 0.5;

// 公転の半径(球の半径を 1 とする)。公転には進行方向が回ることに伴う「転がり」が付き、その速さは
// 流れの速さの 1/半径 になる。大きく取るほど直進に近づき、ノイズ空間の座標が伸びる。
const ORBIT_RADIUS = 30;

// 呼吸: ノイズ空間の中で球の半径を伸縮させ、模様をその場で入れ替える。公転がノイズ空間で球面の
// 法線を向く割合は |sin(緯度)| なので、これが無いと熱帯の模様は形を変えずに滑るだけになる。
// 振幅は赤道での値で、極へ向けて 0 に落とす — 一律に掛けると、公転が既に法線を向いている中緯度で
// 両者が打ち消し合い、模様の入れ替わりが止まる時期ができる。周期は [s]。
const BREATH_AMPLITUDE = 0.05;
const BREATH_PERIOD = 7 * 86400;

// 帯 1 本と、そこへ寄せる重み。混ざる 2 本の重みは二乗和が 1 に保たれる対で、境目ではどちらも
// 1/√2 になる。
type WeightedBand = {
  readonly index: FloatNode;
  readonly weight: FloatNode;
};

export class Circulation {
  // 帯ごとの (cos 自転角, sin 自転角, cos 公転位相, sin 公転位相)。書き換えるのはこちらで、
  // uniform 配列は描画のたびにここから詰め直される。
  private readonly flows: THREE.Vector4[];
  private readonly flowArray: THREE.UniformArrayNode<'vec4'>;
  // 帯ごとの角速度 [°/日](x が東向き、y が北向き)。
  private readonly windArray: THREE.UniformArrayNode<'vec2'>;
  // 呼吸の位相(赤道での半径の伸び)。
  private readonly breath: FloatUniform = uniform(0);

  // bands はこの層の帯の角速度。
  public constructor(private readonly bands: readonly CirculationBand[]) {
    this.flows = bands.map(() => new THREE.Vector4(1, 0, 1, 0));
    this.flowArray = uniformArray(this.flows, 'vec4');
    this.windArray = uniformArray(bands.map((band) => new THREE.Vector2(band.east, band.north)), 'vec2');
    this.syncTime(0);
  }

  // 時刻 [s] の帯ごとの角度を uniform へ写す。2π で畳んでから余弦・正弦にするので、大きな時刻でも
  // 精度が落ちない。
  public syncTime(seconds: number): void {
    for (const [i, band] of this.bands.entries()) {
      const spin = wrapAngle(perSecond(band.east) * seconds);
      // 公転の位相が増えると模様は南へ動くので、北向きの帯では符号を反転する。
      const orbit = wrapAngle((-perSecond(band.north) * seconds) / ORBIT_RADIUS);
      this.flows[i]!.set(Math.cos(spin), Math.sin(spin), Math.cos(orbit), Math.sin(orbit));
    }
    this.breath.value = BREATH_AMPLITUDE * Math.sin((2 * Math.PI * seconds) / BREATH_PERIOD);
  }

  // 単位方向 direction の模様を、そこに効く帯の流れへ乗せて sample した値。sample へ渡る位置は、
  // 球の半径を 1 とするノイズ空間の位置。境目では隣り合う 2 本を混ぜる。
  //
  // **sample を書くのは 2 箇所まで。** sample はノイズの評価そのもので、書いた数だけシェーダが
  // 膨らむ。2 枚目を評価するのは混ざる範囲にいるときだけで、分岐の向きは緯度だけで決まるので、
  // 画面のまとまった範囲で揃う。
  public carry(direction: Vec3Node, sample: (position: Vec3Node) => FloatNode): FloatNode {
    return Fn(() => {
      const [near, far] = this.bandsAt(direction);
      // 呼吸を効かせる度合い。cos²(緯度) をもう一度掛けてあるのは、公転が既に法線を向いている
      // 中緯度で張り合わせないため。
      const cosLatitude2 = float(1).sub(direction.y.mul(direction.y));
      const breathing = direction.mul(this.breath.mul(cosLatitude2).mul(cosLatitude2).add(1)).toVar();

      const carried = sample(this.positionAt(breathing, near.index)).mul(near.weight).toVar();
      If(greaterThan(far.weight, 0), () => {
        carried.addAssign(sample(this.positionAt(breathing, far.index)).mul(far.weight));
      });
      return carried;
    })();
  }

  // 単位方向 direction における平均風 [°/日](x が東向き、y が北向き)。重なる帯は足し合わさる。
  public meanWindAt(direction: Vec3Node): Vec2Node {
    const [near, far] = this.bandsAt(direction);
    return this.windArray.element(int(near.index)).mul(near.weight)
      .add(this.windArray.element(int(far.index)).mul(far.weight));
  }

  // 単位方向 direction に効く帯 2 本。[0] がいちばん近い帯、[1] がその隣で、[1] の重みは混ざる
  // 範囲の外では 0 になる。
  private bandsAt(direction: Vec3Node): readonly [WeightedBand, WeightedBand] {
    const band = clamp(float(FIRST_LATITUDE).sub(latitudeOf(direction)).div(BAND_SPACING), 0, this.bands.length - 1);
    const nearest = round(band).toVar();
    const offset = band.sub(nearest).toVar();
    // 近い帯から隣の帯へ渡る 4 分の 1 回転。cos と sin で受けるので、渡るあいだ二乗和が 1 に保たれる。
    const angle = smoothstep(0.5 - BLEND_WIDTH / 2, 0.5 + BLEND_WIDTH / 2, abs(offset)).mul(Math.PI / 2).toVar();
    return [
      { index: nearest, weight: cos(angle) },
      { index: nearest.add(sign(offset)), weight: sin(angle) },
    ];
  }

  // 帯 index の流れに乗せた point の位置。point は呼吸で伸縮させた単位方向。自転軸が +Y、
  // 公転面の法線が +X であることは sphere-frame の POLE と field-projection の経度の取り決めに従う。
  private positionAt(point: Vec3Node, index: FloatNode): Vec3Node {
    const flow = this.flowArray.element(int(index));
    // 東西の流れ: 自転軸まわりに −自転角。
    const spun = vec3(
      point.x.mul(flow.x).sub(point.z.mul(flow.y)),
      point.y,
      point.x.mul(flow.y).add(point.z.mul(flow.x)),
    );
    // 南北の流れ: 公転の中心から離してから、公転面の法線まわりに −公転位相。
    const orbiting = spun.add(vec3(0, 0, ORBIT_RADIUS));
    return vec3(
      orbiting.x,
      orbiting.y.mul(flow.z).add(orbiting.z.mul(flow.w)),
      orbiting.z.mul(flow.z).sub(orbiting.y.mul(flow.w)),
    );
  }
}

// 表の角速度 [°/日] を [rad/s] へ。
function perSecond(degreesPerDay: number): number {
  return THREE.MathUtils.degToRad(degreesPerDay) / 86400;
}

// 角度 [rad] を 0..2π へ畳む。
function wrapAngle(angle: number): number {
  const turns = angle / (2 * Math.PI);
  return (turns - Math.floor(turns)) * 2 * Math.PI;
}
