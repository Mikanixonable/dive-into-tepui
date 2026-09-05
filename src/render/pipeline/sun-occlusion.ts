// 恒星の直射光がどれだけ届くかを答える唯一の場。遮蔽するのは天体・惑星の環の帯・積雲の殻・
// シャドウアトラスへ描かれたメッシュで、源ごとに描画座標の点に対する透過率の TSL グラフを返す。
// **複数の源を合成するのは呼び出し側の仕事**で、遮蔽どうしに依存は無いので透過率の積で足りる。
// 遮蔽器・環の帯・積雲の殻は毎フレーム呼び出し側が渡す。
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, PI, abs, acos, and, asin, clamp, cos, dot, exp, float, fract, greaterThan, int, length,
  lessThan, log, log2, max, min, normalize, select, sin, sqrt, texture, uniform, uniformArray, vec2, vec3, vec4,
} from 'three/tsl';
import { sphereMeshUv } from '../celestial-surface';
import {
  CLOUD_TOP_UNCERTAINTY, CUMULUS_GRAIN_SIZE, cloudTopOf, grainAmplitudeForWidth, grainAt,
  opaqueFractionOf,
} from '../cloud/cumulus-shape';
import type {
  BoolNode, FloatNode, FloatUniform, Mat4Node, Mat4Uniform, Vec2Node, Vec3Node, Vec3Uniform, Vec4Node,
} from '../tsl-types';
import type { SunShadowMaps, SunShadowSlot } from './sun-shadow-maps';
import type { SunLight } from './sun-light';

// 同時に遮蔽器として扱う天体の上限(グラフのスロット数)。
export const MAX_OCCLUDERS = 4;

// 環の帯の上限。登録上の最大は天王星の 13 帯なので、それを超える
// スロットは常に空になる — グラフは静的に展開されるので、空きスロットも毎画素の演算を食う。
const MAX_RING_BANDS = 13;

// 環の帯 1 本。半径は描画座標と同じメートル、tau は環面に垂直な光学的深さ。
export interface RingBand {
  readonly innerRadius: number;
  readonly outerRadius: number;
  readonly normalOpticalDepth: number;
}

// 遮蔽する天体 1 体。center は描画座標、axes は天体固定の半軸 [m](半径 1 の球をこの 3 軸ぶん
// 伸ばした楕円体)、bodyFromWorld は描画座標のベクトルを天体固定の向きへ回す行列。真球は
// sphereOccluder() で作る。
export interface Occluder {
  readonly center: THREE.Vector3;
  readonly axes: THREE.Vector3;
  readonly bodyFromWorld: THREE.Matrix4;
}

// 向きを持たない遮蔽器の姿勢。setOccluders は値を写すだけなので、全スロットで共有してよい。
const NO_ROTATION = new THREE.Matrix4();

// 中心 center(描画座標)・半径 radius [m] の真球の遮蔽器。
export function sphereOccluder(center: THREE.Vector3, radius: number): Occluder {
  return { center, axes: new THREE.Vector3(radius, radius, radius), bodyFromWorld: NO_ROTATION };
}

// 積雲の殻 1 体ぶん。center は描画座標の天体中心、surfaceRadius は雲の高度の基準半径 [m]、
// axes は天体固定の半軸 [m]、topAltitude は殻の高さ [m]、bodyFromWorld は描画座標のベクトルを
// 天体固定の向きへ回す行列、field は雲の場(R = 被覆率、G = 雲頂高度 / topAltitude)。
export interface CumulusShadow {
  readonly center: THREE.Vector3;
  readonly surfaceRadius: number;
  readonly axes: THREE.Vector3;
  readonly topAltitude: number;
  readonly bodyFromWorld: THREE.Matrix4;
  readonly field: THREE.Texture;
}

interface OccluderUniforms {
  readonly center: Vec3Uniform;
  readonly axes: Vec3Uniform;
  readonly bodyFromWorld: Mat4Uniform;
}
// 環面と視線の交差判定が発散しないよう、環面と恒星方向のなす角の余弦へ入れる下限。
const RING_GRAZING_MIN = 0.015;

