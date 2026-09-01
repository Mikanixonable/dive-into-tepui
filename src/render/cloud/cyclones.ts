// 気圧へ書き込む低気圧の谷: 熱帯を西進する台風 1 つと、中緯度を東進する低気圧。どちらも寿命の
// 中で生まれて発達して消える。中心と深さは時刻の閉じた関数で、どの時刻へ飛んでも同じ配置になる。
import * as THREE from 'three/webgpu';
import { dot, exp, float, inverseSqrt, uniform } from 'three/tsl';
import { R_EARTH } from '../../game/celestial/solar-system/constants';
import { coreCrossingAngle } from './wind-law';
import type { FloatNode, FloatUniform, Vec3Node, Vec3Uniform } from '../tsl-types';

// 台風。中心の緯度 [rad]、生まれる経度 [rad]、西進の速さ [m/s]、寿命 [s]。雲は平年の雲量の上に
// 乗って初めて凝結のしきい値を超えるので、生まれる経度と寿命は、進路が暖かい海(西太平洋)を
// 出る前に衰えきる長さに取る。
const TYPHOON_LATITUDE = THREE.MathUtils.degToRad(15);
const TYPHOON_LONGITUDE = THREE.MathUtils.degToRad(169);
const TYPHOON_DRIFT = -8;
const TYPHOON_LIFETIME = 9 * 86400;
// 台風の最深 [hPa] と広がり [m]。
const TYPHOON_DEPTH = 63;
const TYPHOON_RADIUS = 220e3;

// 谷の効きが届く限界 [m]。裾は距離に反比例するので、1 つでは薄くても谷の数だけ足すと全球の
// 底上げになり、気圧から出る上昇流の基準がまるごと持ち上がる。ここで遠方を閉じる。
const TROUGH_REACH = 2200e3;

// 目。広がりは谷自身の広がりに対する比で、湿度はその内側で落ちる。目を持つかどうかは、谷の芯で
// 風が等圧線を横切る角で決まる — この角より閉じた谷だけが目を持ち、あいだで滑らかに渡る。
// 狭くて深い台風は 10° で全部持ち、中緯度の低気圧(21〜32°)は持たない。
const EYE_FRACTION = 0.4;
const EYE_ANGLE_FULL = THREE.MathUtils.degToRad(12);
const EYE_ANGLE_NONE = THREE.MathUtils.degToRad(16);

// 中緯度の低気圧。同時に持つ数、1 つの寿命 [s]、東進の速さ [m/s]、最深 [hPa]、半径 [m]
// (番号で最小から幅のあいだへ散らす)、中心の緯度の範囲 [rad]。寿命の中で深さは山形に変わり、
// 次の寿命では別の経度に生まれる。
const LOW_COUNT = 10;
const LOW_LIFETIME = 5 * 86400;
const LOW_DRIFT = 12;
const LOW_DEPTH = 18;
const LOW_RADIUS_MIN = 800e3;
const LOW_RADIUS_SPAN = 800e3;
const LOW_LATITUDE_MIN = THREE.MathUtils.degToRad(35);
const LOW_LATITUDE_SPAN = THREE.MathUtils.degToRad(25);

