// 天体暦: 恒星→惑星-衛星系重心→惑星/衛星の順に合成し(重心補正込み)、任意時刻の ECI
// 位置・速度・重力源配列・回転基準系・ラグランジュ点を返すサンプラ。分岐は SOLAR_SYSTEM の
// kind(恒星/惑星/衛星)だけで、固有名の分岐は持たない。ECI 化は「日心位置 − 地球の日心位置」
// の一箇所のみ(地球は自分自身を引くので厳密に 0 になる)。
// 評価結果は時刻 t をキーにした固定長リングでメモ化する。ヒットするのはキーが厳密に一致した
// ときだけで、ミス時は常に再計算するため、どの順に呼んでも返る値は変わらない(呼び出し順に
// 依存する隠れた制約を作らない)。
// THREE/DOM 非依存の純関数群 + 状態(初期位相とメモ)を持つサンプラクラス。
import { Quat, qRotate } from './attitude';
import { Attractor, AttractorId, Degree2Gravity, OrbitingId, PlanetId, SatelliteId } from './attractor';
import { cassiniSpinAxis, meridianDirection, orthogonalizedTo, spinPhaseOf } from './body-orientation';
import { ECI_POLE, ECL_POLE_ECI, raDecToEci } from './ecliptic';
import { ReferenceFrame, FrameTransform } from './frame';
import { FrameRotation, KeplerOrbit, keplerOrbitMeanDirection, keplerOrbitNormal, keplerOrbitRotation, keplerOrbitState } from './kepler-orbit';
import { LagrangePoints, lagrangePoints } from './lagrange';
import { planetAngles } from './planet-orbit';
import { satelliteState } from './satellite-orbit';
import { bodyDef, CelestialBodyDef, SOLAR_SYSTEM } from './solar-system';
import { KinematicState, kinematicState } from './kinematic-state';
import { Vec3, add, addScaled, len, norm, scale, sub, v3 } from './vec3';

// 天体の自転軸(単位ベクトル、ECI)と、その軸まわりの自転位相 [rad]。
export type BodyOrientation = { readonly axis: Vec3; readonly spinAngle: number };

const JULIAN_CENTURY = 36525 * 86400; // [s]
const DAY = 86400; // [s]

// 全天体の軌道評価時刻へ一律に足す定数 [s]。要素の元期は J2000 のままにしたうえで、
// simTime = 0 をゲーム開始にふさわしい瞬間 — 地球から見て太陽が +X 方向(昼側)にある、
// すなわち地球の日心黄経が π になる瞬間 — へ合わせる。
// 導出: 地球の平均黄経 L(t) = l0 + L̇·t を L = 180° と置いて解く。
//   (180° − 100.46457166°) / 35999.37244981 [deg/Cy] × JULIAN_CENTURY = 6.9721972e6 s。
// 中心差(真黄経と平均黄経の差)は地球の e = 0.0167 で高々 ±1.9° あるが、この定数は
// 見た目の昼夜を合わせるためのアンカーなので平均黄経で足りる。
export const EPOCH_T_OFFSET = 6972197.1872752225;

// 回転しない座標系(ReferenceFrame.rotatingWith === null)の姿勢・角速度。
const IDENTITY_ROTATION: FrameRotation = { q: { x: 0, y: 0, z: 0, w: 1 } as Quat, omega: v3() };

type PlanetDef = Extract<CelestialBodyDef, { readonly kind: 'planet' }>;
type SatelliteDef = Extract<CelestialBodyDef, { readonly kind: 'satellite' }>;
type OrbitingDef = PlanetDef | SatelliteDef;

// 天体 id の一覧、および attractorsAt が返す重力源配列の順序。SOLAR_SYSTEM の宣言順が
// そのまま順序になるので、天体を増やしても足す場所はレジストリだけで済む。
// (Object.keys は string[] を返すため、キー型の復元にだけキャストを使う。)
const ATTRACTOR_IDS = Object.keys(SOLAR_SYSTEM) as AttractorId[];

