// 天体暦: 恒星→惑星-衛星系重心→惑星/衛星の順に合成し(重心補正込み)、任意時刻の ECI
// 位置・速度・重力源配列・回転基準系・ラグランジュ点を返すサンプラ。分岐は SOLAR_SYSTEM の
// kind(恒星/惑星/衛星)だけで、固有名の分岐は持たない。ECI 化は「日心位置 − 地球の日心位置」
// の一箇所のみ(地球は自分自身を引くので厳密に 0 になる)。
// 評価結果は時刻 t をキーにした固定長リングでメモ化する。ヒットするのはキーが厳密に一致した
// ときだけで、ミス時は常に再計算するため、どの順に呼んでも返る値は変わらない(呼び出し順に
// 依存する隠れた制約を作らない)。
// THREE/DOM 非依存の純関数群 + 状態(初期位相とメモ)を持つサンプラクラス。
import { Quat, qFromForwardUp, qRotate } from './attitude';
import { Attractor, AttractorId, Degree2Gravity, OrbitingId } from './attractor';
import { cassiniSpinAxis, meridianDirection, orthogonalizedTo, spinPhaseOf } from './body-orientation';
import { ECI_POLE, ECL_POLE_ECI, raDecToEci } from './ecliptic';
import { ReferenceFrame, FrameTransform } from './frame';
import { FrameRotation, KeplerOrbit, keplerOrbitMeanDirection, keplerOrbitNormal, keplerOrbitRotation, keplerOrbitState } from './kepler-orbit';
import {
  LagrangePoints, collinearClearanceRatio, hasStableTriangularPoints, lagrangePoints,
} from './lagrange';
import { planetAngles } from './planet-orbit';
import { satelliteState } from './satellite-orbit';
import { bodyDef, CelestialBodyDef, CelestialRegistry, primaryOf, SOLAR_SYSTEM, starOf } from './solar-system';
import { KinematicState, kinematicState } from './kinematic-state';
import { Vec3, add, addScaled, cross, len, norm, scale, sub, v3 } from './vec3';

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

// 公転している天体の二体部分の軌道。衛星は周期摂動項を含まない平均要素(kepler)を持つ。
function keplerOrbitOf(def: OrbitingDef): KeplerOrbit {
  return def.kind === 'planet' ? def.orbit : def.orbit.kepler;
}

