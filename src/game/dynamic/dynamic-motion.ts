import { Q_IDENTITY } from '../../math/quat';
import { hitsSphere, type Ray } from '../../math/ray';
import type { SphereHit } from '../../math/triangle-mesh';
import type { ContactGeometry } from '../../physics/collision-response';
import { sameVec, type Vec3, v3 } from '../../math/vec3';
import { type Attitude, stepAttitude } from '../../physics/attitude';
import { localOrbitPeriod } from '../../physics/attractor';
import type { CelestialBody } from '../../physics/celestial-body';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import type { KinematicState } from '../../physics/kinematic-state';
import { environmentSampleAt, type DynamicsEnvironmentSample } from '../../physics/dynamics';
import {
  compoundCylinderRaycast,
  type CompoundCylinderRayHit,
  type CompoundCylinderShape,
} from '../../physics/compound-cylinder-contact';
import type { CompoundSphereShape } from '../../physics/compound-sphere-contact';
import { isStar } from '../../physics/celestial-body-def';
import {
  sunlightIrradiance,
} from '../../physics/thermal';
import { orbitalElementsOf, type OrbitalElements } from '../../physics/elements';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { Contact } from './dynamic-entity/contact';
import type { DynamicReactionServices, EntityContactParticipant } from './dynamic-simulation-participant';
import type { EngagementParticipant, EngagementZone } from './engagement-zone';
import {
  collisionPropertiesOf,
  type DynamicCollisionProperties,
  type DynamicCollisionPropertiesSnapshot,
} from './dynamic-motion-collision';
import {
  ENV_TEMP, HULL_EMISS, stepThermalState,
  type DynamicMotionThermal,
} from './dynamic-motion-thermal';
import { PredictedArc, trajectorySampleInterval } from './predicted-arc';
import { atmosphericMaxStep, dragTakesFullAirspeed } from './time-step';

export type {
  DynamicCollisionProperties,
  DynamicCollisionPropertiesSnapshot,
} from './dynamic-motion-collision';
export { ENV_TEMP, HULL_EMISS } from './dynamic-motion-thermal';
export type { DynamicMotionThermal } from './dynamic-motion-thermal';

// 弾道係数の逆数から断面積質量比を戻すときの抗力係数 Cd。
const DRAG_COEFFICIENT = 2.2;
// 1歩ぶんの環境標本が RK4 の4段のとき、平均に掛ける重み。
const RK4_WEIGHTS: readonly number[] = [1, 2, 2, 1];

// 小さな金属片(アルミ相当)の物性。
export const SMALL_DEBRIS_BCINV = 8e-3; // [m^2/kg]
export const SMALL_DEBRIS_SRP_COEFF = 4.7e-3; // [m^2/kg]
export const SMALL_DEBRIS_BULK_DENSITY = 2700; // [kg/m^3]
export const SMALL_DEBRIS_SPECIFIC_HEAT = 900; // [J/(kg·K)]
export const SMALL_DEBRIS_RADIATING_AREA_PER_MASS = 0.01455; // [m^2/kg]
export const SMALL_DEBRIS_MAX_TEMP = 933; // [K]

// 接触した相手を見分ける種別。
export type ContactKind =
  | 'generic' | 'player' | 'radiator-fold' | 'belt-section' | 'bullet' | 'debris' | 'casing'
  | 'enemy' | 'ammo' | 'rcs-fuel';

// 断面積質量比 × 放射率で見積もる、球とみなした個体の日射を吸収する質量あたりの面積 [m^2/kg]。
// bcInv は弾道係数の逆数 [m^2/kg]。
export function sphereSolarAbsorbAreaPerMass(emissivity: number, bcInv: number): number {
  return (emissivity * bcInv) / DRAG_COEFFICIENT;
}

