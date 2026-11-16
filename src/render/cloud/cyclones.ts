// 気圧へ書き込む低気圧の谷。熱帯低気圧 TROPICAL_COUNT 個と中緯度の低気圧 LOW_COUNT 個の配置(緯度・経度・深さ・
// 短軸の半径・長軸/短軸の比)を時刻ごとに受けて uniform へ写し、単位方向での気圧の落ち込み・眼・金床を
// TSL のグラフで答える。谷は前線の向き(北半球で南西–北東、南半球で北西–南東)へ長い楕円。眼を持つか
// どうかは谷の芯で風が等圧線を横切る角で決まり、締まって深い熱帯低気圧が持つ。
import * as THREE from 'three/webgpu';
import {
  abs, cross, dot, exp, float, inverseSqrt, length, max, min, sign, uniform, vec3,
} from 'three/tsl';
import { LOW_COUNT, TROPICAL_COUNT, lowPlacementAt, tropicalPlacementAt } from './cyclone-tracks';
import { coreCrossingAngle } from './wind-law';
import type { CyclonePlacement } from './cyclone-tracks';
import type { FloatNode, FloatUniform, Vec3Node, Vec3Uniform } from '../tsl-types';

// 気圧の谷による影響限界半径 [m]。裾野は距離に反比例するため、単体では微弱でも複数累積すると全球的な
// 底上げになり、気圧から出る上昇流の基準がまるごと持ち上がる。ここで遠方を閉じる。最大の谷
// (消えるときの中緯度の低気圧で短軸の半径 1800 km、温帯化した熱帯低気圧で約 1000 km)の裾を
// 切らない長さ — 芯が 1/√2 に落ちる半径の外側で、ガウスは 1800 km でも e^(−0.52) = 0.59 に留まる。
const TROUGH_REACH = 2500e3;

// 眼。広がりは谷自身の広がりに対する比で、湿度はその内側で落ちる。成熟した台風の眼は直径 600 km の
// 円盤の中に開く数十 km の穴なので、最盛期の熱帯低気圧(短軸の半径 180〜240 km)で半径 54〜72 km に
// なる比に取り、眼の外側で円盤が埋まったまま残るよう締めておく。眼を持つかどうかは、谷の芯で風が
// 等圧線を横切る角で決まる — この角より閉じた谷が眼を持ち、あいだで滑らかに渡る。熱帯低気圧
// (最深 55〜70 hPa、生まれる半径 180〜240 km)は転向の直後の最盛期(緯度 16° 以上)で 11.5° 以下と
// 全部持ち、温帯化して深さが 6 割・半径が 1.5 倍を超えると 21° 以上に開いて失う。中緯度の低気圧(最深
// 16〜32 hPa、半径 600 km 以上)は緯度 70° でも 18.1° 以上で持たない。
const EYE_FRACTION = 0.3;
const EYE_ANGLE_FULL = THREE.MathUtils.degToRad(12);
const EYE_ANGLE_NONE = THREE.MathUtils.degToRad(16);

// 金床(平らな天蓋)の広がりも谷自身の広がりに対する比で、眼と同じく芯に貼り付く。天蓋は
// 中心濃密雲域 — 直径 600〜800 km の平らな白い円盤 — なので、最盛期の熱帯低気圧(短軸の半径
// 180〜240 km)で半径 245〜325 km になる比に取る。anvilAt の形では、この半径の 2/3 まで 0.9 以上に
// 残り、5/6 で 0.72、1.17 倍で 0.08 に落ちる。
const ANVIL_FRACTION = 1.36;

// 自転軸。
const POLE = vec3(0, 1, 0);

// 閉塞の構造 — 芯から赤道側・やや下流へ乾いた舌が入り込み、極側へ広い層状の雲域(コンマの頭)が
// 張る。位置と広がりはすべて谷の短軸の半径を尺にした倍率で書き、強さは閉塞の進み × 現在の深さに
// 比例する。全強度になる深さ [hPa] は、並の低気圧(最深 12〜40 hPa)の中ほどに取る。
const OCCLUSION_DEPTH = 24;
// 乾いた舌 — 寒冷前線の帯とコンマの頭のあいだへ、赤道側・やや下流から芯へ入り込む下降流の楔。
// 芯は赤道側へ 0.7、下流へ 0.3(半径の倍率)ずれた所に置き、下流の向きへ長い楕円で張る。
const DRY_TONGUE_POLEWARD = 0.7;
const DRY_TONGUE_DOWNSTREAM = 0.3;
const DRY_TONGUE_SEMI_POLE = 0.55;
const DRY_TONGUE_SEMI_DOWN = 1.0;
// コンマの頭 — 芯の極側を覆う広い乱層雲の円盤。中心側へも掛けて、低気圧の芯を雲域の中へ抱え込む。
const COMMA_HEAD_POLEWARD = 0.45;
const COMMA_HEAD_SEMI_POLE = 0.9;
const COMMA_HEAD_SEMI_DOWN = 1.1;
// 閉塞した芯の半径(半径の倍率)。この内側では暖域の舌が切り離され、暖気流入の湿りが止まる。
const OCCLUDED_CORE_RADIUS = 0.9;

