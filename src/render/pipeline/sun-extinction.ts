// 恒星の直射光が、大気を通って地表・雲・艦へ届くまでに受ける波長別の消衰。大気パスが
// 散乱光へ掛けるのと同じ式(sun-path-depth.ts)で、描画座標の点へ届く割合の TSL グラフを返す。
// 大気を持つ天体は毎フレーム set() で受ける — 大気パスが描く天体と同じ列である。
// **幾何学的な遮蔽はここでは扱わない** — 天体を貫通する経路の減衰は影パス(BodyShadow)が担い、
// ここが足すのは大気そのものによる消衰だけ(二重に数えない)。
import * as THREE from 'three/webgpu';
import { exp, uniformArray, vec3 } from 'three/tsl';
import { MAX_ATMOSPHERE_BODIES, type AtmosphereBody } from '../atmosphere';
import type { FloatNode, Vec3Node } from '../tsl-types';
import type { SunLight } from './sun-light';
import {
  polarStretchOf, sunPathDepth, sunPathGeometry, type SunPathAtmosphere,
} from './sun-path-depth';

// 空きスロットの散乱係数。
const ZERO_VECTOR = new THREE.Vector3();

export class SunExtinction {
  // 天体ごとの値。BodyShadow と同じく、uniform 配列の実体として JS 配列を持つ。
  private readonly centers: THREE.Vector3[];
  private readonly polarAxes: THREE.Vector3[];
  private readonly rayleighs: THREE.Vector3[];
  private readonly surfaceRadii: number[];
  private readonly polarStretches: number[];
  private readonly rayleighScaleHeights: number[];
  private readonly mies: number[];
  private readonly mieScaleHeights: number[];
  private readonly centerArray: THREE.UniformArrayNode<'vec3'>;
  private readonly polarAxisArray: THREE.UniformArrayNode<'vec3'>;
  private readonly rayleighArray: THREE.UniformArrayNode<'vec3'>;
  private readonly surfaceRadiusArray: THREE.UniformArrayNode<'float'>;
  private readonly polarStretchArray: THREE.UniformArrayNode<'float'>;
  private readonly rayleighScaleHeightArray: THREE.UniformArrayNode<'float'>;
  private readonly mieArray: THREE.UniformArrayNode<'float'>;
  private readonly mieScaleHeightArray: THREE.UniformArrayNode<'float'>;

  // 上限ぶんの uniform を確保する。件数は固定なので、大気を持つ天体が増減してもグラフの形は変わらない。
  public constructor(private readonly sunLight: SunLight) {
    this.centers = Array.from({ length: MAX_ATMOSPHERE_BODIES }, () => new THREE.Vector3());
    this.polarAxes = Array.from({ length: MAX_ATMOSPHERE_BODIES }, () => new THREE.Vector3(0, 1, 0));
    this.rayleighs = Array.from({ length: MAX_ATMOSPHERE_BODIES }, () => new THREE.Vector3());
    this.surfaceRadii = Array.from({ length: MAX_ATMOSPHERE_BODIES }, () => 0);
    this.polarStretches = Array.from({ length: MAX_ATMOSPHERE_BODIES }, () => 0);
    this.rayleighScaleHeights = Array.from({ length: MAX_ATMOSPHERE_BODIES }, () => 1);
    this.mies = Array.from({ length: MAX_ATMOSPHERE_BODIES }, () => 0);
    this.mieScaleHeights = Array.from({ length: MAX_ATMOSPHERE_BODIES }, () => 1);
    this.centerArray = uniformArray(this.centers, 'vec3');
    this.polarAxisArray = uniformArray(this.polarAxes, 'vec3');
    this.rayleighArray = uniformArray(this.rayleighs, 'vec3');
    this.surfaceRadiusArray = uniformArray(this.surfaceRadii, 'float');
    this.polarStretchArray = uniformArray(this.polarStretches, 'float');
    this.rayleighScaleHeightArray = uniformArray(this.rayleighScaleHeights, 'float');
    this.mieArray = uniformArray(this.mies, 'float');
    this.mieScaleHeightArray = uniformArray(this.mieScaleHeights, 'float');
  }

  // このフレームの直射光が抜ける大気の天体の列(大気パスと同じ列)。MAX_ATMOSPHERE_BODIES を
  // 超えた分は捨てる。空きスロットは散乱係数を 0 にする — 光学的厚みが 0 になり素通しへ倒れる。
  public set(bodies: readonly AtmosphereBody[]): void {
    for (const [i, rayleigh] of this.rayleighs.entries()) {
      const body = bodies[i];
      rayleigh.copy(body?.optics.rayleigh ?? ZERO_VECTOR);
      this.mies[i] = body?.optics.mie ?? 0;
      if (body === undefined) continue;
      this.centers[i]!.copy(body.center);
      this.surfaceRadii[i] = body.surfaceRadius;
      // **極軸は単位ベクトルでなければならない** — ノルムが 1 でないと扁平率の伸縮が二乗で過剰に掛かる。
      this.polarAxes[i]!.copy(body.polarAxis).normalize();
      this.polarStretches[i] = polarStretchOf(body.polarRatio);
      this.rayleighScaleHeights[i] = body.optics.rayleighScaleHeight;
      this.mieScaleHeights[i] = body.optics.mieScaleHeight;
    }
  }

  // 描画座標の点 worldPos へ届く恒星の直射光が残る割合 0..1 を、RGB ごとに返す。
  // 全スロットの exp(-光学的厚み) の積。空きスロットは散乱係数 0 → 厚み 0 = 素通しの 1 へ
  // 倒れるので、有効な数で回す必要が無い。スロット数はコンパイル時に固定なので JS で展開する。
  public transmittance(worldPos: Vec3Node): Vec3Node {
    let transmittance = vec3(1, 1, 1) as Vec3Node;
    for (let i = 0; i < MAX_ATMOSPHERE_BODIES; i++) {
      const slot = this.slotAt(i);
      const path = sunPathGeometry(worldPos, this.sunLight.position, slot);
      transmittance = transmittance.mul(exp(sunPathDepth(path, slot).negate())) as Vec3Node;
    }
    return transmittance;
  }

  // uniform 配列のスロット i ぶんを、共有の経路式が受ける形へ並べる。
  private slotAt(i: number): SunPathAtmosphere {
    return {
      center: this.centerArray.element(i),
      surfaceRadius: this.surfaceRadiusArray.element(i) as FloatNode,
      polarAxis: this.polarAxisArray.element(i),
      polarStretch: this.polarStretchArray.element(i) as FloatNode,
      rayleigh: this.rayleighArray.element(i),
      rayleighScaleHeight: this.rayleighScaleHeightArray.element(i) as FloatNode,
      mie: this.mieArray.element(i) as FloatNode,
      mieScaleHeight: this.mieScaleHeightArray.element(i) as FloatNode,
    };
  }
}