// 種別ごとに差し込む反応。省いたメソッドは DynamicMotion の既定の振る舞いになる。
export interface DynamicMotionBehavior {
  readonly contactKind?: ContactKind;
  contactMass?(self: DynamicMotion): number;
  // simDt ぶんの自律の指令(燃焼など)を進める。
  updateCommands?(self: DynamicMotion, simDt: number): void;
  // 直近の updateCommands が決めた推力加速度(ECI)。噴いていなければ null。
  commandedThrust?(self: DynamicMotion): Vec3 | null;
  contactsWith?(self: DynamicMotion, other: EntityContactParticipant, simTime: number): boolean;
  testSphereCollision?(
    self: DynamicMotion, sphereCenter: Vec3, sphereRadius: number,
    selfState: KinematicState, selfAttitude: Attitude,
  ): SphereHit | null;
  testSweptSphereCollision?(
    self: DynamicMotion, previousSphereCenter: Vec3, sphereCenter: Vec3, sphereRadius: number,
    previousSelfState: KinematicState, selfState: KinematicState,
    previousSelfAttitude: Attitude, selfAttitude: Attitude,
  ): { readonly hit: SphereHit; readonly toi: number } | null;
  testEntityCollision?(
    self: DynamicMotion, other: EntityContactParticipant,
    selfState: KinematicState, otherState: KinematicState,
  ): ContactGeometry | null;
  testSweptEntityCollision?(
    self: DynamicMotion, other: EntityContactParticipant,
    previousSelf: KinematicState, selfState: KinematicState,
    previousOther: KinematicState, otherState: KinematicState,
  ): ContactGeometry | null;
  hitBodyByRay?(self: DynamicMotion, ray: Ray, pos: Vec3): boolean;
  placeContactProxies?(self: DynamicMotion, simTime: number, dt: number): void;
  contactProxies?(self: DynamicMotion): readonly EntityContactParticipant[];
  applyContactProxies?(self: DynamicMotion, dt: number): void;
  onEntityContact?(
    self: DynamicMotion, other: EntityContactParticipant, contact: Contact, services: DynamicReactionServices,
  ): void;
  onSurfaceContact?(
    self: DynamicMotion, body: CelestialBody, contact: Contact, services: DynamicReactionServices,
  ): void;
  onBurnUp?(self: DynamicMotion, services: DynamicReactionServices): void;
  stepEnvironment?(
    self: DynamicMotion, dt: number, atmosphereBody: CelestialBody | null,
    atmospherePivot: number, sunlight: number, sunDir: Vec3,
  ): void;
  // 質量などの状態に応じて変化する物性。省略時は生成時の固定値を使う。
  mass?(self: DynamicMotion): number;
  bcInv?(self: DynamicMotion): number;
  srpCoeff?(self: DynamicMotion): number;
  radiatingAreaPerMass?(self: DynamicMotion): number;
  solarAbsorbAreaPerMass?(self: DynamicMotion, sunDir: Vec3): number;
  nextSimulationEventTime?(self: DynamicMotion, simTime: number): number | null;
  checkLoss?(
    self: DynamicMotion, dt: number, simTime: number, services: DynamicReactionServices,
    zones: readonly EngagementZone<EngagementParticipant>[], atmosphereBodies: readonly CelestialBody[],
  ): void;
}

// DynamicMotion の物性と初期値。省いた項目は既定値になる。
export interface DynamicMotionProperties {
  readonly alive?: boolean;
  readonly attitude?: Attitude;
  readonly hasAttitude?: boolean;
  readonly mass?: number;
  readonly radius?: number;
  readonly collides?: boolean;
  readonly engagementAnchor?: boolean;
  readonly preciseReentry?: boolean;
  readonly contactDamageWeight?: number;
  readonly bcInv?: number;
  readonly srpCoeff?: number;
  readonly temperature?: number;
  readonly thermalDeviation?: number;
  readonly pendingSpecificHeat?: number;
  readonly specificHeat?: number;
  readonly bulkDensity?: number;
  readonly radiatingAreaPerMass?: number;
  readonly emissivity?: number;
  readonly maxTemperature?: number;
  readonly historyDuration?: number;
  readonly followsPredictedArc?: boolean;
  readonly behavior?: DynamicMotionBehavior;
}

