// 天体が落とす影。描画座標の点へ恒星の直射光がどれだけ届くかを、天体を楕円体とみなした
// 透過率の TSL グラフとして返す。影を落とす天体は毎フレーム set() で受ける。
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, PI, abs, acos, asin, clamp, dot, float, greaterThan, length, lessThan, lessThanEqual, max, min,
  normalize, select, sqrt, uniform, uniformArray, vec3, vec4,
} from 'three/tsl';
import type { FloatNode, Mat4Node, Vec3Node } from '../../tsl-types';
import type { SunLight } from '../sun-light';

// 同時に影を落とす天体として扱える上限(グラフのスロット数)。
export const MAX_SHADOW_BODIES = 4;

// 影を落とす天体 1 体。center は描画座標、axes は天体固定の半軸 [m](半径 1 の球をこの 3 軸ぶん
// 伸ばした楕円体)、bodyFromWorld は描画座標のベクトルを天体固定の向きへ回す行列。真球は
// sphereShadowBody() で作る。
export interface ShadowBody {
  readonly center: THREE.Vector3;
  readonly axes: THREE.Vector3;
  readonly bodyFromWorld: THREE.Matrix4;
}

// 向きを持たない天体の姿勢。set は値を写すだけなので、全スロットで共有してよい。
const NO_ROTATION = new THREE.Matrix4();

// 空きスロットの半軸。
const ZERO_AXES = new THREE.Vector3();

// 中心 center(描画座標)・半径 radius [m] の真球として影を落とす天体。
export function sphereShadowBody(center: THREE.Vector3, radius: number): ShadowBody {
  return { center, axes: new THREE.Vector3(radius, radius, radius), bodyFromWorld: NO_ROTATION };
}

// 半径 r1・r2 の 2 円が中心距離 d で重なる面積(すべて同じ角度単位)。
const circleOverlapArea = Fn(([r1, r2, d]: readonly [FloatNode, FloatNode, FloatNode]) => {
  const safeD = max(d, 1e-12);
  const d1 = safeD.mul(safeD).sub(r2.mul(r2)).add(r1.mul(r1)).div(safeD.mul(2));
  const d2 = safeD.sub(d1);
  const lens = (r: FloatNode, h: FloatNode) => r.mul(r).mul(acos(clamp(h.div(max(r, 1e-12)), -1, 1)))
    .sub(h.mul(sqrt(max(r.mul(r).sub(h.mul(h)), 0))));
  const contained = PI.mul(min(r1, r2).mul(min(r1, r2)));
  return select(
    greaterThan(d, r1.add(r2)), float(0),
    select(lessThan(d, abs(r1.sub(r2))), contained, lens(r1, d1).add(lens(r2, d2))),
  );
});

// 点 p から見た光源円盤のうち、楕円体 (center, axes, bodyFromWorld) に遮られずに残る面積比 0..1。
// physics/shadow.ts の shadowedFraction と同じ式で、本影・金環・半影・完全日照が場合分け無しに
// 1つの閉じた形から出る。
//
// **角度は「天体固定の向きへ回して半軸で割った空間」で測る。** その空間では楕円体が半径 1 の球へ
// 戻るので、縁への接線条件が扁平な天体でも厳密に解ける — 日没は測地地平線(面の法線と恒星方向が
// 直交する瞬間)にちょうど重なり、緯度によって早まることも遅れることもない。光源の視半径だけは
// 描画座標のまま渡してよい: この写像が角度を伸縮させる幅は扁平率ぶん(地球 0.3%・土星 10%)で、
// 半影幅の決定にのみ限定的に寄与する。
//
// 表面より内側の受け手は表面に乗っているものとして扱う。天体は楕円体を折った多面体として描かれ、
// 深度から復元した位置も誤差を持つので、地表の画素は普通に楕円体の内側へ入る — そこを本影と
// 判じると、昼側の地表に真っ黒な斑が出る。
const ellipsoidTransmittance = Fn((
  [p, sourceDir, sourceDist, sourceAngRadius, center, axes, bodyFromWorld]: readonly [Vec3Node, Vec3Node, FloatNode, FloatNode, Vec3Node, Vec3Node, Mat4Node],
) => {
  const toCenter = center.sub(p);
  // 空きスロットの半軸 0 による除算を防ぐ下限ガード。実在天体の半軸スケール（km オーダー）では本ガードは作用しない。
  const safeAxes = max(axes, vec3(1));
  const local = bodyFromWorld.mul(vec4(toCenter.negate(), 0)).xyz.div(safeAxes);
  const sourceLocal = normalize(bodyFromWorld.mul(vec4(sourceDir, 0)).xyz.div(safeAxes));
  // 半径 1 の球から見た受け手の動径。1 で頭を打たせると、内側の受け手が表面の答えを受け取る。
  const radial = max(length(local), 1e-6);
  const bodyAngRadius = asin(clamp(float(1).div(max(radial, 1)), 0, 1));
  const separation = acos(clamp(dot(local.div(radial).negate(), sourceLocal), -1, 1));
  // 2 つの円板が離れていれば重なりは 0 なので、重なりの面積は円板が触れるときだけ解く。
  const lit = float(1).toVar();
  If(lessThanEqual(separation, sourceAngRadius.add(bodyAngRadius)), () => {
    const overlap = circleOverlapArea(sourceAngRadius, bodyAngRadius, separation);
    lit.assign(clamp(float(1).sub(overlap.div(PI.mul(sourceAngRadius).mul(sourceAngRadius))), 0, 1));
  });
  // 半軸 0 の空きスロットと、光源より遠い側にある天体。
  const outOfPlay = lessThan(max(max(axes.x, axes.y), axes.z), 1)
    .or(greaterThan(dot(toCenter, sourceDir), sourceDist));
  return select(outOfPlay, float(1), lit);
});

