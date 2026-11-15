// 気圧へ書き込む低気圧の谷。熱帯低気圧 1 つと中緯度の低気圧 LOW_COUNT 個の配置(緯度・経度・深さ・
// 短軸の半径・長軸/短軸の比)を時刻ごとに受けて uniform へ写し、単位方向での気圧の落ち込み・眼・金床を
// TSL のグラフで答える。谷は前線の向き(北半球で南西–北東、南半球で北西–南東)へ長い楕円。眼を持つか
// どうかは谷の芯で風が等圧線を横切る角で決まり、締まって深い熱帯低気圧が持つ。
import * as THREE from 'three/webgpu';
import { atan, clamp, dot, exp, float, inverseSqrt, max, mod, select, smoothstep, sqrt, uniform } from 'three/tsl';
import { LOW_COUNT, lowPlacementAt, tropicalPlacementAt } from './cyclone-tracks';
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

// 温暖湿気の輸送路(WCB)が低気圧の前方・極側へ供給する上層の湿りの領域 — 巻雲の盾に
// なる。中心からずれた広い帯で、巻雲の帯の長さは千〜二千 km 級(EUMeTrain)。
const WCB_OFFSET_ALONG = 900e3;
const WCB_OFFSET_EAST = 700e3;
const WCB_LENGTH = 2400e3;
const WCB_WIDTH = 800e3;
// 前線が張るほど低気圧が育つ下限 [hPa]。この深さで帯が 0.5 になる。
const FRONT_DEPTH_HALF = 10;

// ── 低気圧従属の前線(ノルウェーの温帯低気圧モデルの幾何)──────────────────
// 局所座標は「東」と「極方向」に張る接平面 — 方位 φ = atan2(極側変位, 東変位) で、
// この座標では渦向きが両半球で φ 増大に統一される(北半球 CCW = 東→北、
// 南半球 CW = 東→南)。腕は極曲線 φ(ρ) = φ0 + 曲がり·(ρ/半径) で引く。
//
// 寒冷前線 — 中心から赤道側へ長く伸びる雲帯。JMA SatManu: 雲帯の幅 200〜400 km、
// 古典的な例で長さ 1000 km 超(典型 1500〜2500 km)、暖域側(渦向き側)の先行縁に
// 細い対流線(rope cloud)が立ち寒気側へ層状に垂れる非対称の断面、帯は渦状に湾曲。
const COLD_LENGTH = 2.2; // 長さ(半径の倍率)。R≈1000 km で ~2200 km。
const COLD_WIDTH = 150e3; // 帯の半幅 [m] — 雲帯 200〜400 km の芯の σ。
const COLD_BEARING = THREE.MathUtils.degToRad(-115); // 赤道側・やや西寄りの向き。
const COLD_CURVE = 0.3; // 渦向きへの曲がり [rad/半径] — 先端が循環へ沿って巻く。
const COLD_EDGE = 4; // 断面の超ガウス指数 — 鋭い縁。
const COLD_TAPER = 0.45; // 先端へ向けて幅が細くなる割合。
const COLD_ASYMMETRY = 0.55; // 先行(暖域)側の幅比 — 鋭い側。
// 温暖前線 — 中心から下流(東)へ、幅広く縁がぼんやりした雲域。降水帯 200〜300 km +
// 巻雲の盾は表面前線の 600〜900 km 前方まで届くので帯は長く広い。
const WARM_LENGTH = 1.4;
const WARM_WIDTH = 340e3;
const WARM_BEARING = THREE.MathUtils.degToRad(40); // 下流側・やや極寄り。
const WARM_NARROW = THREE.MathUtils.degToRad(50); // 暖域が狭まる量 — 波動期 ~155°
// → 成熟期 ~105°(Shapiro–Keyser の T-bone 90° 級)。
const WARM_TAPER = 0.35;
// 巻き(オクルージョン/コンマ頭) — 中心の極側〜西を渦向きに巻く弧。Schultz &
// Vaughan: catch-up ではなく暖気舌の巻き取りで生じ、最盛期前後に形成、消衰期まで
// 残って更に巻く。EUMeTrain: CF/WF 帯より雲頂が低い(浅い層雲)。
const WRAP_RADIUS = 0.7; // 弧の半径(半径の倍率)。
const WRAP_RADIAL = 0.28; // 弧の太さ(半径の倍率)。
const WRAP_BEARING = THREE.MathUtils.degToRad(140); // 弧の中心(極側-西)。
const WRAP_SPAN = THREE.MathUtils.degToRad(80); // 弧の角幅。
const WRAP_SPIRAL = 0.35; // 弧が西端で外側へ膨らむ量 — 螺旋の巻き。
const WRAP_ONSET = 0.3; // 巻きが立ち始める life(最盛期 0.42 の直前)。
const WRAP_FULL = 0.6;
// ドライスロット — 寒冷前線の帯と雲頭のあいだに南西から巻き込む乾燥下降流の楔
// (Browning; WV では暗帯、可視では晴れ間)。上層の乾きが主だが地表湿度も削る。
const DRY_BEARING = THREE.MathUtils.degToRad(-160);
const DRY_SPAN = THREE.MathUtils.degToRad(38);
const DRY_INNER = 0.35; // 楔の内縁(半径の倍率)。
const DRY_OUTER = 2.0;
const TWO_PI = Math.PI * 2;
const PI = Math.PI;

