// 恒星の直射光がどれだけ届くかを答える唯一の場。transmittance() が描画座標の点に対する透過率の
// TSL グラフを返す。遮蔽するのは天体の球・惑星の環の帯・積雲の殻・シャドウアトラスへ描かれた
// メッシュで、複数の遮蔽は透過率の積で合成する。遮蔽器・環の帯・積雲の殻は毎フレーム呼び出し
// 側が渡す。
import * as THREE from 'three/webgpu';
import {
  Fn, If, PI, abs, acos, and, asin, clamp, dot, exp, float, fract, greaterThan, int, length,
  lessThan, log, log2, max, min, normalize, select, sqrt, texture, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { sphereMeshUv } from '../celestial-surface';
import { CLOUD_TOP_UNCERTAINTY, meanOpaqueFractionOf } from '../cloud/cumulus-shape';
import type {
  BoolNode, FloatNode, FloatUniform, Mat4Uniform, Vec2Node, Vec3Node, Vec3Uniform, Vec4Node,
} from '../tsl-types';
import type { SunShadowMaps, SunShadowSlot } from './sun-shadow-maps';
import type { SunLight } from './sun-light';

export const MAX_OCCLUDERS = 4;

// 環の帯の上限。登録上の最大は天王星の 13 帯なので、それを超える
// スロットは常に空になる — グラフは静的に展開されるので、空きスロットも毎画素の演算を食う。
const MAX_RING_BANDS = 13;

// 環の帯 1 本。半径は描画座標と同じメートル、tau は環面に垂直な光学的深さ。
export type RingBand = {
  readonly innerRadius: number;
  readonly outerRadius: number;
  readonly normalOpticalDepth: number;
};

// 遮蔽する天体 1 体。中心は描画座標。
export type Occluder = {
  readonly center: THREE.Vector3;
  readonly radius: number;
};

// 積雲の殻 1 体ぶん。center は描画座標の天体中心、surfaceRadius は雲の高度の基準となる半径 [m]、
// topAltitude は殻の高さ [m]、bodyFromWorld は描画座標のベクトルを天体固定の向きへ回す行列、
// field は雲の場(R = 被覆率、G = 雲頂高度 / topAltitude)。
export type CumulusShadow = {
  readonly center: THREE.Vector3;
  readonly surfaceRadius: number;
  readonly topAltitude: number;
  readonly bodyFromWorld: THREE.Matrix4;
  readonly field: THREE.Texture;
};

// グラフへ畳み込む遮蔽源の選択。TSL のグラフは静的に展開されるので実行時の分岐にはできず、
// 受け手ごとに要る源が違う(環は自分の帯を外す必要がある)ため、構築時に呼び出し側が決める。
type OcclusionSources = {
  readonly rings: boolean;
  // 艦艇・基地・デブリなどのメッシュ。**真偽ではなく受け手の法線で選ぶ** — バイアスを法線方向の
  // オフセットで入れるので法線が要り、型の側で「法線を持たずにこの源を選ぶ」を塞ぐ。
  readonly meshNormal: Vec3Node | null;
  // 受け手がその表面に乗っている天体(中心距離が半径に一致する遮蔽器)を外すための、受け手
  // までの視距離。表面の自己遮蔽は N·L と光源の積分が表すので、ここでも数えると終端が二重に
  // 暗くなる。一致の公差を深度からの位置復元の誤差から取るために視距離が要る。null なら
  // 外さない(環・大気の受け手は天体表面の陰影を持たない)。
  readonly selfViewDistance: FloatNode | null;
  // 積雲の殻が落とす影を数えるなら、受け手の位置で画面 1 px が張る実寸 [m]。**真偽ではなく
  // 実寸で選ぶ** — 場を引く mip 段をここから決めるので、型の側で「実寸を持たずにこの源を
  // 選ぶ」を塞ぐ。null なら数えない。
  readonly cumulusFootprint: FloatNode | null;
};

type OccluderUniforms = { readonly center: Vec3Uniform; readonly radius: FloatUniform };
type RingBandUniforms = {
  readonly inner: FloatUniform;
  readonly outer: FloatUniform;
  readonly tau: FloatUniform;
  readonly active: FloatUniform;
};

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

// 半径 r1・r2 の 2 円が中心距離 d で重なる面積(すべて同じ角度単位)。
const circleOverlapArea = Fn(([r1, r2, d]: readonly FloatNode[]) => {
  const safeD = max(d!, 1e-12);
  const d1 = safeD.mul(safeD).sub(r2!.mul(r2!)).add(r1!.mul(r1!)).div(safeD.mul(2));
  const d2 = safeD.sub(d1);
  const lens = (r: FloatNode, h: FloatNode) => r.mul(r).mul(acos(clamp(h.div(max(r, 1e-12)), -1, 1)))
    .sub(h.mul(sqrt(max(r.mul(r).sub(h.mul(h)), 0))));
  const contained = PI.mul(min(r1!, r2!).mul(min(r1!, r2!)));
  return select(
    greaterThan(d!, r1!.add(r2!)), float(0),
    select(lessThan(d!, abs(r1!.sub(r2!))), contained, lens(r1!, d1).add(lens(r2!, d2))),
  );
});

// 点 p から見た恒星円盤のうち、球 (center, radius) に遮られずに残る面積比 0..1。
// physics/shadow.ts の occludedFraction と同じ式で、本影・金環・半影・完全日照が
// 場合分け無しに1つの閉じた形から出る。selfTolerance は「受け手がこの球の表面に乗って
// いる」と見なす中心距離と半径の差の公差で、0 なら乗っていても外さない。
const sphereTransmittance = Fn((
  [p, sunDir, sunDist, sunAngRadius, center, radius, selfTolerance]: readonly [Vec3Node, Vec3Node, FloatNode, FloatNode, Vec3Node, FloatNode, FloatNode],
) => {
  const toCenter = center.sub(p);
  const along = dot(toCenter, sunDir);
  const dist = max(length(toCenter), 1e-6);
  const occAngRadius = asin(clamp(radius.div(dist), 0, 1));
  const separation = acos(clamp(along.div(dist), -1, 1));
  const overlap = circleOverlapArea(sunAngRadius, occAngRadius, separation);
  const lit = clamp(float(1).sub(overlap.div(PI.mul(sunAngRadius).mul(sunAngRadius))), 0, 1);
  // 半径 0 の空きスロット、恒星より遠い側/背後にある天体、受け手がその表面に乗っている天体。
  const outOfPlay = lessThan(radius, 1).or(lessThan(along, 0)).or(greaterThan(along, sunDist))
    .or(lessThan(abs(dist.sub(radius)), selfTolerance));
  return select(outOfPlay, float(1), select(lessThan(dist, radius), float(0), lit));
});

// 半径 w の円盤のうち、半径座標が中心から u·w だけ離れた直線より内側にある面積の割合。
// u = -1 で 0、u = 0 で 0.5、u = +1 で 1。
const diskFractionBelow = Fn(([u]: readonly FloatNode[]) => {
  const safeU = clamp(u!, -1, 1);
  return acos(safeU.negate()).add(safeU.mul(sqrt(max(float(1).sub(safeU.mul(safeU)), 0)))).div(PI);
});

// 点 p から恒星へ向かう視線が環の帯 (inner, outer) を横切るときの透過率。
//
// **恒星は点ではなく円盤なので、帯の縁は 1 点の内外判定では決まらない。** 環面へ落ちる恒星
// 円盤の footprint は楕円で、その径方向の半幅 w は入射角の余弦 μ と、交点の径方向と恒星方向の
// 環面内成分のなす角の余弦 c から閉じた形で出る。帯の被覆率は「footprint のうち半径 outer より
// 内側」から「inner より内側」を引いた面積比で、サンプリングは要らない。
//
// 近似として受け入れるもの: (a) footprint の中で環の環状構造の曲率を無視する、(b) 帯の縁を
// footprint の中で直線と見なす。どちらも w << r0 が成り立つ限り誤差は二次で消える。
const ringTransmittance = Fn((
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
  private readonly ringBands: readonly RingBandUniforms[];
  private activeRingBands = 0;
  private readonly cumulusCenter: Vec3Uniform;
  private readonly cumulusSurfaceRadius: FloatUniform;
  private readonly cumulusTopAltitude: FloatUniform;
  private readonly cumulusBodyFromWorld: Mat4Uniform;
  private readonly cumulusActive: FloatUniform;
  // 雲の場。setCumulusShadow が value を差し替えると、sample() で枝分かれした先へも同じ写しが届く。
  private readonly cumulusField = texture(EMPTY_CUMULUS_FIELD);

  // 遮蔽器と環の帯ぶんの uniform を確保する。件数は固定なので、遮蔽器や帯が増減しても
  // transmittance() が返すグラフの形は変わらない。
  constructor(
    private readonly sunLight: SunLight,
    private readonly shadowMaps: SunShadowMaps,
  ) {
    this.occluders = Array.from({ length: MAX_OCCLUDERS }, () => ({
      center: uniform(new THREE.Vector3()),
      radius: uniform(0),
    }));
    this.ringCenter = uniform(new THREE.Vector3());
    this.ringAxis = uniform(new THREE.Vector3(0, 1, 0));
    this.ringBands = Array.from({ length: MAX_RING_BANDS }, () => ({
      inner: uniform(0),
      outer: uniform(0),
      tau: uniform(0),
      active: uniform(0),
    }));
    this.cumulusCenter = uniform(new THREE.Vector3());
    this.cumulusSurfaceRadius = uniform(0);
    this.cumulusTopAltitude = uniform(0);
    this.cumulusBodyFromWorld = uniform(new THREE.Matrix4());
    this.cumulusActive = uniform(0);
  }

  // このフレームで遮蔽器として扱う天体の列(描画座標)。MAX_OCCLUDERS を超えた分は捨てる。
  setOccluders(occluders: readonly Occluder[]): void {
    for (const [i, slot] of this.occluders.entries()) {
      const occluder = occluders[i];
      slot.radius.value = occluder === undefined ? 0 : occluder.radius;
      if (occluder !== undefined) slot.center.value.copy(occluder.center);
    }
  }

  // このフレームで有効な帯が 1 本でもあるか。遮蔽パスが環の項を持つグラフと持たないグラフを
  // 選び分けるのに使う。
  hasActiveRings(): boolean { return this.activeRingBands > 0; }

  // 環の影を落とす天体 1 体ぶんの帯。center/axis は描画座標、bands が空なら影は落ちない。
  setRings(center: THREE.Vector3, axis: THREE.Vector3, bands: readonly RingBand[]): void {
    this.activeRingBands = Math.min(bands.length, MAX_RING_BANDS);
    this.ringCenter.value.copy(center);
    this.ringAxis.value.copy(axis).normalize();
    for (const [i, slot] of this.ringBands.entries()) {
      const band = bands[i];
      slot.active.value = band === undefined ? 0 : 1;
      if (band === undefined) continue;
      slot.inner.value = band.innerRadius;
      slot.outer.value = band.outerRadius;
      slot.tau.value = band.normalOpticalDepth;
    }
  }

  // 積雲の殻が落とす影を、このフレームの 1 体ぶんへ置き直す。null なら雲の影は落ちない。
  setCumulusShadow(shadow: CumulusShadow | null): void {
    this.cumulusActive.value = shadow === null ? 0 : 1;
    if (shadow === null) return;
    this.cumulusCenter.value.copy(shadow.center);
    this.cumulusSurfaceRadius.value = shadow.surfaceRadius;
    this.cumulusTopAltitude.value = shadow.topAltitude;
    this.cumulusBodyFromWorld.value.copy(shadow.bodyFromWorld);
    this.cumulusField.value = shadow.field;
  }

  // 描画座標の点 worldPos へ恒星の直射光が届く割合 0..1 を組む。sources で選ばれた源だけを
  // 畳み込み、複数の遮蔽は透過率の積で合成する。
  transmittance(worldPos: Vec3Node, sources: OcclusionSources): FloatNode {
    const toSun = this.sunLight.position.sub(worldPos);
    const sunDist = max(length(toSun), 1);
    const sunDir = normalize(toSun);
    const sunAngRadius = asin(clamp(this.sunLight.radius.div(sunDist), 1e-9, 1));

    let transmittance: FloatNode = float(1);
    for (const occluder of this.occluders) {
      // 公差は深度からの位置復元の相対誤差(2⁻²⁴)から視距離の 1e-5、半径の桁落ちから
      // 半径の 1e-6 を取る。
      const selfTolerance = sources.selfViewDistance === null
        ? float(0)
        : max(occluder.radius.mul(1e-6), sources.selfViewDistance.mul(1e-5));
      transmittance = transmittance.mul(
        sphereTransmittance(
          worldPos, sunDir, sunDist, sunAngRadius, occluder.center, occluder.radius, selfTolerance,
        ),
      );
    }
    if (sources.rings) {
      for (const band of this.ringBands) {
        transmittance = transmittance.mul(
          ringTransmittance(
            worldPos, sunDir, sunAngRadius, this.ringCenter, this.ringAxis,
            band.inner, band.outer, band.tau, band.active,
          ),
        );
      }
    }
    if (sources.cumulusFootprint !== null) {
      transmittance = transmittance.mul(
        this.cumulusTransmittance(worldPos, sunDir, sources.cumulusFootprint));
    }
    if (sources.meshNormal !== null) {
      transmittance = transmittance.mul(this.meshTransmittance(worldPos, sources.meshNormal, sunDir));
    }
    return transmittance;
  }

  // 積雲の殻が落とす影。受け手から恒星へ向かう光路を、雲の層(天体中心から surfaceRadius +
  // topAltitude まで)を抜けるまでたどり、柱の雲頂より下を通る割合ぶんの消散を積む。
  //
  // **柱の光学的厚みは覆われている割合から出す** — 覆われた割合 c を通り抜けない確率と読んで
  // τ = −ln(1 − c) を取る。割合は殻が雲を立てるのと同じ規則(`cloud/cumulus-shape.ts`)から
  // 引くので、影は殻のシルエットの下へ落ちる。厚みは光路長ではなく **稼いだ高度** で配るので、
  // 柱を 1 本抜ける合計はどれだけ斜めでも τ に一致する。恒星が低いほど光路は横へ伸び、影も
  // 同じだけ離れた所へ落ちる。
  //
  // **受け手が自分の柱の雲頂に立っているときは、その柱で自分を陰らせない** — 殻の描く雲頂は
  // 粒のぶん場の雲頂から上下にずれるので、ずれの幅に入る受け手は雲頂の高さから測る。
  private cumulusTransmittance(
    worldPos: Vec3Node, sunDir: Vec3Node, footprint: FloatNode,
  ): FloatNode {
    return Fn(() => {
      const transmittance = float(1).toVar();
      // 場を持たないフレームで、タップぶんのフェッチを丸ごと飛ばす。
      If(greaterThan(this.cumulusActive, 0.5), () => {
        const offset = worldPos.sub(this.cumulusCenter);
        const shellRadius = this.cumulusSurfaceRadius.add(this.cumulusTopAltitude);
        const along = dot(offset, sunDir);
        // 光路が殻を出るまでの距離。殻より上の受け手では負になり、影は落ちない。
        const exit = sqrt(max(shellRadius.mul(shellRadius).sub(dot(offset, offset)).add(along.mul(along)), 0))
          .sub(along);
        const stepLength = clamp(exit, 0, CUMULUS_MAX_LIGHT_PATH).div(CUMULUS_SHADOW_TAPS);
        const lod = this.cumulusFieldLod(footprint, stepLength);
        const floorAltitude = this.receiverFloorAltitude(offset, lod);
        const opticalDepth = float(0).toVar();
        for (let tap = 0; tap < CUMULUS_SHADOW_TAPS; tap++) {
          const sampleOffset = offset.add(sunDir.mul(stepLength.mul(tap + 0.5)));
          const sampleRadius = max(length(sampleOffset), 1);
          const up = sampleOffset.div(sampleRadius);
          // **高度に床を張る** — 基準半径は赤道半径なので、極の地表は中心距離のほうが小さい。
          const altitude = max(sampleRadius.sub(this.cumulusSurfaceRadius), floorAltitude);
          const cloud = this.cumulusFieldAt(up, lod);
          const cloudTop = cloud.g.mul(this.cumulusTopAltitude);
          const rise = max(dot(sunDir, up), 0).mul(stepLength);
          const columnDepth = log(
            min(meanOpaqueFractionOf(cloud.r), CUMULUS_MAX_COVERAGE).oneMinus()).negate();
          // **1 歩が雲頂をまたぐ割合で配る** — 雲頂の内外を 1 点で判じると、歩の数だけの段に
          // 割れた縞が影に出る。タップは歩の中点なので、稼いだ高度の半分が前後に広がる。
          const inside = clamp(cloudTop.sub(altitude).div(max(rise, 1)).add(0.5), 0, 1);
          opticalDepth.addAssign(columnDepth.mul(rise).mul(inside).div(max(cloudTop, 1)));
        }
        transmittance.assign(exp(opticalDepth.negate()));
      });
      return transmittance;
    })();
  }

  // 場を引く mip 段。画面 1 px が受け手の位置で張る実寸 footprint [m] と、光路 1 歩の長さ
  // stepLength [m] のうち **粗いほう** を、場の texel が赤道で覆う実寸と比べて決める。歩が
  // またいだ柱は 1 タップが代表するので、恒星が低いほど影は柔らかく長く伸びる。
  private cumulusFieldLod(footprint: FloatNode, stepLength: FloatNode): FloatNode {
    // 寸法を返すノードは型引数を持たないので、成分を取れる形へ直してから読む。
    const fieldWidth = (this.cumulusField.size(int(0)) as THREE.Node<'uvec2'>).x;
    const texelWorld = this.cumulusSurfaceRadius.mul(2 * Math.PI).div(float(fieldWidth));
    return max(log2(max(footprint, stepLength.mul(CUMULUS_STEP_BLUR)).div(max(texelWorld, 1))), 0);
  }

  // 描画座標の単位方向 up における場を、mip 段を指定して引く。**段は明示で渡す** — 光路の
  // タップの uv は画面の隣の画素と続いていないので、画面微分から選ばれる段は当てにならない。
  private cumulusFieldAt(up: Vec3Node, lod: FloatNode): Vec4Node {
    const uv = sphereMeshUv(this.cumulusBodyFromWorld.mul(vec4(up, 0)).xyz);
    return this.cumulusField.sample(vec2(fract(uv.x), uv.y)).level(lod);
  }

  // 光路のタップの高度に張る床 [m]。受け手が自分の柱の雲頂の高さにあるなら、その雲頂の高さ。
  // offset は天体中心から受け手へのベクトル(描画座標)。
  private receiverFloorAltitude(offset: Vec3Node, lod: FloatNode): FloatNode {
    const radius = max(length(offset), 1);
    const altitude = max(radius.sub(this.cumulusSurfaceRadius), 0);
    const top = this.cumulusFieldAt(offset.div(radius), lod).g.mul(this.cumulusTopAltitude);
    const uncertainty = this.cumulusTopAltitude.mul(CLOUD_TOP_UNCERTAINTY);
    return select(greaterThan(altitude, top.sub(uncertainty)), top, float(0));
  }

  // 描画座標の点が、そのスロットの柱(枠 × [near, near + coverDepth])に入っているか。
  // **遮蔽の合成とデバッグ表示が同じ判定を読む** — 別々に持つと、塗り分けは正しいのに影が
  // 出ない絵が作れてしまう。
  //
  // 枠はフィルタの足のぶんだけ狭めて判定する。**選んだ時点で、法線オフセットぶんずらした位置も
  // PCF の円盤も枠の内側に収まる**ので、引く側は縁の判定を持たなくてよい。
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

  // シャドウアトラスへ描かれたメッシュが落とす影。**選んだ 1 スロットだけを引く** — 透過率は
  // 恒星円盤の遮られずに残る面積比なので、枠の重なったスロットの答えを掛け合わせると、同じ
  // 遮蔽器の半影が二重に濃くなる。
  //
  // 判定は select ではなく If で書く。select は両辺を評価するので、画面のほとんどを占める
  // 虚空の画素からもテクスチャフェッチが消えない。**選ぶ段と引く段を分けるのも同じ理由** —
  // 1 段で書くと、より細かいスロットが見つかるたびに引き直すことになる。
  private meshTransmittance(worldPos: Vec3Node, normal: Vec3Node, sunDir: Vec3Node): FloatNode {
    // 恒星の視半径。半影の幅はここに遮蔽器までの距離を掛けたものになる。
    const sunAngRadius = this.sunLight.radius.div(max(length(this.sunLight.position.sub(worldPos)), 1));
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

    // 半影の幅を物理から出す。遮蔽器までの距離 (receiver − blocker) に恒星の視半径を掛けた
    // ものが world 空間での半径で、それを texel へ直す。**1 タップの探索は探索半径の外の
    // 遮蔽器を見逃す**(PCSS の既知の限界)ので、細い部材の影の縁は硬いまま残る — 半影が
    // 数 texel の範囲では画面上 2px の差にしかならないので許容する。
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
    for (let i = 0; i < PCF_TAPS; i++) {
      // Vogel disk: 黄金角で回しながら sqrt で半径を振ると、円盤上へ均等に散る。
      const angle = i * VOGEL_GOLDEN_ANGLE;
      const spread = Math.sqrt((i + 0.5) / PCF_TAPS);
      const uv = uvBase.add(vec2(Math.cos(angle) * spread, Math.sin(angle) * spread).mul(step));
      const stored = texture(slot.texture, uv).r;
      lit.addAssign(select(receiverDepth.sub(depthBias).greaterThan(stored), float(0), float(1)));
    }
    const visibility = float(1).sub(float(1).sub(lit.div(PCF_TAPS)).mul(umbraFade));
    const distantVisibility = this.distantVisibility(slot, uvBase, receiverDepth.sub(depthBias), casterSize, sunAngRadius);
    // 法線オフセットが受け手を光源側へ押し出し、柱の手前へ抜けることがある。そこは遮られない。
    return select(receiverDepth.lessThan(0), float(1), visibility.mul(distantVisibility));
  }

  // 遠層に写った遮蔽器が残す可視率。**近層と遠層に同じ遮蔽器が写ることはない**ので、2 つの
  // 可視率はそのまま掛けられる。
  //
  // 遠層に居るのは本影を失った遮蔽器だけで、半影の幅は枠の 1 辺以上ある。**縁は元から硬くない
  // ので PCF は要らず、遮られる面積比 (遮蔽器の角半径 / 恒星の角半径)² を 1 タップから返す。**
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