// 眼の濃さ 0..1。深さ depth [hPa]・短軸の半径 radius [m] の谷を緯度 latitude [rad] に置いたとき、
// 芯で風が等圧線を横切る角が EYE_ANGLE_FULL より閉じていれば 1、EYE_ANGLE_NONE より開いていれば 0。
// surfaceRadius は天体の半径 [m]、rotationPeriod は自転周期 [s]。
export function eyeStrengthOf(
  depth: number, radius: number, latitude: number, surfaceRadius: number, rotationPeriod: number,
): number {
  // 芯(勾配の消える点)での等圧線方向の 2 階微分 [hPa/rad²]。pressureAt の形を短軸の向きに原点で
  // 開いたもの。長軸の向きの曲がりはこれより緩いので、眼の判定は閉じた側で行う。
  const coreBend = depth * ((surfaceRadius / radius) ** 2 + 2 * (surfaceRadius / TROUGH_REACH) ** 2);
  const crossing = coreCrossingAngle(coreBend, latitude, surfaceRadius, rotationPeriod);
  return 1 - THREE.MathUtils.smoothstep(crossing, EYE_ANGLE_FULL, EYE_ANGLE_NONE);
}

// 谷 1 つ。配置を uniform に持ち、単位方向での気圧の落ち込み・眼・金床を答える。
// 正の深さを置けば高気圧の丘としても使える(anticyclones.ts)。
export class Trough {
  private readonly center: Vec3Uniform = uniform(new THREE.Vector3());
  // 長軸の向きの単位接ベクトル。
  private readonly axis: Vec3Uniform = uniform(new THREE.Vector3());
  private readonly depth: FloatUniform = uniform(0);
  // 弦の二乗を芯の尺で測る係数 (天体の半径 / 短軸の半径)²。
  private readonly coreScale: FloatUniform = uniform(0);
  // 長軸に沿う成分を縮める係数 1 − 1 / (長軸/短軸の比)²。0 で円。
  private readonly axisShrink: FloatUniform = uniform(0);
  // 眼の濃さ 0..1。深さと広がりと緯度から出るので、同じ谷でも一生の中で現れて消える。
  private readonly eyeStrength: FloatUniform = uniform(0);
  // 閉塞の進み 0..1。中緯度の低気圧の一生の後半で立ち上がる。
  private readonly occlusion: FloatUniform = uniform(0);

  // surfaceRadius は谷を置く天体の半径 [m]、rotationPeriod はその自転周期 [s]。
  public constructor(private readonly surfaceRadius: number, private readonly rotationPeriod: number) {}

  // 配置 placement を uniform へ設定する。null(存在しない)なら深さ・眼の濃さ・閉塞を 0 にする。
  // 長軸は東と極側の北のあいだ — 北半球で南西–北東、南半球で北西–南東。
  public place(placement: CyclonePlacement | null): void {
    if (placement === null) {
      this.depth.value = 0;
      this.eyeStrength.value = 0;
      this.occlusion.value = 0;
      return;
    }
    const { latitude, longitude, depth, radius, elongation } = placement;
    // 中心の単位方向。
    const cosLatitude = Math.cos(latitude);
    const sinLatitude = Math.sin(latitude);
    const cosLongitude = Math.cos(longitude);
    const sinLongitude = Math.sin(longitude);
    this.center.value.set(cosLatitude * sinLongitude, sinLatitude, cosLatitude * cosLongitude);
    // 長軸: 東方向ベクトルと北方向ベクトルの合成。南半球では北方向の符号を反転する。
    const hemisphere = latitude >= 0 ? 1 : -1;
    this.axis.value.set(
      cosLongitude - hemisphere * sinLatitude * sinLongitude,
      hemisphere * cosLatitude,
      -sinLongitude - hemisphere * sinLatitude * cosLongitude,
    ).normalize();
    // 深さ、芯の尺、長軸の縮み、眼。
    this.depth.value = depth;
    this.coreScale.value = (this.surfaceRadius / radius) ** 2;
    this.axisShrink.value = 1 - 1 / elongation ** 2;
    this.eyeStrength.value = eyeStrengthOf(depth, radius, latitude, this.surfaceRadius, this.rotationPeriod);
    this.occlusion.value = placement.occlusion ?? 0;
  }

