// 天体1体の運動。**恒星中心まで**の位置・速度・加速度を合成し、自転姿勢・2次重力場・大気・
// 公転回転基準系を時刻から答える。原点をどこに置くかは系レベルの選択なので、ECI 化は
// celestial-body-windows.ts が行い、ここは原点天体を知らない。
// 恒星/惑星/衛星の違いはクラスで表し、衛星・惑星と系の重心の関係は PlanetSystem が持つ。
// 評価結果は時刻 t をキーにした固定長リング(TimeRing)でメモ化する。
// THREE/DOM 非依存。
import { Atmosphere, AtmosphereDef } from './atmosphere';
import { qFromForwardUp } from './attitude';
import { HelioEphemeris } from './absolute-ephemeris';
import { Degree2Gravity } from './celestial-body';
import { cassiniSpinAxis, meridianBasisToEci, meridianDirection, orthogonalizedTo, spinPhaseOf } from './body-orientation';
import { ECI_POLE, ECL_POLE_ECI, raDecToEci } from './ecliptic';
import {
  FrameRotation, JULIAN_CENTURY, KeplerOrbit, keplerOrbitMeanDirection, keplerOrbitNormal,
  keplerOrbitForSimZero, keplerOrbitRotation,
} from './kepler-orbit';
import { collinearClearanceRatio, hasStableTriangularPoints } from './lagrange';
import type { PlanetSystem } from './planet-system';
import { SatelliteOrbit, satelliteOrbitForSimZero, satelliteState } from './satellite-orbit';
import {
  Degree2GravityDef, PoleModel, RingSystemDef, ShapeDef, poleModelForSimZero,
} from './celestial-body-def';
import {
  KinematicState, addPrimaryRelative, kinematicState, toPrimaryRelative,
} from './kinematic-state';
import { SECONDS_PER_DAY } from './time';
import { TimeCacheStats, TimeRing, addTimeCacheStats } from './time-ring';
import { Vec3, add, addScaled, cross, len, lenSq, norm, scale, v3 } from '../math/vec3';

// 天体の自転軸(単位ベクトル、ECI)と、その軸まわりの自転位相 [rad]。
export type BodyOrientation = { readonly axis: Vec3; readonly spinAngle: number };

// 天体ごとの平均黄経の初期位相 [rad]。未指定の天体は 0 として扱う。
export type PhaseOffsets = Partial<Record<string, number>>;

export type StarDef = { readonly id: string; readonly mu: number; readonly radius: number };
export type PlanetDef = {
  readonly id: string;
  readonly mu: number;
  readonly radius: number;
  readonly orbit: KeplerOrbit; // 中心は必ず恒星で、乗っているのは惑星本体ではなく惑星-衛星系の重心
  readonly pole?: PoleModel; // 省略時は自転軸を持たない
  readonly degree2?: Degree2GravityDef; // 省略時は質点として扱う
  readonly shape?: ShapeDef; // 省略時は radius による真球
  readonly atmosphere?: AtmosphereDef; // 省略時は大気を持たない(抗力・焼失ともに起きない)
  readonly rings?: RingSystemDef; // 省略時は環を持たない
  // ラグランジュ点をフォーカス対象のラベルとして出すかどうか(省略時 = 出さない)。全公転天体で
  // 出すと 5 点 × 天体数のラベルが画面を埋めるので、実際に軌道設計の目標になる系だけを立てる。
  readonly lagrangeLabels?: boolean;
};
// 中心は必ず惑星で、その関係は SatelliteMotion が持つ参照が表す。
export type SatelliteDef = Omit<PlanetDef, 'orbit'> & { readonly orbit: SatelliteOrbit };
export type CelestialBodyDef = StarDef | PlanetDef | SatelliteDef;

// 天体の分類。網羅的な分岐を書きたい呼び出し側のための札で、運動の合成そのものはクラスが担う。
export type CelestialKind = 'star' | 'planet' | 'satellite';

// pole 定義から自転角速度 [rad/s] を取り出す。自転モデルを持たない天体は null。符号は自転の
// 向きを表し、逆行自転する天体では負になる。同期回転の衛星は本初子午線が公転の平均黄経を追うので、
// 自転角速度は公転の平均運動と一致する。歳差は自転の 10⁻⁷ 倍未満なので織り込まない。
export function spinRateOf(def: CelestialBodyDef): number | null {
  if (!('pole' in def)) return null;
  const pole = def.pole;
  if (pole === undefined) return null;
  if (pole.kind === 'eciPole') return pole.spinRate;
  if (pole.kind === 'iau') return (pole.wRateDegPerDay * Math.PI) / 180 / 86400;
  // カッシーニ状態の同期回転は衛星だけが持つ。
  return 'kepler' in def.orbit ? def.orbit.kepler.lRate : null;
}