const PASSIVE_BEHAVIOR: DynamicMotionBehavior = Object.freeze({ contactKind: 'generic' });

// 1歩ぶんの環境標本を平均した、日照率込みの太陽光の放射照度 [W/m²] と太陽方向(単位ベクトル)。
// radiantIntensity は光源の放射強度 [W/sr]。
function weightedEnvironment(samples: readonly DynamicsEnvironmentSample[], radiantIntensity: number): {
  readonly sunlight: number;
  readonly sunDir: Vec3;
} {
  let weightTotal = 0;
  let sunlight = 0;
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < samples.length; i++) {
    const weight = samples.length === 4 ? RK4_WEIGHTS[i]! : 1;
    const sample = samples[i]!;
    weightTotal += weight;
    sunlight += weight * sunlightIrradiance(radiantIntensity, sample.sunDist, sample.sunlit);
    x += weight * sample.sunDir.x;
    y += weight * sample.sunDir.y;
    z += weight * sample.sunDir.z;
  }
  // 太陽方向は重み付きの和を正規化して平均とする。
  const directionLength = Math.hypot(x, y, z);
  return {
    sunlight: weightTotal > 0 ? sunlight / weightTotal : 0,
    sunDir: directionLength > 0 ? v3(x / directionLength, y / directionLength, z / directionLength) : v3(),
  };
}

// 姿勢を与えられなかった個体の、静止した単位慣性の姿勢。
function identityAttitude(): Attitude {
  return { q: Q_IDENTITY, w: v3(), inertia: v3(1, 1, 1) };
}

// 1体の軌道・姿勢・熱を所有し、予測の弧をキャッシュとして持つ。
export class DynamicMotion {
  public readonly actual: DynamicTrajectory;
  public readonly hasAttitude: boolean;
  public readonly behavior: DynamicMotionBehavior;
  // 姿勢・角速度と主慣性モーメント。慣性は、種別と構成から決まる個体ではキャッシュ。
  private _att: Attitude;
  // 直前の刻みの姿勢(キャッシュ)。
  private _prevAtt: Attitude;
  // シミュレーションに参加しているか。退場は kill で下ろし、戻さない。
  private _alive: boolean;
  // 質量 [kg]。種別と構成から決まるキャッシュ。
  private _mass: number;
  private _radius: number;
  private _centerOfMass: Vec3;
  private _compoundShape: CompoundCylinderShape | null;
  private _surfaceShape: CompoundSphereShape | null;
  private _shapeRevision = 0;
  public readonly collides: boolean;
  public readonly engagementAnchor: boolean;
  public readonly preciseReentry: boolean;
  public readonly contactDamageWeight: number;
  // 本体そのものなので、取り付き先は null。
  public readonly attachedTo = null;
  // 姿勢の積分に加えるトルク。指令から積分の前に毎フレーム書き直すキャッシュ。
  private _torque: Vec3 = v3();
  private readonly fixedBcInv: number;
  private readonly fixedSrpCoeff: number;
  private _temperature: number;
  private _thermalDeviation: number;
  public readonly specificHeat: number;
  public readonly bulkDensity: number;
  public readonly emissivity: number;
  public readonly maxTemperature: number;
  // 予測の弧を保ち、実シミュレーションがその上をなぞって積分を省く個体か。
  public readonly followsPredictedArc: boolean;

  private readonly fixedRadiatingAreaPerMass: number;
  private readonly baseHistoryDuration: number;
  // 予測の弧。実状態から引き直すキャッシュ。
  private predictedArc: PredictedArc | null = null;
  // 需要が求める履歴の長さ [s](キャッシュ)。
  private requestedHistoryDuration = 0;
  private pendingSpecificHeat: number;
  // 推力。指令から積分の前に毎フレーム書き直すキャッシュ。
  private _thrust: Vec3 | null = null;