// 積雲の殻が落とす影を引くときの、光路のタップ数。
const CUMULUS_SHADOW_TAPS = 6;
// 光路をたどる長さの上限 [m]。恒星が地平線へ寄るほど層を抜けるまでの距離は伸び、昼夜境界の
// 真上で発散する。
const CUMULUS_MAX_LIGHT_PATH = 3e5;
// 覆われている割合から柱の光学的厚みへ直すときの上限。割合 1 では厚みが発散する。
const CUMULUS_MAX_COVERAGE = 0.99;
// 光路 1 歩が代表する幅を、場のぼかしへ何倍で写すか。**等倍では足りない** — 隣り合うタップの
// 覆う範囲が接するだけなので、あいだに影の抜けた縞が残る。
const CUMULUS_STEP_BLUR = 2;

// 雲の場を持たないフレームでも同じグラフが走るので、被覆率 0 の写しを結んでおく。
// **読み方の契約は本物の場と揃える** — グラフはここに結んだテクスチャのフィルタと巻きから
// 組まれるので、既定の Nearest のままだと補間の無い texel フェッチが焼き込まれ、あとで本物へ
// 差し替えても格子が出たままになる。
const EMPTY_CUMULUS_FIELD = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
EMPTY_CUMULUS_FIELD.minFilter = THREE.LinearMipmapLinearFilter;
EMPTY_CUMULUS_FIELD.magFilter = THREE.LinearFilter;
EMPTY_CUMULUS_FIELD.wrapS = THREE.RepeatWrapping;
EMPTY_CUMULUS_FIELD.needsUpdate = true;

// メッシュの影のバイアス。受け手をこれだけ法線方向へずらしてからライト空間へ写し、残りを
// 傾きに比例した深度バイアスで吸収する。単位はどちらもそのスロットの 1 texel。
const NORMAL_OFFSET_TEXELS = 1.5;
const MAX_SLOPE_BIAS_TEXELS = 8;

// メッシュの影のフィルタ。半径は半影の幅から決まり、この範囲へ収める(単位は texel)。
// タップは Vogel disk で散らす — 少ないタップでも規則的な縞にならない。
const PCF_TAPS = 12;
const PCF_MIN_TEXELS = 0.5;
const PCF_MAX_TEXELS = 8;
const VOGEL_GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// デバッグ表示「影スロット」がスロットへ割り当てる色。並びがスロット番号の順。
const SLOT_DEBUG_COLORS: readonly (readonly [number, number, number])[] = [
  [1, 0.25, 0.2], [0.3, 1, 0.35], [0.35, 0.5, 1], [1, 0.85, 0.25],
];

// 空きスロットの半軸。
const ZERO_AXES = new THREE.Vector3();

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

// 点 p から見た恒星円盤のうち、楕円体 (center, axes, bodyFromWorld) に遮られずに残る面積比 0..1。
// physics/shadow.ts の occludedFraction と同じ式で、本影・金環・半影・完全日照が場合分け無しに
// 1つの閉じた形から出る。
//
// **角度は「天体固定の向きへ回して半軸で割った空間」で測る。** その空間では楕円体が半径 1 の球へ
// 戻るので、縁への接線条件が扁平な天体でも厳密に解ける — 日没は測地地平線(面の法線と恒星方向が
// 直交する瞬間)にちょうど重なり、緯度によって早まることも遅れることもない。恒星の視半径だけは
// 描画座標のまま渡してよい: この写像が角度を伸縮させる幅は扁平率ぶん(地球 0.3%・土星 10%)で、
// 半影の幅にしか効かない。
//
// 表面より内側の受け手は表面に乗っているものとして扱う。天体は楕円体を折った多面体として描かれ、
// 深度から復元した位置も誤差を持つので、地表の画素は普通に楕円体の内側へ入る — そこを本影と
// 判じると、昼側の地表に真っ黒な斑が出る。
const ellipsoidTransmittance = Fn((
  [p, sunDir, sunDist, sunAngRadius, center, axes, bodyFromWorld]: readonly [Vec3Node, Vec3Node, FloatNode, FloatNode, Vec3Node, Vec3Node, Mat4Node],
) => {
  const toCenter = center.sub(p);
  // 空きスロットの半軸 0 で割らないための床。実在の遮蔽器の半軸は km の桁なので効かない。
  const safeAxes = max(axes, vec3(1));
  const local = bodyFromWorld.mul(vec4(toCenter.negate(), 0)).xyz.div(safeAxes);
  const sunLocal = normalize(bodyFromWorld.mul(vec4(sunDir, 0)).xyz.div(safeAxes));
  // 半径 1 の球から見た受け手の動径。1 で頭を打たせると、内側の受け手が表面の答えを受け取る。
  const radial = max(length(local), 1e-6);
  const occAngRadius = asin(clamp(float(1).div(max(radial, 1)), 0, 1));
  const separation = acos(clamp(dot(local.div(radial).negate(), sunLocal), -1, 1));
  const overlap = circleOverlapArea(sunAngRadius, occAngRadius, separation);
  const lit = clamp(float(1).sub(overlap.div(PI.mul(sunAngRadius).mul(sunAngRadius))), 0, 1);
  // 半軸 0 の空きスロットと、恒星より遠い側にある天体。
  const outOfPlay = lessThan(max(max(axes.x, axes.y), axes.z), 1)
    .or(greaterThan(dot(toCenter, sunDir), sunDist));
  return select(outOfPlay, float(1), lit);
});

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