// 主天体まわりの二体相対加速度 -mu·d/|d|³。d は主天体からの相対位置、mu は両者の mu の和。
function twoBodyAccel(d: Vec3, mu: number): Vec3 {
  const d2 = lenSq(d);
  if (d2 < 1) return v3();
  return scale(d, -mu / (d2 * Math.sqrt(d2)));
}

// 天体の宣言を、平均黄経の初期位相と元期オフセットを畳み込んだ宣言へ写す。これを通した宣言
// だけが CelestialMotion へ渡ってよい — 軌道も自転モデルも simTime そのものを引数に取る形に
// なり、評価のたびに巨大な定数を足し直さずに済む。
export function planetDefForSimZero(def: PlanetDef, phases: PhaseOffsets, simZeroEt: number): PlanetDef {
  return {
    ...def,
    orbit: keplerOrbitForSimZero(def.orbit, phases[def.id] ?? 0, simZeroEt),
    pole: poleModelForSimZero(def.pole, simZeroEt),
  };
}

export function satelliteDefForSimZero(
  def: SatelliteDef, phases: PhaseOffsets, simZeroEt: number,
): SatelliteDef {
  return {
    ...def,
    orbit: satelliteOrbitForSimZero(def.orbit, phases[def.id] ?? 0, simZeroEt),
    pole: poleModelForSimZero(def.pole, simZeroEt),
  };
}

export abstract class CelestialMotion {
  abstract readonly def: CelestialBodyDef;
  abstract readonly kind: CelestialKind;

  // 主天体。惑星なら恒星(恒星の無い星系では null)、衛星ならその惑星、恒星自身は null。
  abstract get primary(): CelestialMotion | null;

  protected constructor(
    // 高精度暦パック。持たない構成では null。
    protected readonly precise: HelioEphemeris | null,
    // 自転の初期位相 [rad]。eciPole の自転モデルの位相原点をこれだけ進める(iau は w0 が、
    // 同期回転は軌道が位相を持つ)。
    readonly spinPhase0: number = 0,
  ) {}

  get id(): string {
    return this.def.id;
  }

  // 恒星中心の位置・速度。
  abstract helioStateAt(t: number): KinematicState<'helio'>;

  // 恒星中心の加速度。解析式の厳密な二階微分ではなく主天体まわりの二体近似 — 用途は RK4 の
  // 各段の時刻へ位置を外挿する2次補正項なので、この近似の誤差(太陽の潮汐項を落とすぶん、
  // 月で0.5%程度)は結果に効かない。
  abstract helioAccelAt(t: number): Vec3;

  // 自転軸(単位ベクトル、ECI)と、その軸まわりの自転位相 [rad]。自転モデルを持たない天体は null。
  // 位相は body-orientation.ts の基準方向(天体赤道と ECI 赤道の昇交点)から測る。
  abstract orientationAt(t: number): BodyOrientation | null;

  // 2次重力場を時刻 t の姿勢込みで解決する。2次重力場を持たない天体は null。
  abstract degree2At(t: number): Degree2Gravity | null;

  // 大気を時刻 t の自転軸込みで解決する。大気を持たない天体は null。
  abstract atmosphereAt(t: number): Atmosphere | null;

  // 自転に固定した回転基準系(ẑ = 自転軸、x̂ = 本初子午線方向)。自転モデルを持たない天体では null。
  // 逆行自転する天体でも ẑ は IAU の「北極」のままで、逆行は omega の符号に現れる
  // (DEVELOP/SPEC/CELESTIAL.md 8節)— x̂ が IAU の極を基準に定義されているため。
  spinRotationAt(t: number): FrameRotation | null {
    const orientation = this.orientationAt(t);
    const rate = this.spinRate;
    if (orientation === null || rate === null) return null;
    return { q: meridianBasisToEci(orientation.axis, orientation.spinAngle), omega: scale(orientation.axis, rate) };
  }

  // 自転角速度 [rad/s]。自転モデルを持たない天体は null。
  get spinRate(): number | null {
    return spinRateOf(this.def);
  }

  // 保持する時刻キャッシュを合算した照合の累計。恒星は時刻キャッシュを持たない(位置は定数、
  // 姿勢・重力場・大気は無い)ので、既定は空。
  get cacheStats(): TimeCacheStats {
    return { hits: 0, misses: 0 };
  }