// 重力積分の対象になる天体の一覧(宣言順)。
const GRAVITY_SOURCE_IDS = ATTRACTOR_IDS.filter((id) => bodyDef(id).gravitySource);

// 惑星 planet を回る衛星の id 一覧。
function satellitesOf(planet: PlanetId): readonly SatelliteId[] {
  const ids: SatelliteId[] = [];
  for (const id of ATTRACTOR_IDS) {
    const def = bodyDef(id);
    if (def.kind === 'satellite' && def.planet === planet) ids.push(def.id);
  }
  return ids;
}

// 公転している天体の二体部分の軌道。衛星は周期摂動項を含まない平均要素(kepler)を持つ。
function keplerOrbitOf(def: OrbitingDef): KeplerOrbit {
  return def.kind === 'planet' ? def.orbit : def.orbit.kepler;
}

// 時刻キャッシュの保持段数。同一ループ内で t と t + dt/2 を交互に引く経路や、対象ごとに
// 異なる先端時刻を引く経路があるため、1段では主要経路のヒット率が 0 になる。
const TIME_CACHE_SLOTS = 4;

// 時刻 t をキーにした固定長リング。キーが厳密に一致したときだけ値を返し、それ以外は undefined。
class TimeRing<T> {
  private readonly keys: number[] = new Array(TIME_CACHE_SLOTS).fill(NaN);
  private readonly values: (T | undefined)[] = new Array(TIME_CACHE_SLOTS).fill(undefined);
  private next = 0;

  // t に一致する保持値。無ければ undefined。
  get(t: number): T | undefined {
    for (let i = 0; i < TIME_CACHE_SLOTS; i++) {
      if (this.keys[i] === t) return this.values[i];
    }
    return undefined;
  }

  // t をキーに value を最古の段へ書き、その value をそのまま返す。
  put(t: number, value: T): T {
    this.keys[this.next] = t;
    this.values[this.next] = value;
    this.next = (this.next + 1) % TIME_CACHE_SLOTS;
    return value;
  }

  // 全段を空にする。
  clear(): void {
    this.keys.fill(NaN);
    this.values.fill(undefined);
    this.next = 0;
  }
}

export class Ephemeris {
  // 天体ごとの平均黄経の初期オフセット。既定は月のみ乱数(現行の挙動)。テストは決定的な
  // 位相を渡すためコンストラクタで上書きする。セーブ/ロードは setPhaseOffsets で書き換える
  // (共有インスタンスを差し替えないため)。
  private phaseOffsets: Partial<Record<AttractorId, number>>;

  // 天体ごとの中間結果と、2つの重力源窓の時刻キャッシュ。位相オフセットを差し替えたら
  // すべて破棄する。
  private readonly planetHelioCache = new Map<PlanetId, TimeRing<KinematicState>>();
  private readonly satelliteRelCache = new Map<SatelliteId, TimeRing<KinematicState>>();
  private readonly allAttractorsCache = new TimeRing<readonly Attractor[]>();
  private readonly gravityAttractorsCache = new TimeRing<readonly Attractor[]>();

  constructor(phaseOffsets: Partial<Record<AttractorId, number>> = { moon: Math.random() * 2 * Math.PI }) {
    this.phaseOffsets = phaseOffsets;
  }

  // 現在の位相オフセットのスナップショット(セーブ用)。
  getPhaseOffsets(): Partial<Record<AttractorId, number>> {
    return { ...this.phaseOffsets };
  }

  // 位相オフセットを丸ごと差し替える(ロード用)。同じ時刻でも返る値が変わるので、
  // 時刻キャッシュはすべて破棄する。
  setPhaseOffsets(phaseOffsets: Partial<Record<AttractorId, number>>): void {
    this.phaseOffsets = phaseOffsets;
    for (const ring of this.planetHelioCache.values()) ring.clear();
    for (const ring of this.satelliteRelCache.values()) ring.clear();
    this.allAttractorsCache.clear();
    this.gravityAttractorsCache.clear();
  }

