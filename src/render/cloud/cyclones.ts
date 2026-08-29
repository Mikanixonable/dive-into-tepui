// 気圧へ書き込む低気圧の谷: 熱帯を西進する台風 1 つと、中緯度を東進しながら生まれて消える低気圧。
// 中心と深さは時刻の閉じた関数で、どの時刻へ飛んでも同じ配置になる。
import * as THREE from 'three/webgpu';
import { exp, float, length, uniform } from 'three/tsl';
import type { FloatNode, FloatUniform, Vec3Node, Vec3Uniform } from '../tsl-types';

// 台風。中心の緯度 [rad]、時刻 0 の経度 [rad]、西進の速さ [m/s]、深さ [hPa]、半径 [m]。
// 半径は目の大きさではなく、風と雲が渦を巻いて見える範囲。
const TYPHOON_LATITUDE = THREE.MathUtils.degToRad(15);
const TYPHOON_LONGITUDE = THREE.MathUtils.degToRad(140);
const TYPHOON_DRIFT = -8;
const TYPHOON_DEPTH = 50;
const TYPHOON_RADIUS = 1200e3;

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

// 谷 1 つ。中心の単位方向と深さ [hPa] は時刻ごとに書き換わり、半径 [m] は固定。
class Trough {
  public readonly center: Vec3Uniform = uniform(new THREE.Vector3());
  public readonly depth: FloatUniform = uniform(0);

  public constructor(public readonly radius: number) {}

  // 中心を緯度・経度 [rad] で置く。
  public place(latitude: number, longitude: number): void {
    this.center.value.set(
      Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude), Math.cos(latitude) * Math.cos(longitude),
    );
  }

  // 単位方向 direction での気圧の落ち込み [hPa](負)。中心からの距離は弦で測るので、対蹠点に鏡像が出ない。
  public pressureAt(direction: Vec3Node, radiusOfBody: number): FloatNode {
    const chord = length(direction.sub(this.center)).mul(radiusOfBody);
    return exp(chord.div(this.radius).pow(2).negate()).mul(this.depth).negate();
  }
}

export class Cyclones {
  private readonly typhoon = new Trough(TYPHOON_RADIUS);
  private readonly lows: readonly Trough[] = Array.from(
    { length: LOW_COUNT }, (_, i) => new Trough(LOW_RADIUS_MIN + (i / LOW_COUNT) * LOW_RADIUS_SPAN));

  // radius はこの天体の半径 [m]。
  public constructor(private readonly radius: number) {
    this.syncTime(0);
  }

  // 時刻 [s] の配置を uniform へ写す。
  public syncTime(seconds: number): void {
    this.typhoon.depth.value = TYPHOON_DEPTH;
    this.typhoon.place(
      TYPHOON_LATITUDE,
      TYPHOON_LONGITUDE + (TYPHOON_DRIFT / (this.radius * Math.cos(TYPHOON_LATITUDE))) * seconds,
    );

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
      low.place(latitude, longitude);
      low.depth.value = LOW_DEPTH * Math.sin(Math.PI * life);
    }
  }

  // 単位方向 direction での気圧の落ち込みの合計 [hPa](0 以下)。
  public pressureAt(direction: Vec3Node): FloatNode {
    let sum: FloatNode = this.typhoon.pressureAt(direction, this.radius);
    for (const low of this.lows) sum = sum.add(low.pressureAt(direction, this.radius));
    return float(sum);
  }
}