  // 暦パックが答えるこの天体の恒星中心位置・速度。パックを持たない・有効期間外・この天体を
  // 答えられないのいずれかなら null。
  packedHelioStateAt(t: number): KinematicState<'helio'> | null {
    const precise = this.precise;
    if (precise === null || !precise.isValidAt(t)) return null;
    return this.packedStateAt(precise, t);
  }

  // 暦パックが収録するこの天体の恒星中心位置・速度。収録されていなければ null。
  protected packedStateAt(precise: HelioEphemeris, t: number): KinematicState<'helio'> | null {
    return precise.hasBody(this.id) ? precise.stateOf(this.id, t) : null;
  }

}

export class StarMotion extends CelestialMotion {
  readonly kind: CelestialKind = 'star';

  constructor(
    readonly def: StarDef, precise: HelioEphemeris | null,
  ) {
    super(precise);
  }

  // 恒星は階層の根。
  get primary(): CelestialMotion | null { return null; }

  // 恒星は日心座標系の原点そのもの。
  helioStateAt(t: number): KinematicState<'helio'> {
    return kinematicState<'helio'>(t, v3(0, 0, 0), v3(0, 0, 0));
  }

  // 日心座標系の原点そのものなので静止している。
  helioAccelAt(): Vec3 {
    return v3();
  }

  // 恒星は自転姿勢を持たない。
  orientationAt(): BodyOrientation | null {
    return null;
  }

  // 恒星は質点として扱う。
  degree2At(): Degree2Gravity | null {
    return null;
  }

  // 恒星は大気を持たない。
  atmosphereAt(): Atmosphere | null {
    return null;
  }
}

export abstract class OrbitingMotion extends CelestialMotion {
  abstract readonly def: PlanetDef | SatelliteDef;

  // 主天体。惑星なら恒星(恒星の無い星系では null)、衛星ならその惑星。
  abstract get primary(): CelestialMotion | null;

  // 二体部分の軌道。衛星は周期摂動項を含まない平均要素。
  abstract get keplerOrbit(): KeplerOrbit;

  // 自分に固定した回転基準系(x̂ = 主天体→自分、ẑ = 軌道面法線)。衛星の周期項は平均要素に
  // 含めないので、この基底は実位置の x̂ 軸から最大 2.5° ほどずれる(satellite-orbit.ts 参照)。
  orbitFrameRotationAt(t: number): FrameRotation {
    // 暦パックが引ける期間では、相対角運動量から基底と角速度をその場で組む。
    const packed = this.packedPrimaryRelStateAt(t);
    if (packed !== null) {
      const h = cross(packed.r, packed.v);
      const xHat = norm(packed.r);
      const zHat = norm(h);
      const yHat = cross(zHat, xHat);
      const q = qFromForwardUp(zHat, yHat);
      if (q !== null) return { q, omega: scale(zHat, len(h) / (len(packed.r) * len(packed.r))) };
    }
    return keplerOrbitRotation(this.keplerOrbit, t);
  }

  // 軌道面の法線(単位ベクトル、ECI)。
  orbitNormalAt(t: number): Vec3 {
    const packed = this.packedPrimaryRelStateAt(t);
    if (packed !== null) return norm(cross(packed.r, packed.v));
    return keplerOrbitNormal(this.keplerOrbit, t);
  }

  // 共線点(L1/L2/L3)が行き先として意味を持つか。副天体が軽いほどヒル半径が縮んで L1 が
  // 表面へ寄るので、副天体半径に対する余裕が minClearanceRatio 倍に満たない系は共線点を
  // 持たないものとして扱う(しきい値はハロー軌道の振幅が収まるかの判断なので、物理定数では
  // なく呼び出し側から受け取る)。
  hasUsableCollinearPoints(minClearanceRatio: number): boolean {
    const mu = this.massRatio;
    if (mu === null || mu <= 0) return false;
    return collinearClearanceRatio(mu, this.keplerOrbit.a, this.def.radius) >= minClearanceRatio;
  }

  // 三角点(L4/L5)が線形安定か(Routh の質量比条件)。
  hasStableTriangularPoints(): boolean {
    const mu = this.massRatio;
    return mu !== null && mu > 0 && hasStableTriangularPoints(mu);
  }