// 谷 1 つ。配置を uniform に持ち、単位方向での気圧の落ち込み・眼・金床を答える。
export class Trough {
  private readonly center: Vec3Uniform = uniform(new THREE.Vector3());
  // 長軸の向きの単位接ベクトル。
  private readonly axis: Vec3Uniform = uniform(new THREE.Vector3());
  // 温暖湿気輸送路(WCB)がずれる向き(低気圧の前方・ほぼ東)。
  private readonly warmFrontAxis: Vec3Uniform = uniform(new THREE.Vector3());
  // 前線の局所座標の張り方 — 中心での東方向と極方向の単位接ベクトル。
  private readonly frontEast: Vec3Uniform = uniform(new THREE.Vector3());
  private readonly frontPole: Vec3Uniform = uniform(new THREE.Vector3());
  private readonly depth: FloatUniform = uniform(0);
  // 一生の中の時期 0..1 — 前線の張り方が発達・消衰へ沿って変わる。
  private readonly life: FloatUniform = uniform(0);
  // 弦の二乗を芯の尺で測る係数 (天体の半径 / 短軸の半径)²。
  private readonly coreScale: FloatUniform = uniform(0);
  // 長軸に沿う成分を縮める係数 1 − 1 / (長軸/短軸の比)²。0 で円。
  private readonly axisShrink: FloatUniform = uniform(0);
  // 眼の濃さ 0..1。深さと広がりと緯度から出るので、同じ谷でも一生の中で現れて消える。
  private readonly eyeStrength: FloatUniform = uniform(0);

  // surfaceRadius は谷を置く天体の半径 [m]、rotationPeriod はその自転周期 [s]。
  public constructor(private readonly surfaceRadius: number, private readonly rotationPeriod: number) {}