export class SunOcclusion {
  private readonly occluders: readonly OccluderUniforms[];
  private readonly ringCenter: Vec3Uniform;
  private readonly ringAxis: Vec3Uniform;
  // 帯ごとの (inner, outer, tau, active)。書き換える配列から描画時に uniform 配列へ詰め直す。
  private readonly ringBands: THREE.Vector4[];
  private readonly ringBandArray: THREE.UniformArrayNode<'vec4'>;
  private readonly cumulusCenter: Vec3Uniform;
  private readonly cumulusSurfaceRadius: FloatUniform;
  private readonly cumulusAxes: Vec3Uniform;
  private readonly cumulusTopAltitude: FloatUniform;
  private readonly cumulusBodyFromWorld: Mat4Uniform;
  private readonly cumulusActive: FloatUniform;
  // 雲の場。setCumulusShadow が value を差し替えると、sample() で枝分かれした先へも同じ写しが届く。
  private readonly cumulusField = texture(EMPTY_CUMULUS_FIELD);

  // 遮蔽器と環の帯ぶんの uniform を確保する。件数は固定なので、遮蔽器や帯が増減しても
  // 返す透過率のグラフの形は変わらない。
  constructor(
    private readonly sunLight: SunLight,
    private readonly shadowMaps: SunShadowMaps,
  ) {
    this.occluders = Array.from({ length: MAX_OCCLUDERS }, () => ({
      center: uniform(new THREE.Vector3()),
      axes: uniform(new THREE.Vector3()),
      bodyFromWorld: uniform(new THREE.Matrix4()),
    }));
    this.ringCenter = uniform(new THREE.Vector3());
    this.ringAxis = uniform(new THREE.Vector3(0, 1, 0));
    this.ringBands = Array.from({ length: MAX_RING_BANDS }, () => new THREE.Vector4());
    this.ringBandArray = uniformArray(this.ringBands, 'vec4');
    this.cumulusCenter = uniform(new THREE.Vector3());
    this.cumulusSurfaceRadius = uniform(0);
    // 場を持たないフレームでも殻の空間への写しは走るので、半軸は 0 で割らない値から始める。
    this.cumulusAxes = uniform(new THREE.Vector3(1, 1, 1));
    this.cumulusTopAltitude = uniform(0);
    this.cumulusBodyFromWorld = uniform(new THREE.Matrix4());
    this.cumulusActive = uniform(0);
  }

  // このフレームで遮蔽器として扱う天体の列(描画座標)。MAX_OCCLUDERS を超えた分は捨てる。
  setOccluders(occluders: readonly Occluder[]): void {
    for (const [i, slot] of this.occluders.entries()) {
      const occluder = occluders[i];
      // 空きスロットは半軸 0 で消す — 実効半径が 0 になり、遮蔽関数がそのまま素通しへ倒す。
      slot.axes.value.copy(occluder?.axes ?? ZERO_AXES);
      if (occluder === undefined) continue;
      slot.center.value.copy(occluder.center);
      slot.bodyFromWorld.value.copy(occluder.bodyFromWorld);
    }
  }

  // このフレームに遮蔽器が 1 体でもあるか。**スロットは先頭から詰めるので先頭だけ見れば足りる。**
  hasOccluders(): boolean { return this.occluders[0]!.axes.value.lengthSq() > 0; }

  // 環の影を落とす天体 1 体ぶんの帯。center/axis は描画座標、bands が空なら影は落ちない。
  setRings(center: THREE.Vector3, axis: THREE.Vector3, bands: readonly RingBand[]): void {
    this.ringCenter.value.copy(center);
    this.ringAxis.value.copy(axis).normalize();
    // 帯ごとのスロットへ写し、余ったスロットは active で消す。
    for (const [i, slot] of this.ringBands.entries()) {
      const band = bands[i];
      if (band === undefined) {
        slot.w = 0;
        continue;
      }
      slot.set(band.innerRadius, band.outerRadius, band.normalOpticalDepth, 1);
    }
  }

