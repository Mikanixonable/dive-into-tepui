// 気圧へ書き込む低気圧の谷。熱帯低気圧 1 つと中緯度の低気圧 LOW_COUNT 個の配置(緯度・経度・
// 深さ・短軸の半径・長軸/短軸の比)を時刻ごとに受け、単位方向での気圧の落ち込み・眼・金床を
// 数値で答える。谷は前線の向き(北半球で南西–北東、南半球で北西–南東)へ長い楕円。眼を持つか
// どうかは谷の芯で風が等圧線を横切る角で決まり、締まって深い熱帯低気圧が持つ。
import { LOW_COUNT, lowPlacementAt, tropicalPlacementAt } from '../../render/cloud/cyclone-tracks';
import { coreCrossingAngle } from './wind-law-cpu';
import * as vec from '../../math/vec3';
import type { CyclonePlacement } from '../../render/cloud/cyclone-tracks';
import type { Vec3 } from '../../math/vec3';

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
const EYE_ANGLE_FULL = 12 * Math.PI / 180;
const EYE_ANGLE_NONE = 16 * Math.PI / 180;

// 金床(平らな天蓋)の広がりも谷自身の広がりに対する比で、眼と同じく芯に貼り付く。天蓋は
// 中心濃密雲域 — 直径 600〜800 km の平らな白い円盤 — なので、最盛期の熱帯低気圧(短軸の半径
// 180〜240 km)で半径 245〜325 km になる比に取る。この形では、この半径の 2/3 まで 0.9 以上に
// 残り、5/6 で 0.72、1.17 倍で 0.08 に落ちる。
const ANVIL_FRACTION = 1.36;

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
  const t = Math.min(1, Math.max(0, (crossing - EYE_ANGLE_FULL) / (EYE_ANGLE_NONE - EYE_ANGLE_FULL)));
  return 1 - t * t * (3 - 2 * t);
}

// 谷 1 つの形。配置から組む係数を数値で持つ。
export interface CycloneTroughCpu {
  // 中心の単位方向。
  readonly center: Vec3;
  // 長軸の向きの単位接ベクトル。
  readonly axis: Vec3;
  readonly depth: number; // [hPa]
  // 弦の二乗を芯の尺で測る係数 (天体の半径 / 短軸の半径)²。
  readonly coreScale: number;
  // 長軸に沿う成分を縮める係数 1 − 1 / (長軸/短軸の比)²。
  readonly axisShrink: number;
  // 裾を閉じるガウスの係数 (天体の半径 / TROUGH_REACH)²。
  readonly reachScale: number;
  readonly eyeStrength: number; // 0..1
}

// 配置 placement から谷を組む。surfaceRadius は天体の半径 [m]、rotationPeriod は
// 自転周期 [s]。
export function cycloneTroughCpu(
  placement: CyclonePlacement, surfaceRadius: number, rotationPeriod: number,
): CycloneTroughCpu {
  const { latitude, longitude, depth, radius, elongation } = placement;
  const cosLatitude = Math.cos(latitude);
  const sinLatitude = Math.sin(latitude);
  const cosLongitude = Math.cos(longitude);
  const sinLongitude = Math.sin(longitude);
  const hemisphere = latitude >= 0 ? 1 : -1;
  return {
    center: vec.v3(cosLatitude * sinLongitude, sinLatitude, cosLatitude * cosLongitude),
    axis: vec.norm(vec.v3(
      cosLongitude - hemisphere * sinLatitude * sinLongitude,
      hemisphere * cosLatitude,
      -sinLongitude - hemisphere * sinLatitude * cosLongitude)),
    depth,
    coreScale: (surfaceRadius / radius) ** 2,
    axisShrink: 1 - 1 / elongation ** 2,
    reachScale: (surfaceRadius / TROUGH_REACH) ** 2,
    eyeStrength: eyeStrengthOf(depth, radius, latitude, surfaceRadius, rotationPeriod),
  };
}

// 時刻 seconds [s] における全谷(熱帯低気圧 1 つと中緯度の低気圧 LOW_COUNT 個)。
export function cycloneTroughsAtCpu(
  seconds: number, surfaceRadius: number, rotationPeriod: number,
): CycloneTroughCpu[] {
  const troughs: CycloneTroughCpu[] = [];
  const tropical = tropicalPlacementAt(seconds);
  if (tropical !== null) troughs.push(cycloneTroughCpu(tropical, surfaceRadius, rotationPeriod));
  for (let index = 0; index < LOW_COUNT; index += 1) {
    const placement = lowPlacementAt(index, seconds, surfaceRadius);
    if (placement !== null) {
      troughs.push(cycloneTroughCpu(placement, surfaceRadius, rotationPeriod));
    }
  }
  return troughs;
}

// 中心からの弦の二乗。距離を弦で測るので、対蹠点に鏡像が出ない。長軸に沿う成分は axisShrink の
// 分だけ縮めて測るので、谷はその向きへ長軸/短軸の比の倍に広がる。
function chordSquaredCpu(trough: CycloneTroughCpu, direction: Vec3): number {
  const offset = vec.sub(direction, trough.center);
  const alongAxis = vec.dot(offset, trough.axis);
  return vec.dot(offset, offset) - alongAxis * alongAxis * trough.axisShrink;
}

// 単位方向 direction での気圧の落ち込み [hPa](負)。芯は短軸の向きに中心から半径で 1/√2 へ
// 落ち、その先は中心からの距離に反比例して裾を引き、TROUGH_REACH のガウスが遠方を閉じる。
export function troughPressureAtCpu(trough: CycloneTroughCpu, direction: Vec3): number {
  const chord = chordSquaredCpu(trough, direction);
  const core = (1 / Math.sqrt(chord * trough.coreScale + 1)) * Math.exp(-chord * trough.reachScale);
  return -core * trough.depth;
}

// 単位方向 direction での台風の眼の強度 0..1(中心で最大、外縁で 0)。急峻なガウス分布のため、
// 半径外側の寄与は実質的に 0 となる。台風の眼が非形成の低気圧では全域で 0。
export function troughEyeAtCpu(trough: CycloneTroughCpu, direction: Vec3): number {
  const normalized = chordSquaredCpu(trough, direction) * trough.coreScale / (EYE_FRACTION ** 2);
  return Math.exp(-normalized) * trough.eyeStrength;
}

// 単位方向 direction での金床の濃さ 0..1(中心で最も濃く、外で 0)。眼と同じく芯に貼り付くが、
// 形は距離の 6 乗の超ガウス — ガウスには縁が無く丘のまま裾へ流れるが、天蓋は半径まで平らに
// 覆って縁で急に終わる。眼を持たない谷では全域で 0。
export function troughAnvilAtCpu(trough: CycloneTroughCpu, direction: Vec3): number {
  const normalized = chordSquaredCpu(trough, direction) * trough.coreScale / (ANVIL_FRACTION ** 2);
  return Math.exp(-(normalized ** 3)) * trough.eyeStrength;
}