  // 配置 placement を uniform へ設定する。null(存在しない)なら深さと眼の濃さを 0 にする。長軸は東と極側の
  // 北のあいだ — 北半球で南西–北東、南半球で北西–南東。
  public place(placement: CyclonePlacement | null): void {
    if (placement === null) {
      this.depth.value = 0;
      this.eyeStrength.value = 0;
      return;
    }
    const { latitude, longitude, depth, radius, elongation, life } = placement;
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
    // WCB がずれる向き = 東ベクトル (cosLon, 0, −sinLon) − 0.2 × 極側ベクトル(赤道側成分を足す)。
    this.warmFrontAxis.value.set(
      cosLongitude + hemisphere * 0.2 * sinLatitude * sinLongitude,
      -hemisphere * 0.2 * cosLatitude,
      -sinLongitude + hemisphere * 0.2 * sinLatitude * cosLongitude,
    ).normalize();
    // 前線の局所座標 — 東 (cosLon, 0, −sinLon) と極方向 = 北方向ベクトルに半球の符号。
    this.frontEast.value.set(cosLongitude, 0, -sinLongitude);
    this.frontPole.value.set(
      -hemisphere * sinLatitude * sinLongitude,
      hemisphere * cosLatitude,
      -hemisphere * sinLatitude * cosLongitude,
    );
    // 深さ、芯の尺、長軸の縮み、眼、一生の中の時期。
    this.depth.value = depth;
    this.life.value = life;
    this.coreScale.value = (this.surfaceRadius / radius) ** 2;
    this.axisShrink.value = 1 - 1 / elongation ** 2;
    this.eyeStrength.value = eyeStrengthOf(depth, radius, latitude, this.surfaceRadius, this.rotationPeriod);
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

  // centerNode から axisNode の向きへ伸びる帯の濃さ 0..1。帯は中心から長さ length [m] までの
  // 半直線で、横には幅 width [m] のガウスで減る。距離は弦で測る。
  private bandAt(
    direction: Vec3Node, centerNode: Vec3Node, axisNode: Vec3Node,
    lengthM: number, widthM: number,
  ): FloatNode {
    const offset = direction.sub(centerNode);
    const along = dot(offset, axisNode);
    // 帯の軸への射影を 0..長さ へ収め、その分だけ戻した残りが横の距離。
    const clamped = clamp(along, 0, lengthM / this.surfaceRadius);
    const aside = offset.sub(axisNode.mul(clamped));
    return exp(dot(aside, aside).mul(-((this.surfaceRadius / widthM) ** 2)));
  }

  // 温暖湿気の輸送路(WCB)が届ける上層の湿り 0..1。低気圧の前方(東)・極側にずれた、
  // 長軸に沿って伸びた広い領域 — 巻雲の盾になる。
  public wcbAt(direction: Vec3Node): FloatNode {
    const centerNode = this.center
      .add(this.axis.mul(WCB_OFFSET_ALONG / this.surfaceRadius))
      .add(this.warmFrontAxis.mul(WCB_OFFSET_EAST / this.surfaceRadius))
      .normalize();
    const strength = clamp(this.depth.div(FRONT_DEPTH_HALF * 2), 0, 1);
    return this.bandAt(direction, centerNode, this.axis, WCB_LENGTH, WCB_WIDTH).mul(strength);
  }

  // 前線の局所座標 — 東・極側の弦成分と、渦中心を原点にした方位 φ・中心からの距離
  // (半径の倍率)。方位差は ±π に畳む。谷が無い(深さ 0)ときも除算は安全な形にする。
  private frontFrame(direction: Vec3Node): { rho: FloatNode; rN: FloatNode; phi: FloatNode } {
    const offset = direction.sub(this.center);
    const east = dot(offset, this.frontEast);
    const pole = dot(offset, this.frontPole);
    const rho = sqrt(east.mul(east).add(pole.mul(pole)).add(1e-12));
    // rho(弦) × 天体半径 = 距離 [m]、coreScale = (天体半径/半径)² なので rho × √coreScale
    // が半径の倍率になる。
    const rN = rho.mul(sqrt(this.coreScale));
    const phi = atan(pole, east.add(1e-9));
    return { rho, rN, phi };
  }

  // ±π へ畳んだ方位差。
  private wrapAngle(delta: FloatNode): FloatNode {
    return mod(delta.add(PI), TWO_PI).sub(PI);
  }

  // 前線の腕 1 本の濃さ 0..1。帯芯は極曲線 φ(ρ) = bearing + curve·rN。両端で
  // 周りへ溶ける包絡を掛け(中心から離れて立ち先端で消える)、幅は先端へ taper 分細くなる。
  // edge は断面の超ガウス指数(2 = ふつうのガウス、4 = 縁の鋭い帯)。asymmetry < 1 で
  // 渦向き側(先行縁)の幅が asymmetry 倍に絞られ鋭い縁になる。
  private armAt(
    phi: FloatNode, rho: FloatNode, rN: FloatNode,
    bearing: FloatNode, curve: number, lengthR: number,
    widthM: number, edge: number, taper: number, asymmetry: number,
  ): FloatNode {
    const dPhi = this.wrapAngle(phi.sub(bearing.add(rN.mul(curve))));
    // 帯芯からのずれ [m] ≈ 方位差 × 距離。非対称はずれの符号(渦向き側か)で幅を変える。
    const width = float(widthM / this.surfaceRadius)
      .mul(rN.div(lengthR).mul(-taper).add(1))
      .mul(select(dPhi.greaterThan(0), asymmetry, 1));
    const x = dPhi.mul(rho).div(width);
    // 包絡 — 内側で溶け込み(1 点へ収束しない)、先端で消える。
    const envelope = smoothstep(0.12, 0.4, rN)
      .mul(smoothstep(lengthR * 0.65, lengthR, rN).oneMinus());
    return exp(x.abs().pow(edge).negate()).mul(envelope);
  }

  // 低気圧従属の前線の雲の濃さ 0..1。寒冷・温暖・巻きの 3 本を合成し、深さ(発達)で
  // 強さを、life(一生の中の時期)で形を変える。暖域は腕と腕のあいだの三角の領域。
  public frontAt(direction: Vec3Node): FloatNode {
    const { rho, rN, phi } = this.frontFrame(direction);
    const strength = clamp(this.depth.div(FRONT_DEPTH_HALF * 2), 0, 1);
    // 寒冷前線 — 赤道側へ長く、渦状に曲がり、先行縁が鋭い。
    const cold = this.armAt(
      phi, rho, rN,
      float(COLD_BEARING), COLD_CURVE, COLD_LENGTH,
      COLD_WIDTH, COLD_EDGE, COLD_TAPER, COLD_ASYMMETRY,
    );
    // 温暖前線 — 下流へ幅広くぼんやり。暖域が狭まるので向きは成熟へ向けて渦向き側へ回る。
    const warmBearing = float(WARM_BEARING).sub(
      smoothstep(0.15, 0.75, this.life).mul(WARM_NARROW),
    );
    const warm = this.armAt(
      phi, rho, rN,
      warmBearing, 0, WARM_LENGTH,
      WARM_WIDTH, 2, WARM_TAPER, 1,
    );
    // 巻き — 極側〜西を渦向きに巻く弧。半径は方位で膨らませて螺旋にし、最盛期前後に立つ。
    const dWrap = this.wrapAngle(phi.sub(WRAP_BEARING));
    const wrapRadius = clamp(dWrap.div(WRAP_SPAN), -1, 1).mul(WRAP_SPIRAL).add(1).mul(WRAP_RADIUS);
    const wrapAngular = dWrap.div(WRAP_SPAN);
    const wrapRadial = rN.sub(wrapRadius).div(WRAP_RADIAL);
    const wrap = exp(wrapAngular.mul(wrapAngular).negate())
      .mul(exp(wrapRadial.mul(wrapRadial).negate()))
      .mul(smoothstep(WRAP_ONSET, WRAP_FULL, this.life));
    return max(max(cold, warm), wrap).mul(strength);
  }

  // ドライスロットの強さ 0..1 — 寒冷前線の帯と雲頭のあいだへ南西から巻き込む乾燥の楔。
  public drySlotAt(direction: Vec3Node): FloatNode {
    const { rN, phi } = this.frontFrame(direction);
    const strength = clamp(this.depth.div(FRONT_DEPTH_HALF * 2), 0, 1);
    const angular = this.wrapAngle(phi.sub(DRY_BEARING)).div(DRY_SPAN);
    const wedge = exp(angular.mul(angular).negate())
      .mul(smoothstep(DRY_INNER, DRY_INNER + 0.3, rN))
      .mul(smoothstep(DRY_OUTER * 0.55, DRY_OUTER, rN).oneMinus());
    return wedge.mul(strength);
  }
}

export class Cyclones {
  private readonly tropical: Trough;
  private readonly lows: readonly Trough[];
  // 気圧降下および台風の眼の強度は種別を問わず累積する。熱帯低気圧・中緯度低気圧ともに同一の計算規則を適用する。
  private readonly troughs: readonly Trough[];