  // このフレームに有効な帯が 1 本でもあるか。**スロットは先頭から詰めるので先頭だけ見れば足りる。**
  hasRingShadow(): boolean { return this.ringBands[0]!.w > 0; }

  // 積雲の殻が落とす影を、このフレームの 1 体ぶんへ置き直す。null なら雲の影は落ちない。
  setCumulusShadow(shadow: CumulusShadow | null): void {
    this.cumulusActive.value = shadow === null ? 0 : 1;
    if (shadow === null) return;
    this.cumulusCenter.value.copy(shadow.center);
    this.cumulusSurfaceRadius.value = shadow.surfaceRadius;
    this.cumulusAxes.value.copy(shadow.axes);
    this.cumulusTopAltitude.value = shadow.topAltitude;
    this.cumulusBodyFromWorld.value.copy(shadow.bodyFromWorld);
    this.cumulusField.value = shadow.field;
  }

  // このフレームに積雲の殻の影があるか。
  hasCumulusShadow(): boolean { return this.cumulusActive.value > 0; }

  // このフレームにメッシュの影があるか。
  hasMeshShadow(): boolean {
    return this.shadowMaps.slots.some((slot) => slot.active.value > 0);
  }

  // 受け手から恒星の中心までの距離 [m]。恒星の只中で 0 除算にならない床を張る。
  private sunDistance(worldPos: Vec3Node): FloatNode {
    return max(length(this.sunLight.position.sub(worldPos)), 1);
  }

  // 受け手から見た恒星の方向。
  private sunDirection(worldPos: Vec3Node): Vec3Node {
    return normalize(this.sunLight.position.sub(worldPos));
  }

  // 受け手から見た恒星の視半径 [rad]。半影の幅はこれに遮蔽器までの距離を掛けたものになる。
  private sunAngularRadius(worldPos: Vec3Node): FloatNode {
    return asin(clamp(this.sunLight.radius.div(this.sunDistance(worldPos)), 1e-9, 1));
  }

  // 描画座標の点 worldPos へ、遮蔽器の天体を通ってきた恒星の直射光が届く割合 0..1。
  occluderTransmittance(worldPos: Vec3Node): FloatNode {
    const sunDist = this.sunDistance(worldPos);
    const sunDir = this.sunDirection(worldPos);
    const sunAngRadius = this.sunAngularRadius(worldPos);
    // 空きスロットも畳み込む。半軸 0 のスロットは素通しの 1 を返すので、有効な数で回す必要が無い。
    let transmittance: FloatNode = float(1);
    for (const occluder of this.occluders) {
      transmittance = transmittance.mul(
        ellipsoidTransmittance(
          worldPos, sunDir, sunDist, sunAngRadius, occluder.center, occluder.axes,
          occluder.bodyFromWorld,
        ),
      );
    }
    return transmittance;
  }

  // 描画座標の点 worldPos へ、環の帯を通ってきた恒星の直射光が届く割合 0..1。
  //
  // **環そのものを描くフラグメントは源から外すこと** — 自分が乗っている帯の平面上に居るため、
  // 含めると自己遮蔽で刃こぼれする。
  ringTransmittance(worldPos: Vec3Node): FloatNode {
    const sunDir = this.sunDirection(worldPos);
    const sunAngRadius = this.sunAngularRadius(worldPos);
    // 空きスロットも畳み込む。active が 0 のスロットは被覆率 0 = 素通しの 1 を返す。
    return Fn(() => {
      const transmittance = float(1).toVar();
      Loop({ start: 0, end: MAX_RING_BANDS, type: 'int', condition: '<' }, ({ i }) => {
        const band = this.ringBandArray.element(i);
        transmittance.mulAssign(ringBandTransmittance(
          worldPos, sunDir, sunAngRadius, this.ringCenter, this.ringAxis,
          band.x, band.y, band.z, band.w,
        ));
      });
      return transmittance;
    })();
  }