export class BodyShadow {
  // 天体ごとの値。動的な shader ループから uniform 配列で読む。
  private readonly centers: THREE.Vector3[];
  private readonly axes: THREE.Vector3[];
  private readonly bodyFromWorld: THREE.Matrix4[];
  private readonly centerArray: THREE.UniformArrayNode<'vec3'>;
  private readonly axesArray: THREE.UniformArrayNode<'vec3'>;
  private readonly bodyFromWorldArray: THREE.UniformArrayNode<'mat4'>;
  // 埋まっているスロットの数。スロットは先頭から詰める。
  private readonly count = uniform(0, 'int');

  // 上限ぶんの uniform を確保する。件数は固定なので、天体が増減してもグラフの形は変わらない。
  public constructor(private readonly sunLight: SunLight) {
    this.centers = Array.from({ length: MAX_SHADOW_BODIES }, () => new THREE.Vector3());
    this.axes = Array.from({ length: MAX_SHADOW_BODIES }, () => new THREE.Vector3());
    this.bodyFromWorld = Array.from({ length: MAX_SHADOW_BODIES }, () => new THREE.Matrix4());
    this.centerArray = uniformArray(this.centers, 'vec3');
    this.axesArray = uniformArray(this.axes, 'vec3');
    this.bodyFromWorldArray = uniformArray(this.bodyFromWorld, 'mat4');
  }

  // このフレームで影を落とす天体の列(描画座標)。MAX_SHADOW_BODIES を超えた分は捨てる。
  public set(bodies: readonly ShadowBody[]): void {
    this.count.value = Math.min(bodies.length, MAX_SHADOW_BODIES);
    for (const [i, axes] of this.axes.entries()) {
      const body = bodies[i];
      // 空きスロットは半軸 0 で消す — 実効半径が 0 になり、透過率がそのまま素通しへ倒れる。
      axes.copy(body?.axes ?? ZERO_AXES);
      if (body === undefined) continue;
      this.centers[i]!.copy(body.center);
      this.bodyFromWorld[i]!.copy(body.bodyFromWorld);
    }
  }

  // このフレームに影を落とす天体が 1 体でもあるか。**スロットは先頭から詰めるので先頭だけ見れば足りる。**
  public casts(): boolean { return this.axes[0]!.lengthSq() > 0; }

  // 描画座標の点 worldPos へ、天体を通ってきた恒星の直射光が届く割合 0..1。
  public transmittance(worldPos: Vec3Node): FloatNode {
    const sunDist = this.sunLight.distanceFrom(worldPos);
    const sunDir = this.sunLight.directionFrom(worldPos);
    const sunAngRadius = this.sunLight.angularRadiusFrom(worldPos);
    return this.diskTransmittance(
      worldPos, sunDir, sunDist, sunAngRadius, this.sunLight.position);
  }

  // 描画座標の点 worldPos へ、中心 sourceCenter・半径 sourceRadius [m] の面光源から届く光の
  // 割合 0..1(光源円盤のうち天体に遮られず残る面積比)。光源天体自身は遮蔽へ数えないので、
  // 天体照のように恒星以外の光源へも掛けられる。
  public transmittanceFrom(
    worldPos: Vec3Node, sourceCenter: Vec3Node, sourceRadius: FloatNode,
  ): FloatNode {
    const toSource = sourceCenter.sub(worldPos);
    const sourceDist = max(length(toSource), 1);
    const sourceDir = toSource.div(sourceDist);
    const sourceAngRadius = asin(clamp(sourceRadius.div(sourceDist), 1e-9, 1));
    return this.diskTransmittance(worldPos, sourceDir, sourceDist, sourceAngRadius, sourceCenter);
  }

  // worldPos から見た光源円盤の透過率を、影を落とす天体の列で畳み込んだ値。sourceCenter と
  // 同じ位置の天体は光源天体そのものとして畳み込まない — 光源天体の内側に居る受け手では、
  // その天体が光源円盤を覆い尽くして透過率が 0 へ落ちてしまう。
  private diskTransmittance(
    worldPos: Vec3Node, sourceDir: Vec3Node, sourceDist: FloatNode, sourceAngRadius: FloatNode,
    sourceCenter: Vec3Node,
  ): FloatNode {
    return Fn(() => {
      const transmittance = float(1).toVar();
      Loop({ start: 0, end: this.count, type: 'int', condition: '<' }, ({ i }) => {
        const center = this.centerArray.element(i);
        // 遮蔽器と光源へは同じ天体の同じ位置が置かれるので、光源天体の判定は中心が
        // 1 m 未満しか離れていないことで判じる。
        const isSource = lessThan(length(center.sub(sourceCenter)), float(1));
        transmittance.mulAssign(select(isSource, float(1), ellipsoidTransmittance(
          worldPos, sourceDir, sourceDist, sourceAngRadius,
          center, this.axesArray.element(i), this.bodyFromWorldArray.element(i),
        )));
      });
      return transmittance;
    })();
  }
}