// 整数から 0..1 の決定的な擬似乱数。
function hash(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// 谷 1 つ。中心の単位方向と深さ [hPa] は時刻ごとに書き換わり、広がり radius [m] と最盛期の
// 落ち込み peakDepth [hPa] は固定。
class Trough {
  private readonly center: Vec3Uniform = uniform(new THREE.Vector3());
  private readonly depth: FloatUniform = uniform(0);
  // 目の濃さ 0..1。深さと広がりと緯度から出るので、同じ谷でも一生の中で現れて消える。
  private readonly eyeStrength: FloatUniform = uniform(0);

  public constructor(private readonly radius: number, private readonly peakDepth: number) {}

  // 中心を緯度・経度 [rad] へ置き、寿命の中の位置 life(0 で生まれ、0.5 で最盛期、1 で消える)に
  // 応じた深さと目にする。
  public place(latitude: number, longitude: number, life: number): void {
    this.center.value.set(
      Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude), Math.cos(latitude) * Math.cos(longitude),
    );
    const depth = this.peakDepth * Math.sin(Math.PI * life);
    this.depth.value = depth;
    // 芯(勾配の消える点)での等圧線方向の 2 階微分 [hPa/rad²]。pressureAt の形を原点で開いたもの。
    const coreBend = depth
      * ((R_EARTH / this.radius) ** 2 + 2 * (R_EARTH / TROUGH_REACH) ** 2);
    this.eyeStrength.value = 1 - THREE.MathUtils.smoothstep(
      coreCrossingAngle(coreBend, latitude), EYE_ANGLE_FULL, EYE_ANGLE_NONE);
  }

  // 中心からの弦の二乗。距離を弦で測るので、対蹠点に鏡像が出ない。弦は二乗のまま扱う — 長さを
  // 取ってから二乗し直すと、平方根と累乗を 1 つずつ余計に踏む。
  private chordSquared(direction: Vec3Node): FloatNode {
    const offset = direction.sub(this.center);
    return dot(offset, offset);
  }

  // 単位方向 direction での気圧の落ち込み [hPa](負)。中心から radius で 1/√2 へ落ち、その先は
  // 中心からの距離に反比例して裾を引き、TROUGH_REACH のガウスが遠方を閉じる。
  //
  // **裾の緩さを決めるのは対数傾き。** 反比例の裾は傾きが一桁ぶんの半径をかけて渡るので、風向も
  // 移流の伸びも半径に沿って滑らかに緩む。芯の巻きは 深さ/広がり² が単独で握り、裾と別に動かせる。
  public pressureAt(direction: Vec3Node): FloatNode {
    const chordSquared = this.chordSquared(direction);
    return inverseSqrt(chordSquared.mul((R_EARTH / this.radius) ** 2).add(1))
      .mul(exp(chordSquared.mul(-((R_EARTH / TROUGH_REACH) ** 2))))
      .mul(this.depth).negate();
  }

  // 単位方向 direction での目の濃さ 0..1(中心で最も濃く、外で 0)。気圧と違って裾を引かない
  // ガウスで、谷の芯より内側にだけ効く。
  public eyeAt(direction: Vec3Node): FloatNode {
    const radius = this.radius * EYE_FRACTION;
    return exp(this.chordSquared(direction).mul(-((R_EARTH / radius) ** 2))).mul(this.eyeStrength);
  }
}

export class Cyclones {
  private readonly typhoon: Trough;
  private readonly lows: readonly Trough[];
  // 気圧も目も種類を分けずに足す。台風も低気圧も、同じ 1 つの規則で効く。
  private readonly troughs: readonly Trough[];

  // 谷を組み、時刻 0 の配置で始める。
  public constructor() {
    this.typhoon = new Trough(TYPHOON_RADIUS, TYPHOON_DEPTH);
    this.lows = Array.from({ length: LOW_COUNT },
      (_, i) => new Trough(LOW_RADIUS_MIN + (i / LOW_COUNT) * LOW_RADIUS_SPAN, LOW_DEPTH));
    this.troughs = [this.typhoon, ...this.lows];
    this.syncTime(0);
  }

  // 時刻 [s] の配置を uniform へ写す。
  public syncTime(seconds: number): void {
    // 台風は寿命ごとに生まれ直す。時刻 0 が最盛期になるよう位相を半周期ずらす。
    const typhoonAge = seconds / TYPHOON_LIFETIME + 0.5;
    const typhoonLife = typhoonAge - Math.floor(typhoonAge);
    const typhoonLongitude = TYPHOON_LONGITUDE
      + (TYPHOON_DRIFT / (R_EARTH * Math.cos(TYPHOON_LATITUDE))) * typhoonLife * TYPHOON_LIFETIME;
    this.typhoon.place(TYPHOON_LATITUDE, typhoonLongitude, typhoonLife);

    // 低気圧は寿命ごとに世代が進み、世代と番号のハッシュで生まれる経度・緯度が決まる。
    for (const [i, low] of this.lows.entries()) {
      const age = seconds / LOW_LIFETIME + i / LOW_COUNT;
      const generation = Math.floor(age);
      const life = age - generation;
      const seed = generation * LOW_COUNT + i;
      const hemisphere = i % 2 === 0 ? 1 : -1;
      const latitude = hemisphere * (LOW_LATITUDE_MIN + hash(seed) * LOW_LATITUDE_SPAN);
      const longitude = hash(seed + 0.5) * 2 * Math.PI
        + (LOW_DRIFT / (R_EARTH * Math.cos(latitude))) * life * LOW_LIFETIME;
      low.place(latitude, longitude, life);
    }
  }

  // 単位方向 direction での気圧の落ち込みの合計 [hPa](0 以下)。
  public pressureAt(direction: Vec3Node): FloatNode {
    return this.troughs.reduce<FloatNode>((sum, trough) => sum.add(trough.pressureAt(direction)), float(0));
  }

  // 単位方向 direction での目の濃さの合計 0..1。
  public eyeAt(direction: Vec3Node): FloatNode {
    return this.troughs.reduce<FloatNode>((sum, trough) => sum.add(trough.eyeAt(direction)), float(0));
  }
}