  // state から始まる軌道を組む。properties で省いた物性と初期値は既定値になる。
  public constructor(state: KinematicState, properties: DynamicMotionProperties = {}) {
    this.actual = new DynamicTrajectory(state);
    // 生死・姿勢・質量と接触
    this._alive = properties.alive ?? true;
    const attitude = properties.attitude ?? identityAttitude();
    const initialCollision = collisionPropertiesOf({
      mass: properties.mass ?? 1,
      radius: properties.radius ?? 0,
      centerOfMass: v3(),
      inertia: attitude.inertia,
      compoundShape: null,
    });
    this._att = { ...attitude, inertia: initialCollision.inertia };
    this._prevAtt = this._att;
    this.hasAttitude = properties.hasAttitude ?? true;
    this._mass = initialCollision.mass;
    this._radius = initialCollision.radius;
    this._centerOfMass = initialCollision.centerOfMass;
    this._compoundShape = initialCollision.compoundShape;
    this._surfaceShape = initialCollision.surfaceShape ?? null;
    this.collides = properties.collides ?? false;
    this.engagementAnchor = properties.engagementAnchor ?? false;
    this.preciseReentry = properties.preciseReentry ?? false;
    this.contactDamageWeight = properties.contactDamageWeight ?? 1;
    // 空力・輻射圧
    this.fixedBcInv = properties.bcInv ?? 0;
    this.fixedSrpCoeff = properties.srpCoeff ?? 0;
    // 熱
    this._temperature = properties.temperature ?? ENV_TEMP;
    this._thermalDeviation = properties.thermalDeviation ?? 0;
    this.pendingSpecificHeat = properties.pendingSpecificHeat ?? 0;
    this.specificHeat = properties.specificHeat ?? 0;
    this.bulkDensity = properties.bulkDensity ?? SMALL_DEBRIS_BULK_DENSITY;
    this.fixedRadiatingAreaPerMass = properties.radiatingAreaPerMass ?? 0;
    this.emissivity = properties.emissivity ?? HULL_EMISS;
    this.maxTemperature = properties.maxTemperature ?? Infinity;
    // 履歴の保持・予測の弧と、接触の振る舞い
    this.baseHistoryDuration = properties.historyDuration ?? 0;
    this.followsPredictedArc = properties.followsPredictedArc ?? false;
    this.behavior = properties.behavior ?? PASSIVE_BEHAVIOR;
  }

  public get state(): KinematicState { return this.actual.state; }
  public get att(): Attitude { return this._att; }
  public get prevAtt(): Attitude { return this._prevAtt; }
  public get alive(): boolean { return this._alive; }
  public get mass(): number { return this.behavior.mass?.(this) ?? this._mass; }
  public get torque(): Vec3 { return this._torque; }
  public get temperature(): number { return this._temperature; }
  public get thermalDeviation(): number { return this._thermalDeviation; }
  // 現在の質量・姿勢などから求めた弾道係数の逆数 [m²/kg]。
  public get bcInv(): number { return this.behavior.bcInv?.(this) ?? this.fixedBcInv; }
  // 現在の質量・姿勢などから求めた輻射圧係数と断面積質量比の積 [m²/kg]。
  public get srpCoeff(): number { return this.behavior.srpCoeff?.(this) ?? this.fixedSrpCoeff; }
  public get prevState(): KinematicState { return this.actual.prevState; }
  public get radius(): number { return this._radius; }
  public get centerOfMass(): Vec3 { return this._centerOfMass; }
  public get compoundShape(): CompoundCylinderShape | null { return this._compoundShape; }
  public get surfaceShape(): CompoundSphereShape | null { return this._surfaceShape; }
  public get shapeRevision(): number { return this._shapeRevision; }
  public get collisionProperties(): DynamicCollisionPropertiesSnapshot {
    return Object.freeze({
      mass: this._mass,
      radius: this._radius,
      centerOfMass: this._centerOfMass,
      inertia: this.att.inertia,
      compoundShape: this._compoundShape,
      surfaceShape: this._surfaceShape,
      shapeRevision: this._shapeRevision,
    });
  }