  // 中心からの弦の二乗。距離を弦で測るので、対蹠点に鏡像が出ない。長軸に沿う成分は axisShrink の
  // 分だけ縮めて測るので、谷はその向きへ長軸/短軸の比の倍に広がる。
  private chordSquared(direction: Vec3Node): FloatNode {
    const offset = direction.sub(this.center);
    const alongAxis = dot(offset, this.axis);
    return dot(offset, offset).sub(alongAxis.mul(alongAxis).mul(this.axisShrink));
  }

  // 単位方向 direction での気圧の落ち込み [hPa](負)。芯は短軸の向きに中心から半径で 1/√2 へ
  // 落ち、その先は中心からの距離に反比例して裾を引き、TROUGH_REACH のガウスが遠方を閉じる。
  //
  // **裾の緩さを決めるのは対数傾き。** 反比例の裾は傾きが一桁ぶんの半径をかけて渡るので、風向も
  // 移流の伸びも半径に沿って滑らかに緩む。芯の巻きは 深さ/広がり² が単独で握り、裾と別に動かせる。
  public pressureAt(direction: Vec3Node): FloatNode {
    const chordSquared = this.chordSquared(direction);
    const core = inverseSqrt(chordSquared.mul(this.coreScale).add(1))
      .mul(exp(chordSquared.mul(-((this.surfaceRadius / TROUGH_REACH) ** 2))));
    return core.mul(this.depth).negate();
  }

  // 単位方向 direction での台風の眼の強度 0..1（中心で最大、外縁で 0）。急峻なガウス分布のため、
  // 半径外側の寄与は実質的に 0 となる。台風の眼が非形成の低気圧では全域で 0。
  public eyeAt(direction: Vec3Node): FloatNode {
    return exp(this.normalizedChordSquared(direction, EYE_FRACTION).negate()).mul(this.eyeStrength);
  }

  // 単位方向 direction での金床の濃さ 0..1(中心で最も濃く、外で 0)。眼と同じく芯に貼り付くが、
  // 形は距離の 6 乗の超ガウス — ガウスには縁が無く丘のまま裾へ流れるが、天蓋は半径まで平らに
  // 覆って縁で急に終わる。眼を持たない谷では全域で 0。
  public anvilAt(direction: Vec3Node): FloatNode {
    const normalized = this.normalizedChordSquared(direction, ANVIL_FRACTION);
    return exp(normalized.mul(normalized).mul(normalized).negate()).mul(this.eyeStrength);
  }

  // 中心からの弦の二乗を、谷の広がりの fraction 倍の半径で 1 になる尺で測ったもの。
  private normalizedChordSquared(direction: Vec3Node, fraction: number): FloatNode {
    return this.chordSquared(direction).mul(this.coreScale).div(fraction ** 2);
  }

  // 閉塞した低気圧の構造の強さ 0..1 — 閉塞の進み × 現在の深さ。谷が埋まるとともに抜ける。
  private occlusionStrength(): FloatNode {
    return this.occlusion.mul(min(this.depth.div(OCCLUSION_DEPTH), 1));
  }

  // 谷の中心での極側と下流(東)の単位接ベクトル。極側は近い極へ向かう向き — 自転軸を中心の
  // 緯度の符号で反転して接平面へ写すので、赤道側・極側の向き付けは緯度の符号だけで両半球に揃う。
  // 極の真上では向きが決まらないので、長さに床を張る。
  private occlusionFrame(): { readonly poleward: Vec3Node; readonly downstream: Vec3Node } {
    const poleward = POLE.mul(sign(this.center.y)).sub(this.center.mul(abs(this.center.y)));
    const east = cross(POLE, this.center);
    return {
      poleward: poleward.div(max(length(poleward), 1e-6)),
      downstream: east.div(max(length(east), 1e-6)),
    };
  }

  // 短軸の半径ぶんの弦長。谷の無い所(芯の尺 0)で発散しないよう床を張る。
  private coreRadius(): FloatNode {
    return inverseSqrt(max(this.coreScale, 1e-6));
  }

  // 中心からの単位方向への変位を単位方向へ戻す。谷の無い所では変位が消えるので床を張る。
  private safeNormalize(v: Vec3Node): Vec3Node {
    return v.div(max(length(v), 1e-6));
  }

