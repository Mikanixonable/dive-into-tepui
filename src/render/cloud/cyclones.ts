// 気圧へ書き込む低気圧の谷: 熱帯を西進する台風 1 つと、中緯度を東進する低気圧。どちらも寿命の
// 中で生まれて発達して消える。中心と深さは時刻の閉じた関数で、どの時刻へ飛んでも同じ配置になる。
import * as THREE from 'three/webgpu';
import { dot, exp, float, uniform } from 'three/tsl';
import { coreCrossingAngle } from './wind-law';
import type { FloatNode, FloatUniform, Vec3Node, Vec3Uniform } from '../tsl-types';

// 台風。中心の緯度 [rad]、生まれる経度 [rad]、西進の速さ [m/s]、寿命 [s]。雲は平年の雲量の上に
// 乗って初めて凝結のしきい値を超えるので、生まれる経度と寿命は、進路が暖かい海(西太平洋)を
// 出る前に衰えきる長さに取る。
const TYPHOON_LATITUDE = THREE.MathUtils.degToRad(15);
const TYPHOON_LONGITUDE = THREE.MathUtils.degToRad(169);
const TYPHOON_DRIFT = -8;
const TYPHOON_LIFETIME = 9 * 86400;
// 台風の谷は同心の 2 枚。最深 [hPa] と広がり [m] を、深く狭い芯と浅く広い裾で持つ。渦の回る
// 角速度は √深さ / 広がり に比例するので芯が巻きを作り、上昇流は深さから直に出るので裾が雲の傘を
// 500〜1000 km へ広げる。1 枚では両方を持てない — 狭めれば傘が縮み、広げれば巻きが緩む。
const TYPHOON_CORE_DEPTH = 40;
const TYPHOON_CORE_RADIUS = 250e3;
const TYPHOON_SKIRT_DEPTH = 15;
const TYPHOON_SKIRT_RADIUS = 1000e3;

// 目。広がりは谷自身の広がりに対する比で、湿度はその内側で落ちる。目を持つかどうかは、谷の芯で
// 風が等圧線を横切る角で決まる — この角より閉じた谷だけが目を持ち、あいだで滑らかに渡る。
// 狭くて深い台風の芯は 10° で全部持ち、その裾(43°)も中緯度の低気圧(21〜32°)も持たない。
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
  public readonly center: Vec3Uniform = uniform(new THREE.Vector3());
  public readonly depth: FloatUniform = uniform(0);
  // 目の濃さ 0..1。深さと広がりと緯度から出るので、同じ谷でも一生の中で現れて消える。
  public readonly eyeStrength: FloatUniform = uniform(0);

  public constructor(public readonly radius: number, public readonly peakDepth: number) {}

  // 中心を緯度・経度 [rad] へ置き、寿命の中の位置 life(0 で生まれ、0.5 で最盛期、1 で消える)に
  // 応じた深さと目にする。
  public place(latitude: number, longitude: number, life: number): void {
    this.center.value.set(
      Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude), Math.cos(latitude) * Math.cos(longitude),
    );
    this.depth.value = this.peakDepth * Math.sin(Math.PI * life);
    this.eyeStrength.value = 1 - THREE.MathUtils.smoothstep(
      coreCrossingAngle(this.depth.value, this.radius, latitude), EYE_ANGLE_FULL, EYE_ANGLE_NONE);
  }

  // 単位方向 direction での目の濃さ 0..1(中心で最も濃く、外で 0)。
  public eyeAt(direction: Vec3Node, radiusOfBody: number): FloatNode {
    return this.falloff(direction, radiusOfBody, this.radius * EYE_FRACTION).mul(this.eyeStrength);
  }

  // 中心から radius [m] で 1 → 1/e へ落ちるガウス。距離は弦で測るので、対蹠点に鏡像が出ない。
  // 弦は二乗のまま扱う — 長さを取ってから二乗し直すと、平方根と累乗を 1 つずつ余計に踏む。
  public falloff(direction: Vec3Node, radiusOfBody: number, radius: number): FloatNode {
    const offset = direction.sub(this.center);
    return exp(dot(offset, offset).mul(-((radiusOfBody / radius) ** 2)));
  }

  // 単位方向 direction での気圧の落ち込み [hPa](負)。
  public pressureAt(direction: Vec3Node, radiusOfBody: number): FloatNode {
    return this.falloff(direction, radiusOfBody, this.radius).mul(this.depth).negate();
  }
}

export class Cyclones {
  private readonly typhoon: readonly Trough[] = [
    new Trough(TYPHOON_CORE_RADIUS, TYPHOON_CORE_DEPTH),
    new Trough(TYPHOON_SKIRT_RADIUS, TYPHOON_SKIRT_DEPTH),
  ];
  private readonly lows: readonly Trough[] = Array.from(
    { length: LOW_COUNT }, (_, i) => new Trough(LOW_RADIUS_MIN + (i / LOW_COUNT) * LOW_RADIUS_SPAN, LOW_DEPTH));
  // 気圧も目も種類を分けずに足す。台風の芯・裾も低気圧も、同じ 1 つの規則で効く。
  private readonly troughs: readonly Trough[] = [...this.typhoon, ...this.lows];

  // radius はこの天体の半径 [m]。
  public constructor(private readonly radius: number) {
    this.syncTime(0);
  }

  // 時刻 [s] の配置を uniform へ写す。
  public syncTime(seconds: number): void {
    // 台風は寿命ごとに生まれ直す。時刻 0 が最盛期になるよう位相を半周期ずらす。芯と裾は同じ中心で
    // 同じ一生を辿る。
    const typhoonAge = seconds / TYPHOON_LIFETIME + 0.5;
    const typhoonLife = typhoonAge - Math.floor(typhoonAge);
    const typhoonLongitude = TYPHOON_LONGITUDE
      + (TYPHOON_DRIFT / (this.radius * Math.cos(TYPHOON_LATITUDE))) * typhoonLife * TYPHOON_LIFETIME;
    for (const trough of this.typhoon) trough.place(TYPHOON_LATITUDE, typhoonLongitude, typhoonLife);

    // 低気圧は寿命ごとに世代が進み、世代と番号のハッシュで生まれる経度・緯度が決まる。
    for (const [i, low] of this.lows.entries()) {
      const age = seconds / LOW_LIFETIME + i / LOW_COUNT;
      const generation = Math.floor(age);
      const life = age - generation;
      const seed = generation * LOW_COUNT + i;
      const hemisphere = i % 2 === 0 ? 1 : -1;
      const latitude = hemisphere * (LOW_LATITUDE_MIN + hash(seed) * LOW_LATITUDE_SPAN);
      const longitude = hash(seed + 0.5) * 2 * Math.PI
        + (LOW_DRIFT / (this.radius * Math.cos(latitude))) * life * LOW_LIFETIME;
      low.place(latitude, longitude, life);
    }
  }

  // 単位方向 direction での気圧の落ち込みの合計 [hPa](0 以下)。
  public pressureAt(direction: Vec3Node): FloatNode {
    let sum: FloatNode = float(0);
    for (const trough of this.troughs) sum = sum.add(trough.pressureAt(direction, this.radius));
    return sum;
  }

  // 単位方向 direction での目の濃さの合計 0..1。
  public eyeAt(direction: Vec3Node): FloatNode {
    let sum: FloatNode = float(0);
    for (const trough of this.troughs) sum = sum.add(trough.eyeAt(direction, this.radius));
    return sum;
  }
}