  // 形状・質量・重心・慣性を、検証済みのスナップショットとして一括交換する。
  // 検証中に例外が出ても、現在の物性と予測弧には触れない。
  public replaceCollisionProperties(properties: DynamicCollisionProperties): void {
    const next = collisionPropertiesOf(properties);

    this._mass = next.mass;
    this._radius = next.radius;
    this._centerOfMass = next.centerOfMass;
    this._compoundShape = next.compoundShape;
    this._surfaceShape = next.surfaceShape ?? null;
    this._att = { ...this._att, inertia: next.inertia };
    this._prevAtt = { ...this._prevAtt, inertia: next.inertia };
    this._shapeRevision++;
    this.invalidatePrediction();
  }
  public get predicted(): DynamicTrajectory | null { return this.predictedArc?.trajectory ?? null; }
  public get arc(): PredictedArc | null { return this.predictedArc; }
  public get predictionTruncated(): boolean { return this.predictedArc?.truncated ?? false; }
  public get contactKind(): ContactKind { return this.behavior.contactKind ?? 'generic'; }
  public get contactMass(): number { return this.behavior.contactMass?.(this) ?? this.mass; }
  public get thrust(): Vec3 | null { return this._thrust; }
  // いまの熱の状態の写し。
  public get thermal(): DynamicMotionThermal {
    return {
      temperature: this._temperature,
      thermalDeviation: this._thermalDeviation,
      pendingSpecificHeat: this.pendingSpecificHeat,
    };
  }

  // 次の積分に加える推力加速度(ECI)を指令する。null は無推力。推力を与えると予測弧を捨てる。
  public setThrust(thrust: Vec3 | null): void {
    this._thrust = thrust;
    if (thrust !== null) this.invalidatePrediction();
  }

  // 次の積分に加える、姿勢のトルクを指令する。
  public setTorque(torque: Vec3): void {
    this._torque = torque;
  }

  // シミュレーションから退場させる。
  public kill(): void {
    this._alive = false;
  }

  // 状態を state へ置き換え、予測弧を捨てる。積分を経ない不連続な差し替えに使う。
  public reset(state: KinematicState): void {
    this.actual.reset(state);
    this.invalidatePrediction();
  }

  // 質量 mass [kg] と主慣性モーメント inertia を置き換え、変わったなら予測弧を捨てる(弾道係数が
  // 質量で変わる)。構成で質量の決まる継承先は、構成を変えたときに呼ぶこと。
  protected setMassProperties(mass: number, inertia: Vec3): void {
    if (mass === this._mass && sameVec(inertia, this._att.inertia)) return;
    this._mass = mass;
    this._att = { ...this._att, inertia };
    this.invalidatePrediction();
  }

  // pos に置いた判定形状へ ray が当たるか。既定の形状は半径 radius の球。
  public intersectsRay(ray: Ray, pos: Vec3): boolean {
    const custom = this.behavior.hitBodyByRay;
    if (custom !== undefined) return custom(this, ray, pos);
    if (this._compoundShape !== null) return this.raycastCompound(ray, pos) !== null;
    return hitsSphere(ray, pos, this.radius);
  }

  // 画面上の直接操作で使う、compound の最近傍 module hit。固定形状と球は module を持たない。
  public raycastCompound(ray: Ray, pos: Vec3): CompoundCylinderRayHit | null {
    if (this._compoundShape === null) return null;
    return compoundCylinderRaycast(
      this._compoundShape,
      { position: pos, rotation: this.att.q },
      ray.origin,
      ray.dir,
    );
  }

  // 残す履歴の長さ sec [s](0 以上の有限値)を要求する。構築時の長さを持つ個体が、構築時と
  // 要求の長いほうを残す。
  public requestHistoryDuration(sec: number): void {
    if (this.baseHistoryDuration <= 0) return;
    this.requestedHistoryDuration = sec;
  }

  // 予測の弧をなぞる個体なら、現在の状態から sources を引く弧を用意して返す。でなければ null。
  public ensurePredictedArc(sources: readonly CelestialBody[]): PredictedArc | null {
    if (!this.followsPredictedArc) return null;
    this.predictedArc ??= new PredictedArc(
      this.state, sources, this.radius, this.bcInv, this.srpCoeff,
      /* keplerTail */ true, /* consumable */ true,
    );
    return this.predictedArc;
  }

