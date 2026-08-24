// 恒星の直射光がどれだけ届くかを答える唯一の場。遮蔽器の uniform を持ち、transmittance() が
// 描画座標の点に対する透過率の TSL グラフを返す。遮蔽パス(occlusion.ts)はこの関数を
// 「G バッファの深度から復元した位置」で評価して1枚へ書くだけの消費者で、環や大気のような
// 前方描画の受け手は自分のフラグメント位置で同じ関数を直に評価する。
//
// 遮蔽器は毎フレーム呼び出し側が選んで渡す。天体の球は MAX_OCCLUDERS 体、環は 1 体ぶんの
// MAX_RING_BANDS 帯まで — 環付き天体が画面に複数写る状況は実質起きないため、環は最も
// 目立つ 1 体だけを受ける。
//
// 受け手が乗っている天体自身も遮蔽器に数える。昼側は「中心が恒星と逆側」で早々に外れ、
// 夜側は本影として落ちるので破綻しないが、昼夜境界では N·L と幾何遮蔽が二重に効く。
import * as THREE from 'three/webgpu';
import {
  Fn, If, PI, abs, acos, and, asin, clamp, dot, exp, float, greaterThan, length,
  lessThan, max, min, normalize, screenUV, select, sqrt, texture, uniform, vec2, vec4,
} from 'three/tsl';
import type { FloatNode, FloatUniform, Vec3Node, Vec3Uniform } from '../tsl-types';
import type { ProteinShadowPass } from './protein-shadow-pass';
import { SHADOW_ATLAS_SIZE, type SunShadowAtlas } from './sun-shadow-atlas';
import type { SunLight } from './sun-light';

export const MAX_OCCLUDERS = 4;

// 環の帯の上限。登録上の最大は天王星の 13 帯(physics/solar-system.ts)なので、それを超える
// スロットは常に空になる — グラフは静的に展開されるので、空きスロットも毎画素の演算を食う。
export const MAX_RING_BANDS = 13;

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

