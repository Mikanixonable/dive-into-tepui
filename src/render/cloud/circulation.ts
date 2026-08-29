// 大気の大循環。単位方向を、そこに効く緯度帯の流れに乗せた「ノイズ空間の位置」へ写す。帯は
// 極偏東風・偏西風・貿易風が赤道を挟んで鏡像に並ぶ 6 本で、境目では隣り合う 2 本を混ぜる。
//
// 東西の流れは自転軸まわりの回転、南北の流れは公転で作る。公転は、球を公転の中心から離してから
// 回すので、球の極は常に進行方向を向き、模様の湧き出し口は北極に、吸い込み口は南極に固定される
// (半径ぶんだけ離れた円弧なので、模様が入れ替わる時間の尺度では直進と区別が付かない)。角度は
// どちらも 2π で畳めるので、時刻がどれだけ進んでもノイズ空間の座標は有界に留まる。
import * as THREE from 'three/webgpu';
import {
  clamp, float, floor, greaterThanEqual, inverseSqrt, min, select, smoothstep, uniform, vec3,
} from 'three/tsl';
import { latitudeOf } from './sphere-frame';
import type { FloatNode, Vec3Node, Vec4Node, Vec4Uniform } from '../tsl-types';

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

export class Circulation {
  // 帯ごとの (cos 自転角, sin 自転角, cos 公転位相, sin 公転位相)。
  private readonly flows: readonly Vec4Uniform[] = BANDS.map(() => uniform(new THREE.Vector4(1, 0, 1, 0)));

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
  }

  // 単位方向 direction の模様を、そこに効く 2 本の帯の流れへ乗せて sample し、混ぜた値。sample へ
  // 渡る位置は、球の半径を 1 とするノイズ空間の位置。重みは二乗和が 1 になるよう正規化してあるので、
  // 独立な 2 枚を混ぜても境目で振幅が落ちない。
  public carry(direction: Vec3Node, sample: (position: Vec3Node) => FloatNode): FloatNode {
    const band = clamp(float(FIRST_LATITUDE).sub(latitudeOf(direction)).div(BAND_SPACING), 0, BANDS.length - 1);
    const lower = floor(band);
    const upper = min(lower.add(1), BANDS.length - 1);
    const weight = smoothstep(0.5 - BLEND_WIDTH / 2, 0.5 + BLEND_WIDTH / 2, band.sub(lower));
    const rest = float(1).sub(weight);
    const scale = inverseSqrt(weight.mul(weight).add(rest.mul(rest)));
    return sample(this.positionAt(direction, lower)).mul(rest.mul(scale))
      .add(sample(this.positionAt(direction, upper)).mul(weight.mul(scale)));
  }

  // 帯 index の流れに乗せた direction の位置。自転軸が +Y、公転面の法線が +X であることは
  // sphere-frame の POLE と正距円筒図法の取り決めに従う。
  private positionAt(direction: Vec3Node, index: FloatNode): Vec3Node {
    const flow = this.flowAt(index);
    // 東西の流れ: 自転軸まわりに −自転角。
    const spun = vec3(
      direction.x.mul(flow.x).sub(direction.z.mul(flow.y)),
      direction.y,
      direction.x.mul(flow.y).add(direction.z.mul(flow.x)),
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