  // 単位方向 direction での乾いた舌の濃さ 0..1。芯から赤道側・やや下流へずれた楕円の楔で、
  // 閉塞していない谷では 0。
  public dryTongueAt(direction: Vec3Node): FloatNode {
    const { poleward, downstream } = this.occlusionFrame();
    const radius = this.coreRadius();
    const tongueCenter = this.safeNormalize(
      this.center.sub(poleward.mul(radius.mul(DRY_TONGUE_POLEWARD)))
        .add(downstream.mul(radius.mul(DRY_TONGUE_DOWNSTREAM))));
    const offset = direction.sub(tongueCenter);
    const across = dot(offset, poleward).div(radius.mul(DRY_TONGUE_SEMI_POLE));
    const along = dot(offset, downstream).div(radius.mul(DRY_TONGUE_SEMI_DOWN));
    return exp(across.mul(across).add(along.mul(along)).negate()).mul(this.occlusionStrength());
  }

  // 単位方向 direction でのコンマの頭の濃さ 0..1。芯の極側を覆う広い層状の雲域で、閉塞して
  // いない谷では 0。
  public commaHeadAt(direction: Vec3Node): FloatNode {
    const { poleward, downstream } = this.occlusionFrame();
    const radius = this.coreRadius();
    const headCenter = this.safeNormalize(
      this.center.add(poleward.mul(radius.mul(COMMA_HEAD_POLEWARD))));
    const offset = direction.sub(headCenter);
    const across = dot(offset, downstream).div(radius.mul(COMMA_HEAD_SEMI_DOWN));
    const along = dot(offset, poleward).div(radius.mul(COMMA_HEAD_SEMI_POLE));
    return exp(across.mul(across).add(along.mul(along)).negate()).mul(this.occlusionStrength());
  }

  // 単位方向 direction での閉塞した芯の濃さ 0..1。芯まわりで暖域の舌が切り離される所。
  public occludedCoreAt(direction: Vec3Node): FloatNode {
    return exp(this.normalizedChordSquared(direction, OCCLUDED_CORE_RADIUS).negate())
      .mul(this.occlusionStrength());
  }
}

export class Cyclones {
  private readonly tropicals: readonly Trough[];
  private readonly lows: readonly Trough[];
  // 気圧降下および台風の眼の強度は種別を問わず累積する。熱帯低気圧・中緯度低気圧ともに同一の計算規則を適用する。
  private readonly troughs: readonly Trough[];

  // 谷を組み、時刻 0 の配置で始める。surfaceRadius は谷を置く天体の半径 [m]、rotationPeriod は
  // その自転周期 [s]。
  public constructor(private readonly surfaceRadius: number, rotationPeriod: number) {
    this.tropicals = Array.from(
      { length: TROPICAL_COUNT }, () => new Trough(surfaceRadius, rotationPeriod));
    this.lows = Array.from({ length: LOW_COUNT }, () => new Trough(surfaceRadius, rotationPeriod));
    this.troughs = [...this.tropicals, ...this.lows];
    this.syncTime(0);
  }

  // 時刻 [s] における配置を uniform へ反映する。
  public syncTime(seconds: number): void {
    for (const [i, tropical] of this.tropicals.entries()) {
      tropical.place(tropicalPlacementAt(i, seconds));
    }
    for (const [i, low] of this.lows.entries()) {
      low.place(lowPlacementAt(i, seconds, this.surfaceRadius));
    }
  }

  // 単位方向 direction での気圧の落ち込みの合計 [hPa](0 以下)。
  public pressureAt(direction: Vec3Node): FloatNode {
    return this.troughs.reduce<FloatNode>((sum, trough) => sum.add(trough.pressureAt(direction)), float(0));
  }

  // 単位方向 direction での眼の濃さの合計 0..1。
  public eyeAt(direction: Vec3Node): FloatNode {
    return this.troughs.reduce<FloatNode>((sum, trough) => sum.add(trough.eyeAt(direction)), float(0));
  }

  // 単位方向 direction での金床の濃さの合計 0..1。
  public anvilAt(direction: Vec3Node): FloatNode {
    return this.troughs.reduce<FloatNode>((sum, trough) => sum.add(trough.anvilAt(direction)), float(0));
  }

  // 単位方向 direction での乾いた舌の濃さ 0..1。閉塞は中緯度の低気圧だけが持つ — 重なった所で
  // 二重に乾かないよう、合計ではなく最も強いものを取る。
  public dryTongueAt(direction: Vec3Node): FloatNode {
    return this.lows.reduce<FloatNode>((acc, trough) => max(acc, trough.dryTongueAt(direction)), float(0));
  }

  // 単位方向 direction でのコンマの頭の濃さ 0..1。
  public commaHeadAt(direction: Vec3Node): FloatNode {
    return this.lows.reduce<FloatNode>((acc, trough) => max(acc, trough.commaHeadAt(direction)), float(0));
  }

  // 単位方向 direction での閉塞した芯の濃さ 0..1。
  public occludedCoreAt(direction: Vec3Node): FloatNode {
    return this.lows.reduce<FloatNode>((acc, trough) => max(acc, trough.occludedCoreAt(direction)), float(0));
  }
}