  // 分岐は PoleModel の分類だけで、固有名は持たない。
  orientationAt(t: number): BodyOrientation | null {
    const model = this.def.pole;
    if (model === undefined) return null;
    // 'eciPole' は ECI の極軸そのもの。位相の原点は春分点方向に取り、初期位相 spinPhase0 から
    // 自転ぶんだけ時刻とともに進める。軸は ECI に固定されているため、ここを固定位相にすると
    // spinRotationAt() の omega だけが進み、フレーム姿勢 q が時間変化しなくなる。
    if (model.kind === 'eciPole') {
      const rate = this.spinRate;
      return { axis: ECI_POLE, spinAngle: this.spinPhase0 + (rate === null ? 0 : rate * t) };
    }
    if (model.kind === 'iau') {
      const cy = t / JULIAN_CENTURY;
      const axis = raDecToEci(
        model.ra0Deg + model.ra1DegPerCentury * cy,
        model.dec0Deg + model.dec1DegPerCentury * cy,
      );
      const w = (model.w0Deg + model.wRateDegPerDay * (t / SECONDS_PER_DAY)) * (Math.PI / 180);
      return { axis, spinAngle: w };
    }
    // 同期回転する衛星は、軌道面法線から傾いた自転軸のまわりで本初子午線が親を向き続ける。
    // 一様自転する本初子午線は真黄経ではなく平均黄経を追うため、向きは真近点角では表せない。
    const orbit = this.keplerOrbit;
    const axis = cassiniSpinAxis(ECL_POLE_ECI, keplerOrbitNormal(orbit, t), model.obliquity);
    const toPrimary = scale(keplerOrbitMeanDirection(orbit, t), -1);
    return { axis, spinAngle: spinPhaseOf(axis, toPrimary) };
  }

  // 主軸座標系の長軸は本初子午線と同じ向き(C22 項は2回対称なので符号は効かない)。
  degree2At(t: number): Degree2Gravity | null {
    const model = this.def.degree2;
    if (model === undefined) return null;
    const orientation = this.orientationAt(t);
    if (orientation === null) return null;
    const tesseral = model.c22 === 0 ? null : {
      c22: model.c22,
      longAxis: orthogonalizedTo(orientation.axis, meridianDirection(orientation.axis, orientation.spinAngle)),
    };
    return { j2: model.j2, refRadius: model.refRadius, pole: orientation.axis, tesseral };
  }

  // 大気は自転軸を共回転の軸として要求するので、姿勢を持たない天体は大気を持てない。
  atmosphereAt(t: number): Atmosphere | null {
    const model = this.def.atmosphere;
    if (model === undefined) return null;
    const orientation = this.orientationAt(t);
    if (orientation === null) return null;
    return { ...model, pole: orientation.axis };
  }

  // 主天体に対する質量比 mu = m2/(m1+m2)。主天体が無い、またはどちらかの質量が未測定
  // (mu = 0)なら null — 0 を比として通すと共線点を解く反復が発散し、1 を通すと L1 が
  // 主天体の中心に落ちる。
  private get massRatio(): number | null {
    const primary = this.primary;
    if (primary === null) return null;
    const primaryMu = primary.def.mu;
    if (primaryMu <= 0 || this.def.mu <= 0) return null;
    return this.def.mu / (primaryMu + this.def.mu);
  }

  // 暦パックが自分と主天体の両方を収録している有効期間での、主天体相対の位置・速度。
  // 引けなければ null。
  private packedPrimaryRelStateAt(t: number): KinematicState<'primaryRel'> | null {
    const precise = this.precise;
    const primary = this.primary;
    if (precise === null || primary === null) return null;
    if (!precise.isValidAt(t) || !precise.hasBody(this.id) || !precise.hasBody(primary.id)) return null;
    return toPrimaryRelative(t, precise.stateOf(this.id, t), precise.stateOf(primary.id, t));
  }
}

export class PlanetMotion extends OrbitingMotion {
  readonly kind: CelestialKind = 'planet';

  private readonly helioCache = new TimeRing<KinematicState<'helio'>>();

  // star は主星。恒星を持たない星系では null を渡す。system は自分が属する惑星-衛星系で、
  // 軌道と衛星の一覧はそちらが持つ。spinPhase0 は自転の初期位相 [rad](eciPole の自転
  // モデルを持つ惑星だけが意味を持つ)。**組むときは planet-system.ts の planetSystem()
  // を使う** — 系と本体を結び忘れずに作れる唯一の入口。
  constructor(
    readonly def: PlanetDef, readonly star: StarMotion | null, readonly system: PlanetSystem,
    precise: HelioEphemeris | null, spinPhase0 = 0,
  ) {
    super(precise, spinPhase0);
  }

  get primary(): CelestialMotion | null { return this.star; }
  get keplerOrbit(): KeplerOrbit { return this.system.orbit; }

  // 惑星本体の日心状態。
  helioStateAt(t: number): KinematicState<'helio'> {
    const cached = this.helioCache.get(t);
    if (cached !== undefined) return cached;
    return this.helioCache.put(t, this.computeHelioStateAt(t));
  }