  // 予測弧を捨てる。次の ensurePredictedArc で現在の状態から引き直す。
  public invalidatePrediction(): void {
    this.predictedArc = null;
  }

  // 構成変更で姿勢・慣性を同時に置き換える継承先の入口。
  protected resetAttitude(attitude: Attitude, previous: Attitude = attitude): void {
    this._att = attitude;
    this._prevAtt = previous;
    this.invalidatePrediction();
  }

  // 時刻 t の状態。予測弧の先は celestialBodies を渡したときに外挿する。届かない時刻では null。
  public stateAt(t: number, celestialBodies?: CelestialBodies): KinematicState | null {
    if (t <= this.state.t) return this.actual.at(t);
    const predicted = this.predicted;
    if (predicted === null) return null;
    if (t <= predicted.state.t) return predicted.at(t);
    if (this.predictionTruncated || celestialBodies === undefined) return null;
    const center = predicted.extrapolationCenter;
    return center === null
      ? null : predicted.extrapolatedAt(t, celestialBodies.stateAt(center.celestialBody.id, t));
  }

  // 時刻 centerPivot の center を中心とする、現在の状態の軌道要素。
  public orbitalElementsAround(center: CelestialBody, centerPivot: number): OrbitalElements | null {
    return orbitalElementsOf(this.state, center, centerPivot);
  }

  // dt を大気突入の刻み幅の上限に収めるための分割数。preciseReentry でない個体は 1。
  public substepDivisions(
    dt: number, atmosphereBodies: readonly CelestialBody[], pivot: number,
  ): number {
    if (!this.preciseReentry) return 1;
    const innerDt = atmosphericMaxStep(this.state, this.bcInv, atmosphereBodies, pivot);
    return innerDt >= dt ? 1 : Math.ceil(dt / innerDt);
  }

  // dt の間に抗力が対気速度を完全に減衰させ切るか。preciseReentry の個体は常に false。
  public outpacedByDrag(
    dt: number, atmosphereBodies: readonly CelestialBody[], pivot: number,
  ): boolean {
    return !this.preciseReentry
      && dragTakesFullAirspeed(this.state, this.bcInv, atmosphereBodies, pivot, dt);
  }

  // 軌道・姿勢・熱を dt 進める。予測弧をなぞらずに積分したときは true を返す。
  public stepSimulation(
    dt: number, celestialBodies: readonly CelestialBody[], occluders: readonly CelestialBody[],
    atmosphereBody: CelestialBody | null, star: CelestialBody | null, pivot: number,
    services: DynamicReactionServices,
  ): boolean {
    // 推力がなく予測弧が届く歩は、弧をなぞって積分を省く。
    const interval = this.historySampleInterval(celestialBodies, pivot);
    const integrated = !this.followPredicted(this.state.t + dt, interval);
    let environmentSamples: readonly DynamicsEnvironmentSample[];
    if (integrated) {
      environmentSamples = this.actual.step(
        dt, celestialBodies, occluders, atmosphereBody, pivot, this.bcInv, this.srpCoeff,
        this.thrust, interval, this.historyDuration,
      );
      this.invalidatePrediction();
    } else {
      environmentSamples = [environmentSampleAt(
        this.state.t, this.state.r, this.state.v, star, occluders, atmosphereBody, pivot)];
    }
    this._prevAtt = this._att;
    if (this.hasAttitude) this._att = stepAttitude(this._att, this._torque, dt);

    // 歩のあいだの環境の平均で、種別ごとの環境反応と熱を進める。
    const radiantIntensity = star !== null && isStar(star) ? star.def.radiantIntensity : 0;
    const environment = weightedEnvironment(environmentSamples, radiantIntensity);
    this.behavior.stepEnvironment?.(
      this, dt, atmosphereBody, this.state.t, environment.sunlight, environment.sunDir);
    this.stepThermal(dt, environmentSamples, radiantIntensity, services);
    return integrated;
  }