  // id の平均黄経の初期位相(未指定なら 0)。
  private phaseOf(id: AttractorId): number {
    return this.phaseOffsets[id] ?? 0;
  }

  // 惑星-衛星系重心の日心状態。
  private baryHelioState(def: PlanetDef, t: number): KinematicState {
    const s = keplerOrbitState(def.orbit, t + EPOCH_T_OFFSET, this.phaseOf(def.id));
    return kinematicState(t, s.r, s.v);
  }

  // 衛星の惑星相対状態。太陽の方向は惑星-衛星系重心の軌道が持つ平均角度(planetAngles)
  // から取るので循環しない。
  private satelliteRelState(def: SatelliteDef, t: number): KinematicState {
    let ring = this.satelliteRelCache.get(def.id);
    if (ring === undefined) {
      ring = new TimeRing<KinematicState>();
      this.satelliteRelCache.set(def.id, ring);
    }
    const cached = ring.get(t);
    if (cached !== undefined) return cached;
    return ring.put(t, this.computeSatelliteRelState(def, t));
  }

  // 衛星の惑星相対状態そのもの(キャッシュを経由しない評価)。
  private computeSatelliteRelState(def: SatelliteDef, t: number): KinematicState {
    const planet = bodyDef(def.planet);
    const te = t + EPOCH_T_OFFSET;
    const pAngles = planetAngles(planet.orbit, te, this.phaseOf(planet.id));
    const s = satelliteState(def.orbit, pAngles, te, this.phaseOf(def.id));
    return kinematicState(t, s.r, s.v);
  }

  // 惑星本体の日心状態。重心の日心状態から、Σ(μ_衛星/(μ_惑星+Σμ_衛星))·r_衛星(惑星相対)
  // ぶんを引く(重心補正。位置・速度の両方に効く)。
  private planetHelioState(def: PlanetDef, t: number): KinematicState {
    let ring = this.planetHelioCache.get(def.id);
    if (ring === undefined) {
      ring = new TimeRing<KinematicState>();
      this.planetHelioCache.set(def.id, ring);
    }
    const cached = ring.get(t);
    if (cached !== undefined) return cached;
    return ring.put(t, this.computePlanetHelioState(def, t));
  }

  // 惑星本体の日心状態そのもの(キャッシュを経由しない評価)。
  private computePlanetHelioState(def: PlanetDef, t: number): KinematicState {
    const bary = this.baryHelioState(def, t);
    const satellites = satellitesOf(def.id);
    if (satellites.length === 0) return bary;

    // 重心を分け合う全質量(惑星本体 + 全衛星)に対する各衛星の比で、重心から差し引く量を決める。
    let muTotal = def.mu;
    for (const s of satellites) muTotal += bodyDef(s).mu;

    let r = bary.r;
    let v = bary.v;
    for (const s of satellites) {
      const satDef = bodyDef(s);
      const rel = this.satelliteRelState(satDef, t);
      const w = satDef.mu / muTotal;
      r = addScaled(r, rel.r, -w);
      v = addScaled(v, rel.v, -w);
    }
    return kinematicState(t, r, v);
  }

  // 天体の日心状態(恒星は原点に静止、惑星は重心補正込みの本体、衛星は惑星本体 + 惑星相対状態)。
  private helioStateOf(id: AttractorId, t: number): KinematicState {
    const def = bodyDef(id);
    switch (def.kind) {
      // 恒星は日心座標系の原点そのもの。
      case 'star':
        return kinematicState(t, v3(0, 0, 0), v3(0, 0, 0));
      case 'planet':
        return this.planetHelioState(def, t);
      // 衛星の日心状態は、惑星本体の日心状態に惑星相対状態を足すだけ。
      case 'satellite': {
        const planetHelio = this.planetHelioState(bodyDef(def.planet), t);
        const rel = this.satelliteRelState(def, t);
        return kinematicState(t, add(planetHelio.r, rel.r), add(planetHelio.v, rel.v));
      }
    }
  }