  // 主星まわりの二体加速度。
  helioAccelAt(t: number): Vec3 {
    const starMu = this.star === null ? 0 : this.star.def.mu;
    return twoBodyAccel(this.helioStateAt(t).r, starMu + this.def.mu);
  }

  // 日心状態は自分の ECI 化と全衛星の恒星中心化から引かれるので、1時刻あたり 1 + 衛星数 回に
  // なる。重心補正が全衛星の相対位置を要るぶん重いので、そのぶんをここで畳む。
  get cacheStats(): TimeCacheStats {
    return addTimeCacheStats(super.cacheStats, this.helioCache.stats);
  }

  // 重心の日心状態から、Σ(μ_衛星/(μ_惑星+Σμ_衛星))·r_衛星(惑星相対)ぶんを引く
  // (重心補正。位置・速度の両方に効く)。
  private computeHelioStateAt(t: number): KinematicState<'helio'> {
    const bary = this.system.helioStateAt(t);
    const moons = this.system.satellites;
    if (moons.length === 0) return bary;
    // mu = 0 は「質量が未測定」であって質量0ではない。本体の質量が分からない系では重心の
    // 位置も決まらないので、補正せず本体を重心に置いたままにする — 補正すると衛星の質量比が
    // 1 になり、本体が衛星との距離ぶんまるごとずれる。
    if (this.def.mu <= 0) return bary;

    // 重心を分け合う全質量(惑星本体 + 全衛星)に対する各衛星の比で、重心から差し引く量を決める。
    let muTotal = this.def.mu;
    for (const moon of moons) muTotal += moon.def.mu;

    let r = bary.r;
    let v = bary.v;
    for (const moon of moons) {
      const rel = moon.relStateAt(t);
      const w = moon.def.mu / muTotal;
      r = addScaled(r, rel.r, -w);
      v = addScaled(v, rel.v, -w);
    }
    return kinematicState<'helio'>(t, r, v);
  }
}

export class SatelliteMotion extends OrbitingMotion {
  readonly kind: CelestialKind = 'satellite';

  private readonly relCache = new TimeRing<KinematicState<'primaryRel'>>();

  // system は自分が属する惑星-衛星系。自分をその重心補正の対象として登録するので、惑星本体の
  // 日心状態を初めて引く前に全衛星を作り終えていなければならない。
  constructor(
    readonly def: SatelliteDef, readonly system: PlanetSystem,
    precise: HelioEphemeris | null,
  ) {
    super(precise);
    system.addSatellite(this);
  }

  // 主天体である惑星本体。
  get planet(): PlanetMotion { return this.system.body; }

  get primary(): CelestialMotion { return this.planet; }
  get keplerOrbit(): KeplerOrbit { return this.def.orbit.kepler; }

  // 惑星相対の位置・速度。太陽の方向は系の重心が持つ平均角から取るので、惑星本体の位置に
  // 依存しない。
  relStateAt(t: number): KinematicState<'primaryRel'> {
    const cached = this.relCache.get(t);
    if (cached !== undefined) return cached;
    return this.relCache.put(t, this.computeRelStateAt(t));
  }

  // 惑星本体の日心状態に惑星相対状態を足す。
  helioStateAt(t: number): KinematicState<'helio'> {
    return addPrimaryRelative(this.planet.helioStateAt(t), this.relStateAt(t));
  }

  // 惑星本体の日心加速度に惑星まわりの二体加速度を足す。
  helioAccelAt(t: number): Vec3 {
    return add(
      this.planet.helioAccelAt(t),
      twoBodyAccel(this.relStateAt(t).r, this.planet.def.mu + this.def.mu),
    );
  }

  // 惑星相対の位置は、自分の恒星中心化・加速度・惑星本体の重心補正・暦パックの補完から
  // 引かれるので、1時刻あたり4回前後になる。周期項の総和がそのたびに走るので畳む。
  get cacheStats(): TimeCacheStats {
    return addTimeCacheStats(super.cacheStats, this.relCache.stats);
  }

  // 未収録の衛星は、収録済みの惑星へ惑星相対モデルを足して補う。
  protected override packedStateAt(precise: HelioEphemeris, t: number): KinematicState<'helio'> | null {
    const own = super.packedStateAt(precise, t);
    if (own !== null) return own;
    if (!precise.hasBody(this.planet.id)) return null;
    return addPrimaryRelative(precise.stateOf(this.planet.id, t), this.relStateAt(t));
  }

  // 惑星相対状態そのもの(キャッシュを経由しない評価)。
  private computeRelStateAt(t: number): KinematicState<'primaryRel'> {
    return satelliteState(this.def.orbit, this.system.anglesAt(t), t);
  }
}