  // 積雲の殻が落とす影。受け手から恒星へ向かう光路を、雲の層(地表から殻の上端まで)を抜けるまで
  // 殻の空間(toShellSpace)でたどり、柱の雲頂より下を通る割合ぶんの消散を積む。
  //
  // 柱の光学的厚みは、覆われた割合 c を通り抜けない確率と読んで τ = −ln(1 − c) と取る。割合は殻が
  // 雲を立てるのと同じ規則(cloud/cumulus-shape.ts)から引くので、影は殻のシルエットの下へ落ちる。
  // 厚みは光路長ではなく稼いだ高度で配るので、柱を 1 本抜ける合計はどれだけ斜めでも τ に一致する。
  // 受け手が自分の柱の雲頂の高さにいるときは、その柱で自分を陰らせない(receiverFloorAltitude)。
  // footprint は受け手の位置で画面 1 px が張る実寸 [m] で、場を引く mip 段と粒の振幅を決める。
  cumulusTransmittance(worldPos: Vec3Node, footprint: FloatNode): FloatNode {
    const sunDir = this.sunDirection(worldPos);
    return Fn(() => {
      const transmittance = float(1).toVar();
      // 場を持たないフレームで、タップぶんのフェッチを丸ごと飛ばす。
      If(greaterThan(this.cumulusActive, 0.5), () => {
        const bodyRadius = max(this.cumulusSurfaceRadius, 1);
        const offset = this.toShellSpace(worldPos.sub(this.cumulusCenter));
        // **光路の向きも殻の空間で取り直す** — 半軸で割ると向きが傾くので、描画座標の恒星方向を
        // そのまま使うと、光路が層を斜めに横切る量が緯度ぶんずれる。
        const rayDir = normalize(this.toShellSpace(sunDir));
        // 殻の上端の半径。地表が 1 なので、高さは基準半径で割った目盛りで乗る。
        const shellRadius = float(1).add(this.cumulusTopAltitude.div(bodyRadius));
        const along = dot(offset, rayDir);
        // 光路が殻を出るまでの距離。殻より上の受け手では負になり、影は落ちない。長さは殻の空間の
        // 半径 1 を基準半径として測る(真の実寸との差は扁平率ぶんで、mip 段と上限にしか効かない)。
        const exit = sqrt(max(shellRadius.mul(shellRadius).sub(dot(offset, offset)).add(along.mul(along)), 0))
          .sub(along).mul(bodyRadius);
        const stepLength = clamp(exit, 0, CUMULUS_MAX_LIGHT_PATH).div(CUMULUS_SHADOW_TAPS);
        // タップ 1 回が代表する実寸。**歩がまたいだ柱は 1 タップが代表する**ので、画面 1 px の
        // 実寸と光路 1 歩の長さのうち粗いほうを取る。場の mip 段も粒の振幅もこの幅が決める。
        const sampleWidth = max(footprint, stepLength.mul(CUMULUS_STEP_BLUR));
        const lod = this.cumulusFieldLod(sampleWidth);
        const grainAmplitude = grainAmplitudeForWidth(sampleWidth).toVar();
        const grainFrequency = bodyRadius.div(CUMULUS_GRAIN_SIZE);
        const floorAltitude = this.receiverFloorAltitude(offset, lod, bodyRadius);
        const stepRadius = stepLength.div(bodyRadius);
        const opticalDepth = float(0).toVar();
        Loop({ start: 0, end: CUMULUS_SHADOW_TAPS, type: 'int', condition: '<' }, ({ i }) => {
          const sampleOffset = offset.add(rayDir.mul(stepRadius.mul(float(i).add(0.5))));
          const sampleRadius = max(length(sampleOffset), 1e-6);
          const up = sampleOffset.div(sampleRadius);
          const altitude = max(sampleRadius.sub(1).mul(bodyRadius), floorAltitude);
          const cloud = this.cumulusFieldAt(up, lod);
          // 粒は引けるときだけ引く。タップの数だけノイズを引くので、振幅が 0 になる遠さでは分岐ごと
          // 飛ばして費用を戻す(select では両辺が評価されて飛ばない)。
          const grain = float(0).toVar();
          If(greaterThan(grainAmplitude, 0), () => {
            grain.assign(grainAt(up, grainFrequency, grainAmplitude));
          });
          const cloudTop = cloudTopOf(cloud.g, grain).mul(this.cumulusTopAltitude);
          const rise = max(dot(rayDir, up), 0).mul(stepLength);
          const columnDepth = log(min(
            opaqueFractionOf(cloud.r, grain), CUMULUS_MAX_COVERAGE).oneMinus()).negate();
          // **1 歩が雲頂をまたぐ割合で配る** — 雲頂の内外を 1 点で判じると、歩の数だけの段に
          // 割れた縞が影に出る。タップは歩の中点なので、稼いだ高度の半分が前後に広がる。
          const inside = clamp(cloudTop.sub(altitude).div(max(rise, 1)).add(0.5), 0, 1);
          opticalDepth.addAssign(columnDepth.mul(rise).mul(inside).div(max(cloudTop, 1)));
        });
        transmittance.assign(exp(opticalDepth.negate()));
      });
      return transmittance;
    })();
  }