  // 指定時刻の ECI(地球中心)位置・速度。日心状態から地球の日心状態を引く一箇所だけで
  // ECI 化する。地球自身は同じ計算を2回引くので厳密に 0 になる。
  stateOf(id: AttractorId, t: number): KinematicState {
    const helio = this.helioStateOf(id, t);
    const earthHelio = this.helioStateOf('earth', t);
    return kinematicState(t, sub(helio.r, earthHelio.r), sub(helio.v, earthHelio.v));
  }

  // 指定時刻の ECI 位置。
  positionOf(id: AttractorId, t: number): Vec3 {
    return this.stateOf(id, t).r;
  }

  // 天体 id に固定した回転基準系(x̂ = 中心天体→id、ẑ = 軌道面法線)。中心は分類から決まる
  // (惑星なら恒星、衛星ならその惑星)。衛星の周期項は平均要素に含めないので、この基底は
  // 実位置の x̂ 軸から最大 2.5° ほどずれる(satellite-orbit.ts 参照)。
  orbitFrameRotationAt(id: OrbitingId, t: number): FrameRotation {
    return keplerOrbitRotation(keplerOrbitOf(bodyDef(id)), t + EPOCH_T_OFFSET, this.phaseOf(id));
  }

  // id の軌道面の法線(単位ベクトル、ECI)。
  orbitNormalAt(id: OrbitingId, t: number): Vec3 {
    return keplerOrbitNormal(keplerOrbitOf(bodyDef(id)), t + EPOCH_T_OFFSET, this.phaseOf(id));
  }

  // secondary(公転している天体)を副天体とする円制限三体問題のラグランジュ点。中心天体
  // (主天体)は分類から決まる(惑星なら恒星、衛星ならその惑星)。回転系は orbitFrameRotationAt(id)
  // の姿勢(x̂ = 主天体→副天体)そのものを使う。
  lagrangeAt(secondary: OrbitingId, t: number): LagrangePoints {
    const def = bodyDef(secondary);
    const primary: AttractorId = def.kind === 'planet' ? 'sun' : def.planet;
    const primaryPos = this.positionOf(primary, t);
    const secondaryPos = this.positionOf(secondary, t);
    const R = len(sub(secondaryPos, primaryPos));
    const { q } = this.orbitFrameRotationAt(secondary, t);
    const mu = def.mu / (bodyDef(primary).mu + def.mu);
    return lagrangePoints(mu, (x, y) => add(primaryPos, qRotate(q, v3(R * x, R * y, 0))));
  }

  // 太陽方向の単位ベクトル(ライティング・影判定用)。恒星が太陽1つであることは固有名でよい。
  sunDirAt(t: number): Vec3 {
    return norm(this.positionOf('sun', t));
  }

  // ReferenceFrame の時刻 t における剛体運動。原点は frame.center の状態、回転は frame.rotatingWith が
  // null なら恒等、そうでなければその天体自身の回転基準系。分岐は null 判定だけで、
  // 恒星/惑星/衛星の分類には関与しない。rotatingWith が非 null のとき常に公転している天体を
  // 指す(恒星は自身の公転を持たないので rotatingWith になり得ない)ことは ReferenceFrame の構築側
  // (frame.ts の FRAMES、または呼び出し側)が保証する。
  frameTransformAt(frame: ReferenceFrame, t: number): FrameTransform {
    const origin = this.stateOf(frame.center, t);
    const { q, omega } = frame.rotatingWith === null
      ? IDENTITY_ROTATION
      : this.orbitFrameRotationAt(frame.rotatingWith, t);
    return { origin: origin.r, originVel: origin.v, q, omega };
  }

  // 天体の自転軸(単位ベクトル、ECI)と、その軸まわりの自転位相 [rad]。自転軸を持たない天体は null。
  // 位相は body-orientation.ts の基準方向(天体赤道と ECI 赤道の昇交点)から測る。
  poleAt(id: AttractorId, t: number): BodyOrientation | null {
    return this.orientationOf(bodyDef(id), t);
  }

