// 惑星の環の帯が落とす影。描画座標の点へ恒星の直射光がどれだけ届くかを、帯を通る光路の減衰の
// TSL グラフとして返す。環を持つ天体 1 体ぶんの帯を毎フレーム set() で受ける。
import * as THREE from 'three/webgpu';
import {
  Fn, Loop, PI, abs, acos, and, clamp, dot, exp, float, greaterThan, length, max, min, select,
  sqrt, uniform, uniformArray,
} from 'three/tsl';
import type { FloatNode, Vec3Node, Vec3Uniform } from '../../tsl-types';
import type { SunLight } from '../sun-light';

// 環の帯の上限。登録上の最大は天王星の 13 帯なので、それを超えるスロットは常に空になる —
// 空きスロットもループを回るので、上限を上げると毎画素の演算が増える。
const MAX_RING_BANDS = 13;

// 環面と視線の交差判定が発散しないよう、環面と恒星方向のなす角の余弦へ入れる下限。
const RING_GRAZING_MIN = 0.015;

// 環の帯 1 本。半径は描画座標と同じメートル、tau は環面に垂直な光学的深さ。
export interface RingBand {
  readonly innerRadius: number;
  readonly outerRadius: number;
  readonly normalOpticalDepth: number;
}

// 半径 w の円盤のうち、半径座標が中心から u·w だけ離れた直線より内側にある面積の割合。
// u = -1 で 0、u = 0 で 0.5、u = +1 で 1。
const diskFractionBelow = Fn(([u]: readonly [FloatNode]) => {
  const safeU = clamp(u, -1, 1);
  return acos(safeU.negate()).add(safeU.mul(sqrt(max(float(1).sub(safeU.mul(safeU)), 0)))).div(PI);
});

// 点 p から恒星へ向かう視線が環の帯 (inner, outer) を横切るときの透過率。
//
// 恒星は円盤なので、帯の縁は 1 点の内外判定では決まらない。環面へ落ちる恒星円盤の footprint は
// 楕円で、その径方向の半幅 w は入射角の余弦 μ と、交点の径方向と恒星方向の環面内成分のなす角の
// 余弦 c から閉じた形で出る。帯の被覆率は「footprint のうち半径 outer より内側」から「inner より
// 内側」を引いた面積比。footprint の中では環の曲率を無視し、帯の縁を直線と見なす — どちらも
// w << r0 が成り立つ限り誤差は二次で消える。
const ringBandTransmittance = Fn((
  [p, sunDir, sunAngRadius, center, axis, inner, outer, tau, active]: readonly [Vec3Node, Vec3Node, FloatNode, Vec3Node, Vec3Node, FloatNode, FloatNode, FloatNode, FloatNode],
) => {
  const cosIncidence = dot(axis, sunDir);
  const grazingSafe = select(
    greaterThan(cosIncidence, 0), max(cosIncidence, RING_GRAZING_MIN), min(cosIncidence, -RING_GRAZING_MIN),
  );
  const mu = abs(grazingSafe);
  const planeDistance = dot(p.sub(center), axis).negate().div(grazingSafe);
  const toIntersection = p.add(sunDir.mul(planeDistance)).sub(center);
  const r0 = max(length(toIntersection), 1e-6);
  const radialDir = toIntersection.div(r0);
  // 恒星方向の環面内成分。μ = 1(真上から差す)では長さ 0 になるが、そのとき下の
  // (1/μ² − 1) が 0 なので c は結果に効かない。
  const inPlane = sunDir.sub(axis.mul(cosIncidence));
  const c = dot(inPlane.div(max(length(inPlane), 1e-9)), radialDir);
  // footprint の径方向の半幅。**RING_GRAZING_MIN の床が μ 経由でここにも効く** — 無ければ
  // 環が真横を向く構図で 1/μ² が発散し、環の影が画面全体を覆う。
  const w = max(sunAngRadius.mul(abs(planeDistance))
    .mul(sqrt(float(1).add(float(1).div(mu.mul(mu)).sub(1).mul(c.mul(c))))), 1e-6);
  const bandCoverage = diskFractionBelow(outer.sub(r0).div(w)).sub(diskFractionBelow(inner.sub(r0).div(w)));
  const coverage = select(
    and(greaterThan(planeDistance, 0), greaterThan(active, 0.5)), bandCoverage, float(0),
  );
  return exp(tau.div(mu).mul(coverage).negate());
});

export class RingShadow {
  private readonly center: Vec3Uniform;
  private readonly axis: Vec3Uniform;
  // 帯ごとの (inner, outer, tau, active)。
  private readonly bands: THREE.Vector4[];
  private readonly bandArray: THREE.UniformArrayNode<'vec4'>;

  // 上限ぶんの uniform を確保する。件数は固定なので、帯が増減してもグラフの形は変わらない。
  constructor(private readonly sunLight: SunLight) {
    this.center = uniform(new THREE.Vector3());
    this.axis = uniform(new THREE.Vector3(0, 1, 0));
    this.bands = Array.from({ length: MAX_RING_BANDS }, () => new THREE.Vector4());
    this.bandArray = uniformArray(this.bands, 'vec4');
  }

  // 影を落とす天体 1 体ぶんの帯。center/axis は描画座標、bands が空なら影は落ちない。
  set(center: THREE.Vector3, axis: THREE.Vector3, bands: readonly RingBand[]): void {
    this.center.value.copy(center);
    this.axis.value.copy(axis).normalize();
    // 帯ごとのスロットへ写し、余ったスロットは active で消す。
    for (const [i, slot] of this.bands.entries()) {
      const band = bands[i];
      if (band === undefined) {
        slot.w = 0;
        continue;
      }
      slot.set(band.innerRadius, band.outerRadius, band.normalOpticalDepth, 1);
    }
  }

  // このフレームに有効な帯が 1 本でもあるか。**スロットは先頭から詰めるので先頭だけ見れば足りる。**
  casts(): boolean { return this.bands[0]!.w > 0; }

  // 描画座標の点 worldPos へ、環の帯を通ってきた恒星の直射光が届く割合 0..1。
  //
  // **環そのものを描くフラグメントは源から外すこと** — 自分が乗っている帯の平面上に居るため、
  // 含めると自己遮蔽で刃こぼれする。
  transmittance(worldPos: Vec3Node): FloatNode {
    const sunDir = this.sunLight.directionFrom(worldPos);
    const sunAngRadius = this.sunLight.angularRadiusFrom(worldPos);
    // 空きスロットも畳み込む。active が 0 のスロットは被覆率 0 = 素通しの 1 を返す。
    return Fn(() => {
      const transmittance = float(1).toVar();
      Loop({ start: 0, end: MAX_RING_BANDS, type: 'int', condition: '<' }, ({ i }) => {
        const band = this.bandArray.element(i);
        transmittance.mulAssign(ringBandTransmittance(
          worldPos, sunDir, sunAngRadius, this.center, this.axis,
          band.x, band.y, band.z, band.w,
        ));
      });
      return transmittance;
    })();
  }
}