// 回転系(rotatingWith が非 null)の原点。衛星は惑星まわりの公転を止めて見せたいので
// その惑星(例: 月回転系は地球中心)、惑星は自分自身(例: 太陽-地球回転系は地球中心のまま、
// 地球自身の公転方向へ向きだけ合わせる。原点ごと恒星へ移した完全な恒星中心系が欲しければ
// {center: starId, rotatingWith: null} を使う)。
function rotatingFrameCenterOf(registry: CelestialRegistry, id: AttractorId): AttractorId {
  const def = bodyDef(registry, id);
  return def.kind === 'satellite' ? def.planet : id;
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
  private readonly planetHelioCache = new Map<AttractorId, TimeRing<KinematicState>>();
  private readonly satelliteRelCache = new Map<AttractorId, TimeRing<KinematicState>>();
  private readonly allAttractorsCache = new TimeRing<readonly Attractor[]>();
  private readonly gravityAttractorsCache = new TimeRing<readonly Attractor[]>();

  // registry の全天体 id、および attractorsAt が返す配列の順序(宣言順)。
  private readonly ids: readonly AttractorId[];
  // ids のうち質量を持つ id(宣言順)。質量が測定されていない天体は mu = 0 で登録され、
  // 重力窓の候補から外れる。どの候補が実際に効くかは位置依存の relevantAttractors が決める。
  private readonly gravityIds: readonly AttractorId[];
  // registry の主星。0個なら null(輻射源・影の計算がそもそも無意味になる — sunDirAt/dynamics.ts の
  // 呼び出し側はその前提で無害なフォールバックを扱う)。
  readonly starId: AttractorId | null;
  // originId 中心・無回転の慣性系。frames の対応要素と同一参照。
  readonly inertialFrame: ReferenceFrame;
  // registry から生成した全天体の慣性系 + 公転天体ぶんの回転系。値は必ずこの配列の要素を
  // 参照する(sampled-line.ts の frame === lastFrame キャッシュ判定が参照同一性を前提にする)。
  readonly frames: readonly ReferenceFrame[];
  // registry に登録されていない id(生存中の重力天体)向けの ReferenceFrame。frames と同じ
  // 参照同一性契約を、初回アクセス時に生成してキャッシュすることで満たす。
  private readonly dynamicFrames = new Map<AttractorId, ReferenceFrame>();

  // registry/originId/epochOffsetSec を省略すると現実の太陽系・地球原点・既定エポックで動く。
  // starId・inertialFrame・frames は registry から1度だけ導出し、以後は参照を使い回す。
  constructor(
    readonly registry: CelestialRegistry = SOLAR_SYSTEM,
    readonly originId: AttractorId = 'earth',
    private readonly epochOffsetSec: number = EPOCH_T_OFFSET,
    phaseOffsets: Partial<Record<AttractorId, number>> = { moon: Math.random() * 2 * Math.PI },
  ) {
    this.phaseOffsets = phaseOffsets;
    this.ids = Object.keys(registry);
    this.gravityIds = this.ids.filter((id) => bodyDef(registry, id).mu > 0);
    this.starId = starOf(registry);
    this.inertialFrame = { center: originId, rotatingWith: null };
    this.frames = [
      this.inertialFrame,
      ...this.ids.filter((id) => id !== originId).map((id) => ({ center: id, rotatingWith: null })),
      ...this.ids
        .filter((id) => bodyDef(registry, id).kind !== 'star')
        .map((id) => ({ center: rotatingFrameCenterOf(registry, id), rotatingWith: id })),
    ];
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

  // planet を回る衛星の id 一覧。
  private satellitesOf(planet: AttractorId): readonly AttractorId[] {
    const ids: AttractorId[] = [];
    for (const id of this.ids) {
      const def = bodyDef(this.registry, id);
      if (def.kind === 'satellite' && def.planet === planet) ids.push(def.id);
    }
    return ids;
  }

  // 惑星-衛星系重心の日心状態。
  private baryHelioState(def: PlanetDef, t: number): KinematicState {
    const s = keplerOrbitState(def.orbit, t + this.epochOffsetSec, this.phaseOf(def.id));
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
    const planet = bodyDef(this.registry, def.planet) as PlanetDef;
    const te = t + this.epochOffsetSec;
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
    const satellites = this.satellitesOf(def.id);
    if (satellites.length === 0) return bary;

    // 重心を分け合う全質量(惑星本体 + 全衛星)に対する各衛星の比で、重心から差し引く量を決める。
    let muTotal = def.mu;
    for (const s of satellites) muTotal += bodyDef(this.registry, s).mu;

    let r = bary.r;
    let v = bary.v;
    for (const s of satellites) {
      const satDef = bodyDef(this.registry, s) as SatelliteDef;
      const rel = this.satelliteRelState(satDef, t);
      const w = satDef.mu / muTotal;
      r = addScaled(r, rel.r, -w);
      v = addScaled(v, rel.v, -w);
    }
    return kinematicState(t, r, v);
  }

  // 天体の日心状態(恒星は原点に静止、惑星は重心補正込みの本体、衛星は惑星本体 + 惑星相対状態)。
  private helioStateOf(id: AttractorId, t: number): KinematicState {
    const def = bodyDef(this.registry, id);
    switch (def.kind) {
      // 恒星は日心座標系の原点そのもの。
      case 'star':
        return kinematicState(t, v3(0, 0, 0), v3(0, 0, 0));
      case 'planet':
        return this.planetHelioState(def, t);
      // 衛星の日心状態は、惑星本体の日心状態に惑星相対状態を足すだけ。
      case 'satellite': {
        const planetHelio = this.planetHelioState(bodyDef(this.registry, def.planet) as PlanetDef, t);
        const rel = this.satelliteRelState(def, t);
        return kinematicState(t, add(planetHelio.r, rel.r), add(planetHelio.v, rel.v));
      }
    }
  }

  // 指定時刻の ECI(originId 中心)位置・速度。日心状態から originId の日心状態を引く一箇所だけで
  // 座標変換する。originId 自身は同じ計算を2回引くので厳密に 0 になる。
  stateOf(id: AttractorId, t: number): KinematicState {
    const helio = this.helioStateOf(id, t);
    const originHelio = this.helioStateOf(this.originId, t);
    return kinematicState(t, sub(helio.r, originHelio.r), sub(helio.v, originHelio.v));
  }

  // 指定時刻の ECI 位置。
  positionOf(id: AttractorId, t: number): Vec3 {
    return this.stateOf(id, t).r;
  }

  // 天体 id に固定した回転基準系(x̂ = 中心天体→id、ẑ = 軌道面法線)。中心は分類から決まる
  // (惑星なら恒星、衛星ならその惑星)。衛星の周期項は平均要素に含めないので、この基底は
  // 実位置の x̂ 軸から最大 2.5° ほどずれる(satellite-orbit.ts 参照)。
  orbitFrameRotationAt(id: OrbitingId, t: number): FrameRotation {
    const def = bodyDef(this.registry, id) as OrbitingDef;
    return keplerOrbitRotation(keplerOrbitOf(def), t + this.epochOffsetSec, this.phaseOf(id));
  }

  // id の軌道面の法線(単位ベクトル、ECI)。
  orbitNormalAt(id: OrbitingId, t: number): Vec3 {
    const def = bodyDef(this.registry, id) as OrbitingDef;
    return keplerOrbitNormal(keplerOrbitOf(def), t + this.epochOffsetSec, this.phaseOf(id));
  }

  // secondary(公転している天体)を副天体とする円制限三体問題のラグランジュ点。中心天体
  // (主天体)は primaryOf が分類から決める(惑星なら registry の恒星、衛星ならその惑星)。
  // 回転系は orbitFrameRotationAt(id) の姿勢(x̂ = 主天体→副天体)そのものを使う。
  lagrangeAt(secondary: OrbitingId, t: number): LagrangePoints {
    const def = bodyDef(this.registry, secondary) as OrbitingDef;
    const primary = primaryOf(this.registry, secondary);
    if (primary === null) throw new Error(`lagrangeAt: ${secondary} に主星が無いレジストリではラグランジュ点は定義できない`);
    const primaryPos = this.positionOf(primary, t);
    const secondaryPos = this.positionOf(secondary, t);
    const R = len(sub(secondaryPos, primaryPos));
    const { q } = this.orbitFrameRotationAt(secondary, t);
    const mu = def.mu / (bodyDef(this.registry, primary).mu + def.mu);
    return lagrangePoints(mu, (x, y) => add(primaryPos, qRotate(q, v3(R * x, R * y, 0))));
  }

  // secondary の主天体に対する質量比 mu = m2/(m1+m2)。主星が無ければ null。
  private massRatioOf(secondary: OrbitingId): number | null {
    const primary = primaryOf(this.registry, secondary);
    if (primary === null) return null;
    const def = bodyDef(this.registry, secondary);
    return def.mu / (bodyDef(this.registry, primary).mu + def.mu);
  }

  // secondary の共線点(L1/L2/L3)が行き先として意味を持つか。副天体が軽いほどヒル半径が
  // 縮んで L1 が表面へ寄るので、副天体半径に対する余裕が minClearanceRatio 倍に満たない系は
  // 共線点を持たないものとして扱う(しきい値はハロー軌道の振幅が収まるかの判断なので、
  // 物理定数ではなく呼び出し側から受け取る)。
  hasUsableCollinearPoints(secondary: OrbitingId, minClearanceRatio: number): boolean {
    const mu = this.massRatioOf(secondary);
    if (mu === null || mu <= 0) return false;
    const def = bodyDef(this.registry, secondary);
    if (def.kind === 'star') return false;
    return collinearClearanceRatio(mu, keplerOrbitOf(def).a, def.radius) >= minClearanceRatio;
  }

  // secondary の三角点(L4/L5)が線形安定か(Routh の質量比条件)。
  hasStableTriangularPoints(secondary: OrbitingId): boolean {
    const mu = this.massRatioOf(secondary);
    return mu !== null && mu > 0 && hasStableTriangularPoints(mu);
  }

  // ECI の点 r から見た恒星方向の単位ベクトル(陰影・日照判定・輻射の向き)。基準点を引数に
  // 取るのは、恒星との位置関係が点ごとに違うため — 惑星間では地心方向で代用できない。
  // 恒星が無いレジストリでは影・輻射圧の計算そのものが無意味になるので、無害な既定方向(+X)を返す。
  sunDirFrom(r: Vec3, t: number): Vec3 {
    return this.starId === null ? v3(1, 0, 0) : norm(sub(this.positionOf(this.starId, t), r));
  }

  // 登録済みの id ならキャッシュ済みの frames/inertialFrame から、そうでなければ
  // dynamicFrames から引く(無ければ生成してキャッシュする)。frames と同じ参照同一性契約を、
  // 生存中の重力天体を回転系の中心にする用途(小惑星など)向けに満たす。
  frameFor(id: AttractorId): ReferenceFrame {
    const registered = this.frames.find((f) => f.center === id && f.rotatingWith === null);
    if (registered !== undefined) return registered;
    let frame = this.dynamicFrames.get(id);
    if (frame === undefined) {
      frame = { center: id, rotatingWith: null };
      this.dynamicFrames.set(id, frame);
    }
    return frame;
  }

  // ReferenceFrame の時刻 t における剛体運動。origin は frame.center の状態、回転は
  // frame.rotatingWith が null なら恒等。非 null のとき、その天体が現在の registry に
  // 登録されていれば解析的な回転基準系(orbitFrameRotationAt)を使う — 既定レジストリでの
  // 月・地球回転系など既存の座標系はこの経路のみを通るので挙動は変わらない。登録されていない
  // (= 生存中の重力天体の)id は、保存された解析軌道を持たないので、attractors から拾った
  // その瞬間の相対状態(x̂ = center→id、ẑ = 相対角運動量方向)から骨組みの基底を組む — 自由な
  // 多体系にとってこれが唯一妥当なモデルであり、長期の解析近似ではない。
  frameTransformAt(frame: ReferenceFrame, t: number, attractors: readonly Attractor[]): FrameTransform {
    const origin = this.frameBodyState(frame.center, t, attractors);
    if (frame.rotatingWith === null) return { origin: origin.r, originVel: origin.v, ...IDENTITY_ROTATION };
    if (frame.rotatingWith in this.registry) {
      const { q, omega } = this.orbitFrameRotationAt(frame.rotatingWith, t);
      return { origin: origin.r, originVel: origin.v, q, omega };
    }
    const body = attractors.find((a) => a.id === frame.rotatingWith);
    if (body === undefined) return { origin: origin.r, originVel: origin.v, ...IDENTITY_ROTATION };
    const rel = sub(body.state.r, origin.r);
    const relVel = sub(body.state.v, origin.v);
    const h = cross(rel, relVel);
    const xHat = norm(rel);
    const zHat = norm(h);
    const yHat = cross(zHat, xHat);
    const q = qFromForwardUp(zHat, yHat) ?? IDENTITY_ROTATION.q;
    const omega = scale(zHat, len(h) / (len(rel) * len(rel)));
    return { origin: origin.r, originVel: origin.v, q, omega };
  }

  // 座標系の中心天体の状態。registry に登録されていない id は attractors から拾う
  // (生存中の重力天体を中心に据えた座標系)。どちらでも見つからなければ ECI 原点に落とす。
  private frameBodyState(id: AttractorId, t: number, attractors: readonly Attractor[]): KinematicState {
    if (id in this.registry) return this.stateOf(id, t);
    return attractors.find((a) => a.id === id)?.state ?? kinematicState(t, v3(), v3());
  }

  // 天体の自転軸(単位ベクトル、ECI)と、その軸まわりの自転位相 [rad]。自転軸を持たない天体は null。
  // 位相は body-orientation.ts の基準方向(天体赤道と ECI 赤道の昇交点)から測る。
  poleAt(id: AttractorId, t: number): BodyOrientation | null {
    return this.orientationOf(bodyDef(this.registry, id), t);
  }

  // poleAt の本体。分岐は PoleModel の分類だけで、固有名は持たない。
  private orientationOf(def: CelestialBodyDef, t: number): BodyOrientation | null {
    if (def.kind === 'star' || def.pole === undefined) return null;
    const model = def.pole;
    const te = t + this.epochOffsetSec;
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

  // 指定時刻の全登録天体(registry の宣言順)。origin は原点に静止。遮蔽判定・表面接触・
  // 中心天体解決・積分刻み・基準天体解決が読む共通の窓。
  // 同一 t には同一の配列参照が返るので、**呼び出し側はこの配列と要素を書き換えてはならない。**
  attractorsAt(t: number): readonly Attractor[] {
    const cached = this.allAttractorsCache.get(t);
    if (cached !== undefined) return cached;
    return this.allAttractorsCache.put(t, this.ids.map((id) => this.attractorAt(id, t)));
  }

  // 指定時刻の重力源一覧(mu を持つ天体のみ、registry の宣言順)。
  // 重力積分はこちらを引く — RK4 の各ステージ × 全エンティティで舐める配列なので、
  // 表示だけの天体を含めない。
  // attractorsAt と同じく、同一 t には同一の配列参照が返る(書き換え禁止)。
  gravityAttractorsAt(t: number): readonly Attractor[] {
    const cached = this.gravityAttractorsCache.get(t);
    if (cached !== undefined) return cached;
    return this.gravityAttractorsCache.put(t, this.gravityIds.map((id) => this.attractorAt(id, t)));
  }

  // 1天体ぶんの時刻 t での重力源表現。
  private attractorAt(id: AttractorId, t: number): Attractor {
    const def = bodyDef(this.registry, id);
    return {
      id, mu: def.mu, radius: def.radius, state: this.stateOf(id, t),
      degree2: this.degree2At(def, t), isStar: def.kind === 'star',
    };
  }
}