  // 次の熱の歩で温度へ足す熱量 specificJoules [J/kg] を積む。
  public absorbHeat(specificJoules: number): void {
    this.pendingSpecificHeat += specificJoules;
  }

  // other と当たるか。既定では当たる。
  public contactsWith(other: EntityContactParticipant, simTime: number): boolean {
    return this.behavior.contactsWith?.(this, other, simTime) ?? true;
  }

  // 半径の球に代えて、固有の判定形状を持つか。
  public usesCustomSphereCollision(): boolean {
    return this.behavior.testSphereCollision !== undefined;
  }

  // 固有形状どうしの接触を持つか。
  public usesCustomEntityCollision(): boolean {
    return this.behavior.testEntityCollision !== undefined;
  }

  // 固有の判定形状と球の接触。触れていないか固有の形状を持たなければ null。
  public testCustomSphereCollision(
    sphereCenter: Vec3, sphereRadius: number, selfState: KinematicState,
    selfAttitude: Attitude = this.att,
  ): SphereHit | null {
    return this.behavior.testSphereCollision?.(this, sphereCenter, sphereRadius, selfState, selfAttitude) ?? null;
  }

  // 前の歩から今の歩へ動く球と固有の判定形状の最初の接触と、その時刻の歩内での割合 toi。
  // 触れていないか固有の形状を持たなければ null。
  public testCustomSweptSphereCollision(
    previousSphereCenter: Vec3, sphereCenter: Vec3, sphereRadius: number,
    previousSelfState: KinematicState, selfState: KinematicState,
    previousSelfAttitude: Attitude = this.prevAtt, selfAttitude: Attitude = this.att,
  ): { readonly hit: SphereHit; readonly toi: number } | null {
    return this.behavior.testSweptSphereCollision?.(
      this, previousSphereCenter, sphereCenter, sphereRadius, previousSelfState, selfState,
      previousSelfAttitude, selfAttitude,
    ) ?? null;
  }

  // 固有形状どうしの接触。触れていないか、固有形状どうしの組でなければ null。
  public testCustomEntityCollision(
    other: EntityContactParticipant, selfState: KinematicState, otherState: KinematicState,
  ): ContactGeometry | null {
    return this.behavior.testEntityCollision?.(this, other, selfState, otherState) ?? null;
  }

  // 固有形状どうしの掃引接触。触れていないか、固有形状どうしの組でなければ null。
  public testCustomSweptEntityCollision(
    other: EntityContactParticipant,
    previousSelf: KinematicState, selfState: KinematicState,
    previousOther: KinematicState, otherState: KinematicState,
  ): ContactGeometry | null {
    return this.behavior.testSweptEntityCollision?.(
      this, other, previousSelf, selfState, previousOther, otherState,
    ) ?? null;
  }

  // 付属物の接触代理を、時刻 simTime から dt [s] のサブステップの位置へ置き直す。サブステップごとに
  // 1度、contactProxies より先に呼ぶ。
  public placeContactProxies(simTime: number, dt: number): void {
    this.behavior.placeContactProxies?.(this, simTime, dt);
  }

  // 接触判定で本体と別に当たる付属物の接触代理。既定は空。
  public contactProxies(): readonly EntityContactParticipant[] {
    return this.behavior.contactProxies?.(this) ?? [];
  }

  // 接触を解いたあとの付属物の状態を、本体の側へ書き戻す。
  public applyContactProxies(dt: number): void {
    this.behavior.applyContactProxies?.(this, dt);
  }

  // 他の個体との接触を反応へ渡す。
  public collideWithEntity(
    other: EntityContactParticipant, contact: Contact, services: DynamicReactionServices,
  ): void {
    this.behavior.onEntityContact?.(this, other, contact, services);
  }

  // 天体表面への接触を反応へ渡す。表面接触の反応を持たない個体は消える。
  public collideWithCelestialBody(
    body: CelestialBody, contact: Contact, services: DynamicReactionServices,
  ): void {
    if (this.behavior.onSurfaceContact !== undefined) {
      this.behavior.onSurfaceContact(this, body, contact, services);
      return;
    }
    this.kill();
  }