// グラフへ畳み込む遮蔽源の選択。TSL のグラフは静的に展開されるので実行時の分岐にはできず、
// 受け手ごとに要る源が違う(環は自分の帯を外す必要がある)ため、構築時に呼び出し側が決める。
export type OcclusionSources = {
  readonly spheres: boolean;
  readonly rings: boolean;
  // タンパク質の半透明外殻。**遮蔽パスからしか選べない** — 受け手が内部リボンだけに画面空間の
  // マスクで限定されており、画面の画素以外ではそのマスクを引けないため。
  readonly protein: boolean;
  // 艦艇・基地・デブリなどのメッシュ。**真偽ではなく受け手の法線で選ぶ** — バイアスを法線方向の
  // オフセットで入れるので法線が要り、型の側で「法線を持たずにこの源を選ぶ」を塞ぐ。
  readonly meshNormal: Vec3Node | null;
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

// メッシュの影のバイアス。受け手をこれだけ法線方向へずらしてからライト空間へ写し、残りを
// 傾きに比例した深度バイアスで吸収する。単位はどちらもそのスロットの 1 texel。
const NORMAL_OFFSET_TEXELS = 1.5;
const MAX_SLOPE_BIAS_TEXELS = 8;

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
// 場合分け無しに1つの閉じた形から出る。
const sphereTransmittance = Fn((
  [p, sunDir, sunDist, sunAngRadius, center, radius]: readonly [Vec3Node, Vec3Node, FloatNode, FloatNode, Vec3Node, FloatNode],
) => {
  const toCenter = center.sub(p);
  const along = dot(toCenter, sunDir);
  const dist = max(length(toCenter), 1e-6);
  const occAngRadius = asin(clamp(radius.div(dist), 0, 1));
  const separation = acos(clamp(along.div(dist), -1, 1));
  const overlap = circleOverlapArea(sunAngRadius, occAngRadius, separation);
  const lit = clamp(float(1).sub(overlap.div(PI.mul(sunAngRadius).mul(sunAngRadius))), 0, 1);
  // 半径 0 の空きスロット、恒星より遠い側/背後にある天体、視点が天体の内側にある場合。
  const outOfPlay = lessThan(radius, 1).or(lessThan(along, 0)).or(greaterThan(along, sunDist));
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

  // 遮蔽器と環の帯ぶんの uniform を確保する。件数は固定なので、遮蔽器や帯が増減しても
  // transmittance() が返すグラフの形は変わらない。
  constructor(
    private readonly sunLight: SunLight,
    private readonly proteinShadow: ProteinShadowPass,
    private readonly shadowAtlas: SunShadowAtlas,
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

  // タンパク質の外殻が落とす影。受け手は画面空間のマスクで内部リボンへ限定され、外殻の深度は
  // ProteinShadowPass が撮ったライト空間の 1 枚から引く。マスクを引くのに screenUV を使うので、
  // この項は画面の画素を評価している呼び出し(遮蔽パス)でしか意味を持たない。
  private proteinTransmittance(worldPos: Vec3Node): FloatNode {
    const lightClip = this.proteinShadow.lightViewProjection.mul(vec4(worldPos, 1));
    const shadowUV = lightClip.xyz.div(lightClip.w).xy.mul(0.5).add(0.5);
    const inShadowMap = shadowUV.x.greaterThan(0).and(shadowUV.x.lessThan(1))
      .and(shadowUV.y.greaterThan(0)).and(shadowUV.y.lessThan(1));
    const lightViewPosition = this.proteinShadow.lightView.mul(vec4(worldPos, 1)).xyz;
    const pointDepth = lightViewPosition.z.negate()
      .sub(this.proteinShadow.near)
      .div(this.proteinShadow.far.sub(this.proteinShadow.near))
      .clamp(0, 1);
    const storedDepth = texture(this.proteinShadow.shadowTexture, shadowUV).r;
    const shadowed = pointDepth.greaterThan(storedDepth.add(this.proteinShadow.bias));
    const receiver = texture(this.proteinShadow.receiverTexture, screenUV).r;
    const isReceiver = this.proteinShadow.active.greaterThan(0.5).and(receiver.greaterThan(0.5));
    return select(
      isReceiver, select(inShadowMap, select(shadowed, float(0), float(1)), float(1)), float(1),
    );
  }

  // シャドウアトラスへ描かれたメッシュが落とす影。**スロットの境界の外なら引かない** —
  // 判定は select ではなく If で書く。select は両辺を評価するので、画面のほとんどを占める
  // 虚空の画素からもテクスチャフェッチが消えない。
  private meshTransmittance(worldPos: Vec3Node, normal: Vec3Node, sunDir: Vec3Node): FloatNode {
    const slot = this.shadowAtlas.slot;
    return Fn(() => {
      const visibility = float(1).toVar();
      const lo = slot.boundsMin;
      const hi = slot.boundsMax;
      const inside = greaterThan(slot.active, 0.5)
        .and(worldPos.x.greaterThan(lo.x)).and(worldPos.x.lessThan(hi.x))
        .and(worldPos.y.greaterThan(lo.y)).and(worldPos.y.lessThan(hi.y))
        .and(worldPos.z.greaterThan(lo.z)).and(worldPos.z.lessThan(hi.z));
      If(inside, () => {
        const texel = slot.texelWorld;
        // バイアスは 2 段構え。**無次元の定数は使えない** — スロットの広がりがフレームごとに
        // 変わるので、texel の実寸を単位に取る。法線方向のオフセットで受け手を遮蔽器から
        // 離し、残りを傾きに比例した深度バイアスで吸収する。
        const nDotL = clamp(dot(normal, sunDir), 1e-3, 1);
        const slope = sqrt(float(1).sub(nDotL.mul(nDotL))).div(nDotL);
        const offsetPos = worldPos.add(normal.mul(texel.mul(NORMAL_OFFSET_TEXELS)));
        const depthBias = min(texel.mul(slope).mul(2), texel.mul(MAX_SLOPE_BIAS_TEXELS));

        const clip = slot.lightViewProjection.mul(vec4(offsetPos, 1));
        const slotUV = clip.xyz.div(clip.w).xy.mul(0.5).add(0.5);
        const depthRange = max(slot.far.sub(slot.near), 1e-6);
        const pointDepth = slot.lightView.mul(vec4(offsetPos, 1)).z.negate()
          .sub(slot.near).div(depthRange).sub(depthBias.div(depthRange));

        // 固定半径 3x3 の PCF。半影の幅を遮蔽器までの距離から出すのは手順 9 の担当で、
        // ここでは texel 1 つぶんの階段を均すだけ。
        const step = float(1 / SHADOW_ATLAS_SIZE);
        const lit = float(0).toVar();
        for (const dx of [-1, 0, 1]) {
          for (const dy of [-1, 0, 1]) {
            const uv = slotUV.add(vec2(dx, dy).mul(step));
            const stored = texture(this.shadowAtlas.texture, uv).r;
            lit.addAssign(select(pointDepth.greaterThan(stored), float(0), float(1)));
          }
        }
        visibility.assign(lit.div(9));
      });
      return visibility;
    })();
  }

  // 描画座標の点 worldPos へ恒星の直射光が届く割合 0..1 を組む。sources で選ばれた源だけを
  // 畳み込み、複数の遮蔽は透過率の積で合成する。
  transmittance(worldPos: Vec3Node, sources: OcclusionSources): FloatNode {
    const toSun = this.sunLight.position.sub(worldPos);
    const sunDist = max(length(toSun), 1);
    const sunDir = normalize(toSun);
    const sunAngRadius = asin(clamp(this.sunLight.radius.div(sunDist), 1e-9, 1));

    let transmittance: FloatNode = float(1);
    if (sources.spheres) {
      for (const occluder of this.occluders) {
        transmittance = transmittance.mul(
          sphereTransmittance(worldPos, sunDir, sunDist, sunAngRadius, occluder.center, occluder.radius),
        );
      }
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
    if (sources.protein) transmittance = transmittance.mul(this.proteinTransmittance(worldPos));
    if (sources.meshNormal !== null) {
      transmittance = transmittance.mul(this.meshTransmittance(worldPos, sources.meshNormal, sunDir));
    }
    return transmittance;
  }
}