  // 描画座標のベクトルを、殻が雲を立てるのと同じ空間へ写す — 地表が半径 1、雲頂が半径
  // 1 + 雲頂高度 / 基準半径 の球面に乗る空間。天体固定の向きへ回してから半軸で割る。
  // 真球のつもりで中心距離から高度を測ると、扁平な天体では緯度ぶんの下駄が乗る(地球なら極で
  // 21 km — 雲の層 15 km より厚いので、極の雲頂が自分の柱の内側に沈み、恒星の向きによらず影になる)。
  private toShellSpace(worldVec: Vec3Node): Vec3Node {
    return this.cumulusBodyFromWorld.mul(vec4(worldVec, 0)).xyz.div(this.cumulusAxes);
  }

  // 場を引く mip 段。タップ 1 回が代表する実寸 sampleWidth [m] を、場の texel が覆う実寸と比べて
  // 決める。texel の実寸は正距円筒に固有の式で、赤道の 1 行(2πR を幅で割る)を基準に取る — 極では
  // 1 texel の経度方向の実寸がこれより cos(緯度) ぶん狭いので、段はそのぶん細かい側へ寄る。
  private cumulusFieldLod(sampleWidth: FloatNode): FloatNode {
    // 寸法を返すノードは型引数を持たないので、成分を取れる形へ直してから読む。
    const fieldWidth = (this.cumulusField.size(int(0)) as THREE.Node<'uvec2'>).x;
    const texelWorld = this.cumulusSurfaceRadius.mul(2 * Math.PI).div(float(fieldWidth));
    return max(log2(sampleWidth.div(max(texelWorld, 1))), 0);
  }

  // 殻の空間の単位方向 up における場を、mip 段を指定して引く。段を明示で渡すのは、光路のタップの
  // uv が画面の隣の画素と続いておらず、画面微分から選ばれる段が当てにならないため。uv は殻が読むのと
  // 同じ球メッシュの uv(sphereMeshUv)で引く — 別の規則で読むと、影が雲のシルエットから外れる。
  private cumulusFieldAt(up: Vec3Node, lod: FloatNode): Vec4Node {
    const uv = sphereMeshUv(up);
    return this.cumulusField.sample(vec2(fract(uv.x), uv.y)).level(lod);
  }

  // 光路のタップの高度に張る床 [m]。受け手が自分の柱の雲頂の高さにあるなら、その雲頂の高さ。
  // offset は天体中心から受け手へのベクトル(殻の空間)、bodyRadius は殻の空間の半径 1 が
  // 張る高度の目盛り [m]。
  private receiverFloorAltitude(offset: Vec3Node, lod: FloatNode, bodyRadius: FloatNode): FloatNode {
    const radius = max(length(offset), 1e-6);
    const altitude = max(radius.sub(1), 0).mul(bodyRadius);
    const top = this.cumulusFieldAt(offset.div(radius), lod).g.mul(this.cumulusTopAltitude);
    const uncertainty = this.cumulusTopAltitude.mul(CLOUD_TOP_UNCERTAINTY);
    return select(greaterThan(altitude, top.sub(uncertainty)), top, float(0));
  }

  // 描画座標の点が、そのスロットの柱(枠 × [near, near + coverDepth])に入っているか。枠はフィルタの
  // 足のぶんだけ狭めて判定するので、選んだ時点で法線オフセットぶんずらした位置も PCF の円盤も
  // 枠の内側に収まり、引く側で縁を判じずに済む。
  private slotCovers(slot: SunShadowSlot, worldPos: Vec3Node): BoolNode {
    const margin = this.shadowMaps.uvPerTexel.mul(NORMAL_OFFSET_TEXELS + PCF_MAX_TEXELS);
    const inner = float(1).sub(margin);
    const uv = this.slotUv(slot, worldPos);
    const depth = this.slotDepth(slot, worldPos);
    return greaterThan(slot.active, 0.5)
      .and(uv.x.greaterThan(margin)).and(uv.x.lessThan(inner))
      .and(uv.y.greaterThan(margin)).and(uv.y.lessThan(inner))
      .and(depth.greaterThan(0)).and(depth.lessThan(slot.coverDepth));
  }