  // simTime 以降で次に反応が起きる時刻。予定が無ければ null。
  public nextSimulationEventTime(simTime: number): number | null {
    return this.behavior.nextSimulationEventTime?.(this, simTime) ?? null;
  }

  // 範囲外・寿命などの消滅条件を反応に判定させる。
  public checkLoss(
    dt: number, simTime: number, services: DynamicReactionServices,
    zones: readonly EngagementZone<EngagementParticipant>[], atmosphereBodies: readonly CelestialBody[],
  ): void {
    this.behavior.checkLoss?.(this, dt, simTime, services, zones, atmosphereBodies);
  }

  // simDt ぶんの自律の指令を反応に進めさせ、反応が決めた推力を指令する。
  public updateCommands(simDt: number): void {
    if (this.behavior.updateCommands === undefined) return;
    this.behavior.updateCommands(this, simDt);
    this.setThrust(this.behavior.commandedThrust?.(this) ?? null);
  }

  // 残す履歴の長さ [s]。既定と要求の長いほう。
  private get historyDuration(): number {
    return Math.max(this.baseHistoryDuration, this.requestedHistoryDuration);
  }

  // 履歴を標本化する間隔 [s]。履歴を残さないなら 0。
  private historySampleInterval(celestialBodies: readonly CelestialBody[], pivot: number): number {
    return this.historyDuration > 0
      ? trajectorySampleInterval(localOrbitPeriod(this.state.r, celestialBodies, pivot), this.historyDuration)
      : 0;
  }

  // 推力がなく予測弧が t まで届いていれば、現在の状態を弧の上へ進めて true を返す。
  private followPredicted(t: number, sampleInterval: number): boolean {
    if (this.thrust !== null) return false;
    const state = this.predictedArc?.trajectory.at(t) ?? null;
    if (state === null) return false;
    this.actual.follow(state, sampleInterval, this.historyDuration);
    return true;
  }

  // 質量あたりの放射面積 [m^2/kg]。
  private radiatingAreaPerMass(): number {
    return this.behavior.radiatingAreaPerMass?.(this) ?? this.fixedRadiatingAreaPerMass;
  }

  // sunDir からの日射を吸収する質量あたりの面積 [m^2/kg]。既定は断面積質量比 × 放射率。
  private solarAbsorbAreaPerMass(sunDir: Vec3): number {
    return this.behavior.solarAbsorbAreaPerMass?.(this, sunDir)
      ?? sphereSolarAbsorbAreaPerMass(this.emissivity, this.bcInv);
  }

  // 温度を dt 進め、上限を超えたら燃え尽きさせる。比熱 0 の個体は熱を持たない。radiantIntensity は
  // 日射の光源の放射強度 [W/sr]。
  private stepThermal(
    dt: number, samples: readonly DynamicsEnvironmentSample[], radiantIntensity: number,
    services: DynamicReactionServices,
  ): void {
    if (this.specificHeat <= 0) return;
    const next = stepThermalState({
      dt,
      samples,
      radiantIntensity,
      temperature: this._temperature,
      thermalDeviation: this._thermalDeviation,
      pendingSpecificHeat: this.pendingSpecificHeat,
      specificHeat: this.specificHeat,
      bulkDensity: this.bulkDensity,
      emissivity: this.emissivity,
      maxTemperature: this.maxTemperature,
      bcInv: this.bcInv,
      radiatingAreaPerMass: this.radiatingAreaPerMass(),
      solarAbsorbAreaPerMass: (sunDir) => this.solarAbsorbAreaPerMass(sunDir),
    });
    this._temperature = next.temperature;
    this._thermalDeviation = next.thermalDeviation;
    this.pendingSpecificHeat = next.pendingSpecificHeat;
    // 上限を超えたら焼失の反応へ渡す。反応を持たない個体は消える。
    if (!next.burnedUp) return;
    if (this.behavior.onBurnUp !== undefined) this.behavior.onBurnUp(this, services);
    else this.kill();
  }
}