  // poleAt の本体。分岐は PoleModel の分類だけで、固有名は持たない。
  private orientationOf(def: CelestialBodyDef, t: number): BodyOrientation | null {
    if (def.kind === 'star' || def.pole === undefined) return null;
    const model = def.pole;
    const te = t + EPOCH_T_OFFSET;
    // 'eciPole' は ECI の極軸そのもの。位相の原点は春分点方向に取る。
    if (model.kind === 'eciPole') return { axis: ECI_POLE, spinAngle: 0 };
    if (model.kind === 'iau') {
      const cy = te / JULIAN_CENTURY;
      const axis = raDecToEci(
        model.ra0Deg + model.ra1DegPerCentury * cy,
        model.dec0Deg + model.dec1DegPerCentury * cy,
      );
      const w = (model.w0Deg + model.wRateDegPerDay * (te / DAY)) * (Math.PI / 180);
      return { axis, spinAngle: w };
    }
    // 同期回転する衛星は、軌道面法線から傾いた自転軸のまわりで本初子午線が親を向き続ける。
    // 一様自転する本初子午線は真黄経ではなく平均黄経を追うため、向きは真近点角では表せない。
    const orbit = keplerOrbitOf(def);
    const phase = this.phaseOf(def.id);
    const axis = cassiniSpinAxis(ECL_POLE_ECI, keplerOrbitNormal(orbit, te, phase), model.obliquity);
    const toPrimary = scale(keplerOrbitMeanDirection(orbit, te, phase), -1);
    return { axis, spinAngle: spinPhaseOf(axis, toPrimary) };
  }

  // 天体の2次重力場を時刻 t の姿勢込みで解決する。2次重力場を持たない天体は null。
  // 主軸座標系の長軸は本初子午線と同じ向き(C22 項は2回対称なので符号は効かない)。
  private degree2At(def: CelestialBodyDef, t: number): Degree2Gravity | null {
    if (def.kind === 'star' || def.degree2 === undefined) return null;
    const orientation = this.orientationOf(def, t);
    if (orientation === null) return null;
    const model = def.degree2;
    const tesseral = model.c22 === 0 ? null : {
      c22: model.c22,
      longAxis: orthogonalizedTo(orientation.axis, meridianDirection(orientation.axis, orientation.spinAngle)),
    };
    return { j2: model.j2, refRadius: model.refRadius, pole: orientation.axis, tesseral };
  }

  // 指定時刻の全登録天体(SOLAR_SYSTEM の宣言順)。地球は原点に静止。遮蔽判定・表面接触・
  // 中心天体解決・積分刻み・基準天体解決が読む共通の窓。
  // 同一 t には同一の配列参照が返るので、**呼び出し側はこの配列と要素を書き換えてはならない。**
  attractorsAt(t: number): readonly Attractor[] {
    const cached = this.allAttractorsCache.get(t);
    if (cached !== undefined) return cached;
    return this.allAttractorsCache.put(t, ATTRACTOR_IDS.map((id) => this.attractorAt(id, t)));
  }

  // 指定時刻の重力源一覧(gravitySource が立っている天体のみ、SOLAR_SYSTEM の宣言順)。
  // 重力積分はこちらを引く — RK4 の各ステージ × 全エンティティで舐める配列なので、
  // 表示だけの天体を含めない。
  // attractorsAt と同じく、同一 t には同一の配列参照が返る(書き換え禁止)。
  gravityAttractorsAt(t: number): readonly Attractor[] {
    const cached = this.gravityAttractorsCache.get(t);
    if (cached !== undefined) return cached;
    return this.gravityAttractorsCache.put(t, GRAVITY_SOURCE_IDS.map((id) => this.attractorAt(id, t)));
  }

  // 1天体ぶんの時刻 t での重力源表現。
  private attractorAt(id: AttractorId, t: number): Attractor {
    const def = bodyDef(id);
    return { id, mu: def.mu, radius: def.radius, state: this.stateOf(id, t), degree2: this.degree2At(def, t) };
  }
}
