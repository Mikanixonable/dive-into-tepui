// 大気の大循環。単位方向を、そこに効く緯度帯の流れに乗せた「ノイズ空間の位置」へ写す。帯は
// 極偏東風・偏西風・貿易風が赤道を挟んで鏡像に並ぶ 6 本で、境目では隣り合う 2 本を混ぜる。
//
// 東西の流れは自転軸まわりの回転、南北の流れは公転で作る。公転は、球を公転の中心から離してから
// 回すので、球の極は常に進行方向を向き、模様の湧き出し口は北極に、吸い込み口は南極に固定される
// (半径ぶんだけ離れた円弧なので、模様が入れ替わる時間の尺度では直進と区別が付かない)。角度は
// どちらも 2π で畳めるので、時刻がどれだけ進んでもノイズ空間の座標は有界に留まる。
import * as THREE from 'three/webgpu';
import {
  Fn, If, clamp, float, floor, greaterThanEqual, inverseSqrt, lessThanEqual, min, select, smoothstep,
  uniform, vec3,
} from 'three/tsl';
import { latitudeOf } from './sphere-frame';
import type { FloatNode, FloatUniform, Vec3Node, Vec4Node, Vec4Uniform } from '../tsl-types';

// 帯ごとの、中心緯度での雲の進む速さ [m/s](east が東向き、north が北向き)。北から南へ並び、
// 中心緯度は FIRST_LATITUDE から BAND_SPACING 刻みで番号から出る。
const BANDS = [
  { east: -5, north: -2 }, // 極偏東風(北)
  { east: 10, north: 3 }, // 偏西風(北)
  { east: -7, north: -3 }, // 貿易風(北)
  { east: -7, north: 3 }, // 貿易風(南)
  { east: 10, north: -3 }, // 偏西風(南)
  { east: -5, north: 2 }, // 極偏東風(南)
] as const;
const FIRST_LATITUDE = THREE.MathUtils.degToRad(75);
const BAND_SPACING = THREE.MathUtils.degToRad(30);

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

export class Circulation {
  // 帯ごとの (cos 自転角, sin 自転角, cos 公転位相, sin 公転位相)。
  private readonly flows: readonly Vec4Uniform[] = BANDS.map(() => uniform(new THREE.Vector4(1, 0, 1, 0)));
  // 呼吸の位相(赤道での半径の伸び)。
  private readonly breath: FloatUniform = uniform(0);

  // radius はこの天体の半径 [m]。
  public constructor(private readonly radius: number) {
    this.syncTime(0);
  }

  // 時刻 [s] の帯ごとの角度を uniform へ写す。2π で畳んでから余弦・正弦にするので、大きな時刻でも
  // 精度が落ちない。
  public syncTime(seconds: number): void {
    for (const [i, band] of BANDS.entries()) {
      // 中心緯度での速さ [m/s] を、その緯度の円に沿った角速度 [rad/s] へ。
      const perMeter = 1 / (this.radius * Math.cos(FIRST_LATITUDE - i * BAND_SPACING));
      const spin = wrapAngle(band.east * perMeter * seconds);
      // 公転の位相が増えると模様は南へ動くので、北向きの帯では符号を反転する。
      const orbit = wrapAngle((-band.north * perMeter * seconds) / ORBIT_RADIUS);
      this.flows[i]!.value.set(Math.cos(spin), Math.sin(spin), Math.cos(orbit), Math.sin(orbit));
    }
    this.breath.value = BREATH_AMPLITUDE * Math.sin((2 * Math.PI * seconds) / BREATH_PERIOD);
  }

  // 単位方向 direction の模様を、そこに効く帯の流れへ乗せて sample した値。sample へ渡る位置は、
  // 球の半径を 1 とするノイズ空間の位置。境目では隣り合う 2 本を混ぜる — 重みは二乗和が 1 になるよう
  // 正規化してあるので、独立な 2 枚を混ぜても境目で振幅が落ちない。
  //
  // **2 枚目を sample するのは混ざる範囲にいるときだけ。** sample はノイズの評価そのもので、
  // 重み 0 のまま走らせると帯の内側(緯度の 6 割)でその分がまるごと捨てられる。分岐の向きは
  // 緯度だけで決まるので、画面のまとまった範囲で揃う。
  public carry(direction: Vec3Node, sample: (position: Vec3Node) => FloatNode): FloatNode {
    return Fn(() => {
      const band = clamp(float(FIRST_LATITUDE).sub(latitudeOf(direction)).div(BAND_SPACING), 0, BANDS.length - 1);
      const lower = floor(band).toVar();
      const upper = min(lower.add(1), BANDS.length - 1).toVar();
      const weight = smoothstep(0.5 - BLEND_WIDTH / 2, 0.5 + BLEND_WIDTH / 2, band.sub(lower)).toVar();
      // 呼吸を効かせる度合い。cos²(緯度) をもう一度掛けてあるのは、公転が既に法線を向いている
      // 中緯度で張り合わせないため。
      const cosLatitude2 = float(1).sub(direction.y.mul(direction.y));
      const breathing = direction.mul(this.breath.mul(cosLatitude2).mul(cosLatitude2).add(1)).toVar();

      const carried = float(0).toVar();
      If(lessThanEqual(weight, 0), () => {
        carried.assign(sample(this.positionAt(breathing, lower)));
      }).ElseIf(greaterThanEqual(weight, 1), () => {
        carried.assign(sample(this.positionAt(breathing, upper)));
      }).Else(() => {
        const rest = float(1).sub(weight);
        const scale = inverseSqrt(weight.mul(weight).add(rest.mul(rest)));
        carried.assign(sample(this.positionAt(breathing, lower)).mul(rest.mul(scale))
          .add(sample(this.positionAt(breathing, upper)).mul(weight.mul(scale))));
      });
      return carried;
    })();
  }

  // 帯 index の流れに乗せた point の位置。point は呼吸で伸縮させた単位方向。自転軸が +Y、
  // 公転面の法線が +X であることは sphere-frame の POLE と正距円筒図法の取り決めに従う。
  private positionAt(point: Vec3Node, index: FloatNode): Vec3Node {
    const flow = this.flowAt(index);
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

  // 番号で帯の角度を引く。
  private flowAt(index: FloatNode): Vec4Node {
    let flow: Vec4Node = this.flows[0]!;
    for (const [i, next] of this.flows.entries()) {
      if (i > 0) flow = select(greaterThanEqual(index, i), next, flow);
    }
    return flow;
  }
}

// 角度 [rad] を 0..2π へ畳む。
function wrapAngle(angle: number): number {
  const turns = angle / (2 * Math.PI);
  return (turns - Math.floor(turns)) * 2 * Math.PI;
}