  // 谷を組み、時刻 0 の配置で始める。surfaceRadius は谷を置く天体の半径 [m]、rotationPeriod は
  // その自転周期 [s]。
  public constructor(private readonly surfaceRadius: number, rotationPeriod: number) {
    this.tropical = new Trough(surfaceRadius, rotationPeriod);
    this.lows = Array.from({ length: LOW_COUNT }, () => new Trough(surfaceRadius, rotationPeriod));
    this.troughs = [this.tropical, ...this.lows];
    this.syncTime(0);
  }

  // 時刻 [s] における配置を uniform へ反映する。
  public syncTime(seconds: number): void {
    this.tropical.place(tropicalPlacementAt(seconds));
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

  // 単位方向 direction での温暖湿気輸送路の湿り 0..1(巻雲の盾の元)。
  public wcbAt(direction: Vec3Node): FloatNode {
    return this.lows.reduce<FloatNode>((sum, trough) => max(sum, trough.wcbAt(direction)), float(0));
  }

  // 単位方向 direction での前線の雲の濃さ 0..1。中緯度の低気圧だけが前線を持つ
  // (熱帯低気圧は温暖・寒冷前線の構造を持たないので除く)。
  public frontAt(direction: Vec3Node): FloatNode {
    return this.lows.reduce<FloatNode>((sum, trough) => max(sum, trough.frontAt(direction)), float(0));
  }

  // 単位方向 direction でのドライスロットの強さ 0..1。
  public drySlotAt(direction: Vec3Node): FloatNode {
    return this.lows.reduce<FloatNode>((sum, trough) => max(sum, trough.drySlotAt(direction)), float(0));
  }
}