  // 描画座標の点を、そのスロットの深度マップの UV へ写す。**深度マップの v は上端が 0** —
  // 描いたとき NDC y=+1 の画素がテクスチャの 0 行目へ落ちるので、x と揃えて 0.5·y+0.5 に
  // すると鏡像になり、遮蔽器のシルエットが鏡に映した位置へ出る。
  private slotUv(slot: SunShadowSlot, worldPos: Vec3Node): Vec2Node {
    const clip = slot.lightViewProjection.mul(vec4(worldPos, 1));
    const ndc = clip.xyz.div(clip.w);
    return vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5));
  }

  // 描画座標の点の、そのスロットの near から測ったライト空間深度 [m]。深度マップの値と同じ単位。
  private slotDepth(slot: SunShadowSlot, worldPos: Vec3Node): FloatNode {
    return slot.lightView.mul(vec4(worldPos, 1)).z.negate().sub(slot.near);
  }

  // 描画座標の点を覆うスロットのうち、texel がいちばん細かいものの番号。どれも覆っていなければ
  // −1。**どのスロットも自分の枠の遮蔽器をすべて持つので、どれを選んでも答えは正しい** —
  // 細かいほうが影の形をよく表すというだけの基準である。
  private selectSlot(worldPos: Vec3Node): FloatNode {
    return Fn(() => {
      const bestTexel = float(0).toVar();
      const bestIndex = float(-1).toVar();
      // 覆っていて、いままでより texel が細かいスロットへ乗り換える。
      for (const [index, slot] of this.shadowMaps.slots.entries()) {
        const finer = bestIndex.lessThan(0).or(slot.texelWorld.lessThan(bestTexel));
        If(this.slotCovers(slot, worldPos).and(finer), () => {
          bestTexel.assign(slot.texelWorld);
          bestIndex.assign(index);
        });
      }
      return bestIndex;
    })();
  }

  // デバッグ表示「影スロット」の色。選ばれたスロットの色で、どれも覆っていなければ黒。
  slotDebugColor(worldPos: Vec3Node): Vec3Node {
    return Fn(() => {
      const selected = this.selectSlot(worldPos);
      const color = vec3(0, 0, 0).toVar();
      for (const [index, tint] of SLOT_DEBUG_COLORS.entries()) {
        If(selected.equal(index), () => { color.assign(vec3(...tint)); });
      }
      return color;
    })();
  }

  // シャドウアトラスへ描かれたメッシュが落とす影。選んだ 1 スロットだけを引く — 透過率は恒星円盤の
  // 遮られずに残る面積比なので、枠の重なったスロットの答えを掛け合わせると同じ遮蔽器の半影が二重に
  // 濃くなる。判定を select ではなく If で書き、選ぶ段と引く段を分けるのは、虚空の画素からテクスチャ
  // フェッチを消すため(select は両辺を評価する)。normal は受け手の面の法線で、バイアスを
  // 法線方向のオフセットで入れるために要る。
  meshTransmittance(worldPos: Vec3Node, normal: Vec3Node): FloatNode {
    const sunDir = this.sunDirection(worldPos);
    // 恒星の視半径。半影の幅はここに遮蔽器までの距離を掛けたものになる。
    const sunAngRadius = this.sunLight.radius.div(this.sunDistance(worldPos));
    return Fn(() => {
      const selected = this.selectSlot(worldPos);
      const visibility = float(1).toVar();
      for (const [index, slot] of this.shadowMaps.slots.entries()) {
        If(selected.equal(index), () => {
          visibility.assign(this.slotVisibility(slot, worldPos, normal, sunDir, sunAngRadius));
        });
      }
      return visibility;
    })();
  }

  // スロット 1 つぶんの可視率。近層はブロッカー探索 1 タップで半影の幅を決め、その半径の
  // Vogel disk で PCF する。遠層のぶんは distantVisibility が返す。
  private slotVisibility(
    slot: SunShadowSlot, worldPos: Vec3Node, normal: Vec3Node, sunDir: Vec3Node, sunAngRadius: FloatNode,
  ): FloatNode {
    const texel = slot.texelWorld;
    // バイアスは 2 段構え。**無次元の定数は使えない** — スロットの広がりがフレームごとに
    // 変わるので、texel の実寸を単位に取る。法線方向のオフセットで受け手を遮蔽器から離し、
    // 残りを傾きに比例した深度バイアスで吸収する。
    const nDotL = clamp(dot(normal, sunDir), 1e-3, 1);
    const slope = sqrt(float(1).sub(nDotL.mul(nDotL))).div(nDotL);
    const offsetPos = worldPos.add(normal.mul(texel.mul(NORMAL_OFFSET_TEXELS)));
    const depthBias = min(texel.mul(slope).mul(2), texel.mul(MAX_SLOPE_BIAS_TEXELS));

    const uvBase = this.slotUv(slot, offsetPos);
    const receiverDepth = this.slotDepth(slot, offsetPos);

    // 半影の幅を物理から出す。遮蔽器までの距離 (receiver − blocker) に恒星の視半径を掛けたものが
    // world 空間での半径で、それを texel へ直す。1 タップの探索は探索半径の外の遮蔽器を見逃す
    // (PCSS の既知の限界)ので細い部材の影の縁は硬いまま残るが、画面上 2px の差なので許容する。
    const blockerDepth = texture(slot.texture, uvBase).r;
    const blockerDistance = max(receiverDepth.sub(blockerDepth), 0);
    const radiusTexels = clamp(sunAngRadius.mul(blockerDistance).div(texel), PCF_MIN_TEXELS, PCF_MAX_TEXELS);
    // 遮蔽器から遠ざかるほど本影は細り、遮蔽器の角半径が恒星の角半径を下回ると影は消える。
    // 遮られる面積比は (遮蔽器の角半径 / 恒星の角半径)² で落ちる。**PCF は半影の広がりを
    // PCF_MAX_TEXELS で頭打ちにするのでこの減衰を再現できない** — 解析で掛ける。遮蔽器の
    // 差し渡しは枠の 1 辺で代用する(枠は遮蔽器の箱へ密着しているので、単独の枠では実寸に近い)。
    const casterSize = texel.mul(this.shadowMaps.texelsPerSlot);
    const shrink = casterSize.div(max(sunAngRadius.mul(blockerDistance).mul(2), 1e-9));
    const umbraFade = min(shrink.mul(shrink), 1);

    const step = radiusTexels.mul(this.shadowMaps.uvPerTexel);
    const lit = float(0).toVar();
    Loop({ start: 0, end: PCF_TAPS, type: 'int', condition: '<' }, ({ i }) => {
      // Vogel disk: 黄金角で回しながら sqrt で半径を振ると、円盤上へ均等に散る。
      const tap = float(i);
      const angle = tap.mul(VOGEL_GOLDEN_ANGLE);
      const spread = sqrt(tap.add(0.5).div(PCF_TAPS));
      const uv = uvBase.add(vec2(cos(angle).mul(spread), sin(angle).mul(spread)).mul(step));
      const stored = texture(slot.texture, uv).r;
      lit.addAssign(select(receiverDepth.sub(depthBias).greaterThan(stored), float(0), float(1)));
    });
    const visibility = float(1).sub(float(1).sub(lit.div(PCF_TAPS)).mul(umbraFade));
    const distantVisibility = this.distantVisibility(slot, uvBase, receiverDepth.sub(depthBias), casterSize, sunAngRadius);
    // 法線オフセットが受け手を光源側へ押し出し、柱の手前へ抜けることがある。そこは遮られない。
    return select(receiverDepth.lessThan(0), float(1), visibility.mul(distantVisibility));
  }

  // 遠層に写った遮蔽器が残す可視率。近層と遠層に同じ遮蔽器が写ることはないので、2 つの可視率は
  // そのまま掛けられる。遠層に居るのは本影を失った遮蔽器だけで半影の幅は枠の 1 辺以上あるので、
  // PCF は要らず、遮られる面積比 (遮蔽器の角半径 / 恒星の角半径)² を 1 タップから返す。
  private distantVisibility(
    slot: SunShadowSlot, uv: Vec2Node, receiverDepth: FloatNode, casterSize: FloatNode,
    sunAngRadius: FloatNode,
  ): FloatNode {
    const blockerDepth = texture(slot.farTexture, uv).r;
    const blockerDistance = receiverDepth.sub(blockerDepth);
    const shrink = casterSize.div(max(sunAngRadius.mul(blockerDistance).mul(2), 1e-9));
    // 遮蔽器の居ない texel は受け手より奥の深度で埋まっているので、そのまま素通しになる。
    return select(blockerDistance.greaterThan(0), float(1).sub(min(shrink.mul(shrink), 1)), float(1));
  }
}
