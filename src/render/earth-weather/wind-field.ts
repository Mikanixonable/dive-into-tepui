// 焼いた気圧の場と大循環から風を解く。風は局所的な気圧風(釣り合い風)へ、大循環の背景風と
// ロスビー波を重ねたもの — 地表付近と上層が分かれるのは背景風だけで、気圧から出る局所の
// 釣り合い風は共通。気団を風上へ遡らせる風もここで解く。
import * as THREE from 'three/webgpu';
import { dot, vec2 } from 'three/tsl';
import { AtmosphericWindField, SURFACE_HEIGHT, UPPER_CLOUD_HEIGHT } from './atmospheric-wind';
import { pressureBandSlopeAt } from './pressure-field';
import { RossbyWave } from './rossby-wave';
import { eastAt, latitudeOf, northAt } from './sphere-frame';
import { composeWind, FRICTION_RATE, balancedWind, isobarAt } from './wind-law';
import type { PressureField } from './pressure-field';
import type { BalancedWind } from './wind-law';
import type { FloatNode, Vec2Node, Vec3Node } from '../tsl-types';

// 風が等圧線を横切る角の上限 [rad]。湿度の風は中緯度で摩擦が作る角(45° で 30°)そのものに取る。
// 対流の風は摩擦が作る 60° を 50° に抑え、湿度の風と向きを 20° 離して 2 枚の移流場を交差させる。
// 熱帯では両方が大きな流入角を切り、台風のまわりで粒が放射状の筋に引かれるのを止める。
const SURFACE_WIND_CROSSING_LIMIT = THREE.MathUtils.degToRad(30);
const CONVECTION_WIND_CROSSING_LIMIT = THREE.MathUtils.degToRad(50);
// 対流を流す風の摩擦 [1/s]。湿度を流す風より強く取ると、等圧線を深く横切って 20〜30° 違う向きへ
// 伸びる。同じ風で流すと 2 枚が同じ向きへ伸びて、掛け合わせても筋のままになる。
const CONVECTION_FRICTION = 3 * FRICTION_RATE;

// 単位方向で解いた風の一式。pressure は解くのに使った気圧の偏差 [hPa]、advection は湿度を
// 流す風、convectionAdvection は対流を流す風(湿度の風より摩擦が強く等圧線を深く横切る — 同じ
// 風だと地表付近と上層の写しが同じ向きへ伸びて、掛け合わせても筋のままになる)。
// surfaceWind・upperWind は地表付近と上層の風の東・北の成分 [m/s](上層は巻雲の筋が従う流れ)。
export interface WindSample {
  readonly pressure: FloatNode;
  readonly advection: BalancedWind;
  readonly convectionAdvection: BalancedWind;
  readonly surfaceWind: Vec2Node;
  readonly upperWind: Vec2Node;
}

export class WindField {
  private readonly rossbyWave = new RossbyWave();
  private readonly atmosphericWind = new AtmosphericWindField();

  // pressure は気圧の写し、surfaceRadius [m] は天体の半径、rotationPeriod [s] は自転周期。
  public constructor(
    private readonly pressure: PressureField,
    private readonly surfaceRadius: number,
    private readonly rotationPeriod: number,
  ) {
    this.syncTime(0);
  }

  // 時刻 [s] を波の uniform へ反映する。
  public syncTime(seconds: number): void {
    this.rossbyWave.syncTime(seconds);
  }

  // 単位方向 direction における気圧と、そこから解いた風の一式。焼いた気圧の写しを読むので、
  // 気圧を焼いたあとに描く。
  public at(direction: Vec3Node): WindSample {
    const latitude = latitudeOf(direction);
    const east = eastAt(direction);
    const north = northAt(direction);
    const field = this.pressure.at(direction, east, north);
    const rossby = this.rossbyWave.perturbationAt(direction, this.surfaceRadius);
    const local = balancedWind(
      field.gradient, field.isobar, field.bend, latitude, FRICTION_RATE,
      SURFACE_WIND_CROSSING_LIMIT, this.surfaceRadius, this.rotationPeriod,
    );
    const convectionLocal = balancedWind(
      field.gradient, field.isobar, field.bend, latitude, CONVECTION_FRICTION,
      CONVECTION_WIND_CROSSING_LIMIT, this.surfaceRadius, this.rotationPeriod,
    );
    const surfaceMean = this.atmosphericWind.sampleNode(latitude, SURFACE_HEIGHT);
    const surfaceBackground = east.mul(surfaceMean.x).add(north.mul(surfaceMean.y)).add(rossby);
    const upperMean = this.atmosphericWind.sampleNode(latitude, UPPER_CLOUD_HEIGHT);
    const upperBackground = east.mul(upperMean.x).add(north.mul(upperMean.y)).add(rossby);
    return {
      pressure: field.pressure,
      // 移流の遡りは、大循環の平均風からの偏差(局所の釣り合い風とロスビー波の摂動)で取る —
      // 源の模様の平行移動は、写しを焼く循環が平均風で既に担っている。平均風まで遡りに含めると
      // 両者が打ち消し合い、模様は周期の中で混ざり合うだけで流れも形の変化も鈍る。
      advection: composeWind(local, rossby),
      convectionAdvection: composeWind(convectionLocal, rossby),
      surfaceWind: eastNorthComponents(
        composeWind(local, surfaceBackground).velocity, east, north),
      upperWind: eastNorthComponents(composeWind(local, upperBackground).velocity, east, north),
    };
  }

  // 単位方向 direction で雲を運ぶ、地表付近と上層の風の東・北の成分 [m/s]。
  public windsAt(direction: Vec3Node): { readonly surfaceWind: Vec2Node; readonly upperWind: Vec2Node } {
    const { surfaceWind, upperWind } = this.at(direction);
    return { surfaceWind, upperWind };
  }

  // 単位方向 direction における気団を遡らせる風(東向き・北向きの成分 [m/s])。
  public traceWindAt(direction: Vec3Node): Vec2Node {
    return eastNorthComponents(this.traceFlowAt(direction).velocity, eastAt(direction), northAt(direction));
  }

  // 気団を風上へ遡らせる風。大循環の気圧帯を差し引いた気圧の勾配から解いた釣り合い風へ、大循環の
  // 平均風とロスビー波を重ねる。気圧帯を残すと、収束する緯度に緯線に沿った圧縮の環が立つ。
  public traceFlowAt(direction: Vec3Node): BalancedWind {
    const east = eastAt(direction);
    const north = northAt(direction);
    const latitude = latitudeOf(direction);
    const { gradient, bend } = this.pressure.at(direction, east, north);
    // 気圧帯は緯度だけの関数なので、その勾配は解析的に差し引ける。
    const eddy = gradient.sub(north.mul(pressureBandSlopeAt(latitude)));
    const wind = balancedWind(
      eddy, isobarAt(direction, eddy), bend, latitude, FRICTION_RATE, SURFACE_WIND_CROSSING_LIMIT,
      this.surfaceRadius, this.rotationPeriod,
    );
    const mean = this.atmosphericWind.sampleNode(latitude, SURFACE_HEIGHT);
    return {
      velocity: wind.velocity
        .add(east.mul(mean.x))
        .add(north.mul(mean.y))
        .add(this.rossbyWave.perturbationAt(direction, this.surfaceRadius)),
      turn: wind.turn,
    };
  }
}

// 接ベクトル v の東向き・北向きの成分。
function eastNorthComponents(v: Vec3Node, east: Vec3Node, north: Vec3Node): Vec2Node {
  return vec2(dot(v, east), dot(v, north));
}
