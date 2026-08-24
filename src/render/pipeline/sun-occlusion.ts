// 恒星の直射光がどれだけ届くかを答える唯一の場。transmittance() が描画座標の点に対する透過率の
// TSL グラフを返す。遮蔽するのは天体の球・惑星の環の帯・シャドウアトラスへ描かれたメッシュで、
// 複数の遮蔽は透過率の積で合成する。遮蔽器と環の帯は毎フレーム呼び出し側が渡す。
//
// TODO: 受け手が乗っている天体自身も遮蔽器に数えるため、昼夜境界では N·L と幾何遮蔽が二重に
// 効く(差は恒星の視半径ぶんの帯で、地球なら直径の 0.2 %)。仕様に根拠が無い。
import * as THREE from 'three/webgpu';
import {
  Fn, If, PI, abs, acos, and, asin, clamp, dot, exp, float, greaterThan, length,
  lessThan, max, min, normalize, select, sqrt, texture, uniform, vec2, vec4,
} from 'three/tsl';
import type { FloatNode, FloatUniform, Vec3Node, Vec3Uniform } from '../tsl-types';
import { SHADOW_SLOT_SIZE, type SunShadowMaps, type SunShadowSlot } from './sun-shadow-maps';
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
  readonly rings: boolean;
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

// メッシュの影のフィルタ。半径は半影の幅から決まり、この範囲へ収める(単位は texel)。
// タップは Vogel disk で散らす — 少ないタップでも規則的な縞にならない。
const PCF_TAPS = 12;
const PCF_MIN_TEXELS = 0.5;
const PCF_MAX_TEXELS = 8;
const VOGEL_GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));


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

  // 描画座標の点 worldPos へ恒星の直射光が届く割合 0..1 を組む。sources で選ばれた源だけを
  // 畳み込み、複数の遮蔽は透過率の積で合成する。
  transmittance(worldPos: Vec3Node, sources: OcclusionSources): FloatNode {
    const toSun = this.sunLight.position.sub(worldPos);
    const sunDist = max(length(toSun), 1);
    const sunDir = normalize(toSun);
    const sunAngRadius = asin(clamp(this.sunLight.radius.div(sunDist), 1e-9, 1));

    let transmittance: FloatNode = float(1);
    for (const occluder of this.occluders) {
      transmittance = transmittance.mul(
        sphereTransmittance(worldPos, sunDir, sunDist, sunAngRadius, occluder.center, occluder.radius),
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
    if (sources.meshNormal !== null) {
      transmittance = transmittance.mul(this.meshTransmittance(worldPos, sources.meshNormal, sunDir));
    }
    return transmittance;
  }

  // シャドウアトラスへ描かれたメッシュが落とす影。**スロットの境界の外なら引かない** —
  // 判定は select ではなく If で書く。select は両辺を評価するので、画面のほとんどを占める
  // 虚空の画素からもテクスチャフェッチが消えない。
  //
  // スロットは互いに重ならないので、**入っている最初のスロットだけを引く**(積ではなく単一選択)。
  private meshTransmittance(worldPos: Vec3Node, normal: Vec3Node, sunDir: Vec3Node): FloatNode {
    const slots = this.shadowMaps.slots;
    // 恒星の視半径。半影の幅はここに遮蔽器までの距離を掛けたものになる。
    const sunAngRadius = this.sunLight.radius.div(max(length(this.sunLight.position.sub(worldPos)), 1));
    return Fn(() => {
      const visibility = float(1).toVar();
      const taken = float(0).toVar();
      for (const slot of slots) {
        const lo = slot.boundsMin;
        const hi = slot.boundsMax;
        const inside = lessThan(taken, 0.5).and(greaterThan(slot.active, 0.5))
          .and(worldPos.x.greaterThan(lo.x)).and(worldPos.x.lessThan(hi.x))
          .and(worldPos.y.greaterThan(lo.y)).and(worldPos.y.lessThan(hi.y))
          .and(worldPos.z.greaterThan(lo.z)).and(worldPos.z.lessThan(hi.z));
        If(inside, () => {
          taken.assign(1);
          visibility.assign(this.slotVisibility(slot, worldPos, normal, sunDir, sunAngRadius));
        });
      }
      return visibility;
    })();
  }

  // スロット 1 枚ぶんの可視率。ブロッカー探索 1 タップで半影の幅を決め、その半径の
  // Vogel disk で PCF する。
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
    const depthRange = max(slot.far.sub(slot.near), 1e-6);
    const depthBias = min(texel.mul(slope).mul(2), texel.mul(MAX_SLOPE_BIAS_TEXELS)).div(depthRange);

    const clip = slot.lightViewProjection.mul(vec4(offsetPos, 1));
    const uvBase = clip.xyz.div(clip.w).xy.mul(0.5).add(0.5);
    const receiverDepth = slot.lightView.mul(vec4(offsetPos, 1)).z.negate()
      .sub(slot.near).div(depthRange);

    // 半影の幅を物理から出す。遮蔽器までの距離 (receiver − blocker) に恒星の視半径を掛けた
    // ものが world 空間での半径で、それを texel へ直す。**1 タップの探索は探索半径の外の
    // 遮蔽器を見逃す**(PCSS の既知の限界)ので、細い部材の影の縁は硬いまま残る — 半影が
    // 数 texel の範囲では画面上 2px の差にしかならないので許容する。
    const blockerDepth = texture(slot.texture, uvBase).r;
    const blockerDistance = max(receiverDepth.sub(blockerDepth), 0).mul(depthRange);
    const radiusTexels = clamp(sunAngRadius.mul(blockerDistance).div(texel), PCF_MIN_TEXELS, PCF_MAX_TEXELS);

    const step = radiusTexels.mul(1 / SHADOW_SLOT_SIZE);
    const lit = float(0).toVar();
    for (let i = 0; i < PCF_TAPS; i++) {
      // Vogel disk: 黄金角で回しながら sqrt で半径を振ると、円盤上へ均等に散る。
      const angle = i * VOGEL_GOLDEN_ANGLE;
      const spread = Math.sqrt((i + 0.5) / PCF_TAPS);
      const uv = uvBase.add(vec2(Math.cos(angle) * spread, Math.sin(angle) * spread).mul(step));
      const stored = texture(slot.texture, uv).r;
      lit.addAssign(select(receiverDepth.sub(depthBias).greaterThan(stored), float(0), float(1)));
    }
    return lit.div(PCF_TAPS);
  }
}
