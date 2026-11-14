// 大気を持つ天体の列を、uniform 配列として持ち回る器。直射光の透過率表
// (SunExtinction)と天空光表(SkyLightSource)が、シェーディング点の属する天体ごとの
// (太陽の天頂角余弦・高度・局所の鉛直)を引くために共有する。
// 受け取るのは大気パスが描く天体と同じ列 — 描かない大気は光も寄与も掛けない。
import * as THREE from 'three/webgpu';
import { uniformArray } from 'three/tsl';
import { MAX_ATMOSPHERE_BODIES, type AtmosphereBody } from '../atmosphere';
import type { FloatNode, Vec3Node } from '../tsl-types';
import {
  polarStretchOf, sunPathGeometry, type SunPathAtmosphere, type SunPathGeometry,
} from './sun-path-depth';

// 共有の経路式が出す幾何に、そのスロットの地表半径を足したもの。
export interface SlottedSunPath extends SunPathGeometry {
  readonly surfaceRadius: FloatNode;
}

export class AtmosphereSlots {
  // 天体ごとの値。BodyShadow と同じく、uniform 配列の実体として JS 配列を持つ。
  private readonly centers: THREE.Vector3[];
  private readonly polarAxes: THREE.Vector3[];
  private readonly surfaceRadii: number[];
  private readonly polarStretches: number[];
  private readonly centerArray: THREE.UniformArrayNode<'vec3'>;
  private readonly polarAxisArray: THREE.UniformArrayNode<'vec3'>;
  private readonly surfaceRadiusArray: THREE.UniformArrayNode<'float'>;
  private readonly polarStretchArray: THREE.UniformArrayNode<'float'>;

  // 上限ぶんの uniform を確保する。件数は固定なので、大気を持つ天体が増減しても
  // グラフの形は変わらない。
  public constructor() {
    this.centers = Array.from({ length: MAX_ATMOSPHERE_BODIES }, () => new THREE.Vector3());
    this.polarAxes = Array.from({ length: MAX_ATMOSPHERE_BODIES }, () => new THREE.Vector3(0, 1, 0));
    this.surfaceRadii = Array.from({ length: MAX_ATMOSPHERE_BODIES }, () => 0);
    this.polarStretches = Array.from({ length: MAX_ATMOSPHERE_BODIES }, () => 0);
    this.centerArray = uniformArray(this.centers, 'vec3');
    this.polarAxisArray = uniformArray(this.polarAxes, 'vec3');
    this.surfaceRadiusArray = uniformArray(this.surfaceRadii, 'float');
    this.polarStretchArray = uniformArray(this.polarStretches, 'float');
  }

  // このフレームの大気の天体の列。空きスロットは地表半径 0 で置く — 表の側が素通しの
  // 値を読むので、ここの値が絵へ出ることはない。
  public set(bodies: readonly AtmosphereBody[]): void {
    for (const [i, center] of this.centers.entries()) {
      const body = bodies[i];
      if (body === undefined) {
        this.surfaceRadii[i] = 0;
        continue;
      }
      center.copy(body.center);
      this.surfaceRadii[i] = body.surfaceRadius;
      // **極軸は単位ベクトルでなければならない** — ノルムが 1 でないと扁平率の伸縮が
      // 二乗で過剰に掛かる。
      this.polarAxes[i]!.copy(body.polarAxis).normalize();
      this.polarStretches[i] = polarStretchOf(body.polarRatio);
    }
  }

  // スロット i の天体の幾何で、点から恒星への経路の形を引く。surfaceRadius も返す
  // (高度の引き方が要るため)。
  public geometryOf(i: number, worldPos: Vec3Node, sunPos: Vec3Node): SlottedSunPath {
    const atmosphere: SunPathAtmosphere = {
      center: this.centerArray.element(i),
      surfaceRadius: this.surfaceRadiusArray.element(i) as FloatNode,
      polarAxis: this.polarAxisArray.element(i),
      polarStretch: this.polarStretchArray.element(i) as FloatNode,
    };
    return { ...sunPathGeometry(worldPos, sunPos, atmosphere), surfaceRadius: atmosphere.surfaceRadius };
  }
}
