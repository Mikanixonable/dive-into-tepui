import { Q_IDENTITY } from '../../math/quat';
import { hitsSphere, type Ray } from '../../math/ray';
import type { SphereHit } from '../../math/triangle-mesh';
import type { ContactGeometry } from '../../physics/collision-response';
import { sub, type Vec3, v3 } from '../../math/vec3';
import { type Attitude, stepAttitude } from '../../physics/attitude';
import { airflow } from '../../physics/atmosphere';
import { localOrbitPeriod } from '../../physics/attractor';
import type { CelestialBody } from '../../physics/celestial-body';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import { type KinematicState } from '../../physics/kinematic-state';
import { environmentSampleAt, type DynamicsEnvironmentSample } from '../../physics/dynamics';
import {
  compoundCylinderRaycast,
  type CompoundCylinderRayHit,
  type CompoundCylinderShape,
} from '../../physics/compound-cylinder-contact';
import { SOLAR_CONSTANT } from '../../physics/srp';
import {
  aeroHeating, radiativeCooling, solarHeating, sphereNoseRadius, stepTemperature,
  stepThermalDeviation,
} from '../../physics/thermal';
import { orbitalElementsOf } from '../../physics/elements';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import { DISPLAY_DURATION_MAX } from '../display-window-duration';
import type { Contact } from './dynamic-entity/contact';
import type { DynamicReactionServices } from './dynamic-simulation-participant';
import { PredictedArc, trajectorySampleInterval } from './predicted-arc';
import { atmosphericMaxStep, dragTakesFullAirspeed } from './time-step';

// 弾道係数の逆数から断面積質量比を戻すときの抗力係数 Cd。
const DRAG_COEFFICIENT = 2.2;
// 空力加熱を受ける淀み点まわりの面積が、断面積に占める割合。
const STAGNATION_AREA_FRACTION = 0.6;
// Sutton–Graves の定数(地球大気) [kg^0.5/m]。
const SG_CONST = 1.7415e-4;
// 1歩ぶんの環境標本が RK4 の4段のとき、平均に掛ける重み。
const RK4_WEIGHTS: readonly number[] = [1, 2, 2, 1];

// 船体の放射率。
export const HULL_EMISS = 0.85;
// 放射冷却の相手とする環境温度 [K]。
export const ENV_TEMP = 255;
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

// 種別ごとに差し込む反応。省いたメソッドは DynamicMotion の既定の振る舞いになる。
export interface DynamicMotionBehavior {
  readonly contactKind?: ContactKind;
  contactMass?(self: DynamicMotion): number;
  updateCommands?(self: DynamicMotion, simDt: number): void;
  contactsWith?(self: DynamicMotion, other: DynamicMotion, simTime: number): boolean;
  testSphereCollision?(
    self: DynamicMotion, sphereCenter: Vec3, sphereRadius: number, selfState: KinematicState,
  ): SphereHit | null;
  testSweptSphereCollision?(
    self: DynamicMotion, previousSphereCenter: Vec3, sphereCenter: Vec3, sphereRadius: number,
    previousSelfState: KinematicState, selfState: KinematicState,
  ): { readonly hit: SphereHit; readonly toi: number } | null;
  testEntityCollision?(
    self: DynamicMotion, other: DynamicMotion,
    selfState: KinematicState, otherState: KinematicState,
  ): ContactGeometry | null;
  testSweptEntityCollision?(
    self: DynamicMotion, other: DynamicMotion,
    previousSelf: KinematicState, selfState: KinematicState,
    previousOther: KinematicState, otherState: KinematicState,
  ): ContactGeometry | null;
  hitBodyByRay?(self: DynamicMotion, ray: Ray, pos: Vec3): boolean;
  contactProxies?(self: DynamicMotion, simTime: number, dt: number): readonly DynamicMotion[];
  applyContactProxies?(self: DynamicMotion, dt: number): void;
  onEntityContact?(
    self: DynamicMotion, other: DynamicMotion, contact: Contact, services: DynamicReactionServices,
  ): void;
  onSurfaceContact?(
    self: DynamicMotion, body: CelestialBody, contact: Contact, services: DynamicReactionServices,
  ): void;
  onBurnUp?(self: DynamicMotion, services: DynamicReactionServices): void;
  stepEnvironment?(
    self: DynamicMotion, dt: number, atmosphereBody: CelestialBody | null,
    atmospherePivot: number, sunlit: number, sunDir: Vec3,
  ): void;
  // 質量などの状態に応じて変化する物性。省略時は生成時の固定値を使う。
  bcInv?(self: DynamicMotion): number;
  srpCoeff?(self: DynamicMotion): number;
  radiatingAreaPerMass?(self: DynamicMotion): number;
  solarAbsorbAreaPerMass?(self: DynamicMotion, sunDir: Vec3): number;
  nextSimulationEventTime?(self: DynamicMotion, simTime: number): number | null;
  checkLoss?(
    self: DynamicMotion, dt: number, simTime: number, services: DynamicReactionServices,
    viewerPos: Vec3, atmosphereBodies: readonly CelestialBody[],
  ): void;
}

// DynamicMotion の物性と初期値。省いた項目は既定値になる。
export interface DynamicMotionProperties {
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
  readonly specificHeat?: number;
  readonly bulkDensity?: number;
  readonly radiatingAreaPerMass?: number;
  readonly emissivity?: number;
  readonly maxTemperature?: number;
  readonly historyDuration?: number;
  readonly predictedForGhost?: boolean;
  readonly behavior?: DynamicMotionBehavior;
}

// 接触形状と、同じ形状に対応する剛体物性の一貫したスナップショット。
// 交換時に全項目を検証するため、部分的に更新された物性は観測されない。
export interface DynamicCollisionProperties {
  readonly mass: number;
  readonly radius: number;
  readonly centerOfMass: Vec3;
  readonly inertia: Vec3;
  readonly compoundShape: CompoundCylinderShape | null;
}

export interface DynamicCollisionPropertiesSnapshot extends DynamicCollisionProperties {
  readonly shapeRevision: number;
}

const PASSIVE_BEHAVIOR: DynamicMotionBehavior = Object.freeze({ contactKind: 'generic' });

const COLLISION_EPSILON = 1e-12;

function frozenVec(value: Vec3): Vec3 {
  return Object.freeze(v3(value.x, value.y, value.z));
}

function finiteVec(value: Vec3): boolean {
  return value !== null && value !== undefined
    && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function validateMass(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('dynamic mass must be finite and nonnegative');
  return value;
}

function validateRadius(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('dynamic radius must be finite and nonnegative');
  return value;
}

function validateVec(value: Vec3, name: string): Vec3 {
  if (!finiteVec(value)) throw new Error(`dynamic ${name} must be finite`);
  return value;
}

function validateInertia(value: Vec3): Vec3 {
  validateVec(value, 'inertia');
  if (!(value.x > 0) || !(value.y > 0) || !(value.z > 0)) {
    throw new Error('dynamic inertia must be finite and positive');
  }
  return value;
}

function freezeCompoundShape(shape: CompoundCylinderShape | null): CompoundCylinderShape | null {
  if (shape === null) return null;
  if (shape === undefined || !Array.isArray(shape.primitives) || shape.primitives.length === 0) {
    throw new Error('dynamic compound shape must contain primitives');
  }
  const primitives = shape.primitives.map((primitive) => {
    if (primitive === null || primitive === undefined || typeof primitive.moduleId !== 'string'
      || primitive.moduleId.length === 0) throw new Error('dynamic primitive moduleId must be non-empty');
    validateVec(primitive.center, 'primitive center');
    validateVec(primitive.axis, 'primitive axis');
    const axisLength = Math.hypot(primitive.axis.x, primitive.axis.y, primitive.axis.z);
    if (!Number.isFinite(axisLength) || !(axisLength > COLLISION_EPSILON)) {
      throw new Error('dynamic primitive axis must be nonzero');
    }
    if (!Number.isFinite(primitive.halfLength) || !(primitive.halfLength > 0)
      || !Number.isFinite(primitive.radius) || !(primitive.radius > 0)) {
      throw new Error('dynamic primitive dimensions must be finite and positive');
    }
    return Object.freeze({
      moduleId: primitive.moduleId,
      center: frozenVec(primitive.center),
      axis: frozenVec(v3(
        primitive.axis.x / axisLength, primitive.axis.y / axisLength, primitive.axis.z / axisLength,
      )),
      halfLength: primitive.halfLength,
      radius: primitive.radius,
    });
  });
  return Object.freeze({ primitives: Object.freeze(primitives) });
}

// 1歩ぶんの環境標本を平均した日照率と太陽方向(単位ベクトル)。
function weightedEnvironment(samples: readonly DynamicsEnvironmentSample[]): {
  readonly sunlit: number;
  readonly sunDir: Vec3;
} {
  let weightTotal = 0;
  let sunlit = 0;
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < samples.length; i++) {
    const weight = samples.length === 4 ? RK4_WEIGHTS[i]! : 1;
    const sample = samples[i]!;
    weightTotal += weight;
    sunlit += weight * sample.sunlit;
    x += weight * sample.sunDir.x;
    y += weight * sample.sunDir.y;
    z += weight * sample.sunDir.z;
  }
  // 太陽方向は重み付きの和を正規化して平均とする。
  const directionLength = Math.hypot(x, y, z);
  return {
    sunlit: weightTotal > 0 ? sunlit / weightTotal : 0,
    sunDir: directionLength > 0 ? v3(x / directionLength, y / directionLength, z / directionLength) : v3(),
  };
}

// 姿勢を与えられなかった個体の、静止した単位慣性の姿勢。
function identityAttitude(): Attitude {
  return { q: Q_IDENTITY, w: v3(), inertia: v3(1, 1, 1) };
}

// 1体の物理結果を変えうる状態(軌道・姿勢・熱・予測弧)をすべて所有する。
export class DynamicMotion {
  public readonly actual: DynamicTrajectory;
  public readonly hasAttitude: boolean;
  public readonly behavior: DynamicMotionBehavior;
  public att: Attitude;
  // compound 接触の掃引始点。各 attitude step の直前に current attitude を退避する。
  public prevAtt: Attitude;
  public alive = true;
  private _mass: number;
  private _radius: number;
  private _centerOfMass: Vec3;
  private _compoundShape: CompoundCylinderShape | null;
  private _shapeRevision = 0;
  public readonly collides: boolean;
  public readonly engagementAnchor: boolean;
  public readonly preciseReentry: boolean;
  public readonly contactDamageWeight: number;
  // 本体に取り付けた付属物なら、その本体。
  public attachedTo: DynamicMotion | null = null;
  public torque: Vec3 = v3();
  private readonly fixedBcInv: number;
  private readonly fixedSrpCoeff: number;
  public temperature: number;
  public thermalDeviation: number;
  public readonly specificHeat: number;
  public readonly bulkDensity: number;
  public readonly emissivity: number;
  public readonly maxTemperature: number;
  // 予測弧を読む者の登録。どれかが立っている間は未来を予測し続ける。
  public analysisPanelReader = false;
  public navTargetReader = false;
  public trajectoryReader = false;

  private readonly fixedRadiatingAreaPerMass: number;
  private readonly baseHistoryDuration: number;
  private readonly predictedForGhost: boolean;
  private predictedArc: PredictedArc | null = null;
  private requestedHistoryDuration = 0;
  private pendingSpecificHeat = 0;
  private _thrust: Vec3 | null = null;

  // state から始まる軌道を組む。options で省いた物性は既定値になる。
  public constructor(state: KinematicState, options: DynamicMotionProperties = {}) {
    this.actual = new DynamicTrajectory(state);
    // 姿勢・質量と接触
    const attitude = options.attitude ?? identityAttitude();
    this.att = { ...attitude, inertia: frozenVec(validateInertia(attitude.inertia)) };
    this.prevAtt = this.att;
    this.hasAttitude = options.hasAttitude ?? true;
    this._mass = validateMass(options.mass ?? 1);
    this._radius = validateRadius(options.radius ?? 0);
    this._centerOfMass = frozenVec(v3());
    this._compoundShape = null;
    this.collides = options.collides ?? false;
    this.engagementAnchor = options.engagementAnchor ?? false;
    this.preciseReentry = options.preciseReentry ?? false;
    this.contactDamageWeight = options.contactDamageWeight ?? 1;
    // 空力・輻射圧
    this.fixedBcInv = options.bcInv ?? 0;
    this.fixedSrpCoeff = options.srpCoeff ?? 0;
    // 熱
    this.temperature = options.temperature ?? ENV_TEMP;
    this.thermalDeviation = options.thermalDeviation ?? 0;
    this.specificHeat = options.specificHeat ?? 0;
    this.bulkDensity = options.bulkDensity ?? SMALL_DEBRIS_BULK_DENSITY;
    this.fixedRadiatingAreaPerMass = options.radiatingAreaPerMass ?? 0;
    this.emissivity = options.emissivity ?? HULL_EMISS;
    this.maxTemperature = options.maxTemperature ?? Infinity;
    // 過去線の保持・予測と、接触の振る舞い
    this.baseHistoryDuration = options.historyDuration ?? 0;
    this.predictedForGhost = options.predictedForGhost ?? false;
    this.behavior = options.behavior ?? PASSIVE_BEHAVIOR;
  }

  public get state(): KinematicState { return this.actual.state; }
  public set state(state: KinematicState) { this.reset(state); }
  // 現在の質量・姿勢などから求めた弾道係数の逆数 [m²/kg]。
  public get bcInv(): number { return this.behavior.bcInv?.(this) ?? this.fixedBcInv; }
  // 現在の質量・姿勢などから求めた輻射圧係数と断面積質量比の積 [m²/kg]。
  public get srpCoeff(): number { return this.behavior.srpCoeff?.(this) ?? this.fixedSrpCoeff; }
  public get prevState(): KinematicState { return this.actual.prevState; }
  public get mass(): number { return this._mass; }
  public set mass(value: number) {
    this._mass = validateMass(value);
    this.invalidatePrediction();
  }
  public get radius(): number { return this._radius; }
  public get centerOfMass(): Vec3 { return this._centerOfMass; }
  public get compoundShape(): CompoundCylinderShape | null { return this._compoundShape; }
  public get shapeRevision(): number { return this._shapeRevision; }
  public get collisionProperties(): DynamicCollisionPropertiesSnapshot {
    return Object.freeze({
      mass: this._mass,
      radius: this._radius,
      centerOfMass: this._centerOfMass,
      inertia: this.att.inertia,
      compoundShape: this._compoundShape,
      shapeRevision: this._shapeRevision,
    });
  }

  // 形状・質量・重心・慣性を、検証済みのスナップショットとして一括交換する。
  // 検証中に例外が出ても、現在の物性と予測弧には触れない。
  public replaceCollisionProperties(properties: DynamicCollisionProperties): void {
    const nextMass = validateMass(properties.mass);
    const nextRadius = validateRadius(properties.radius);
    const nextCenterOfMass = frozenVec(validateVec(properties.centerOfMass, 'centerOfMass'));
    const nextInertia = frozenVec(validateInertia(properties.inertia));
    const nextShape = freezeCompoundShape(properties.compoundShape);

    this._mass = nextMass;
    this._radius = nextRadius;
    this._centerOfMass = nextCenterOfMass;
    this._compoundShape = nextShape;
    this.att = { ...this.att, inertia: nextInertia };
    this.prevAtt = { ...this.prevAtt, inertia: nextInertia };
    this._shapeRevision++;
    this.invalidatePrediction();
  }
  public get predicted(): DynamicTrajectory | null { return this.predictedArc?.trajectory ?? null; }
  public get arc(): PredictedArc | null { return this.predictedArc; }
  public get predictionTruncated(): boolean { return this.predictedArc?.truncated ?? false; }
  public get contactKind(): ContactKind { return this.behavior.contactKind ?? 'generic'; }
  public get contactMass(): number { return this.behavior.contactMass?.(this) ?? this.mass; }
  public get thrust(): Vec3 | null { return this._thrust; }
  // 推力を与えると予測弧を捨てる。null は無推力。
  public set thrust(thrust: Vec3 | null) {
    this._thrust = thrust;
    if (thrust !== null) this.invalidatePrediction();
  }

  // 状態を state へ置き換え、予測弧を捨てる。
  public reset(state: KinematicState): void {
    this.actual.reset(state);
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

  // 表示のために残す履歴の長さ sec [s] を要求する。既定で履歴を持たない個体では効かない。
  public requestHistoryDuration(sec: number): void {
    if (this.baseHistoryDuration <= 0) return;
    this.requestedHistoryDuration = Math.max(0, Math.min(DISPLAY_DURATION_MAX, sec));
  }

  // 予測弧を読む者がいるか。canDisplayFuture が偽なら、未来のゴースト表示は数えない。
  public hasFutureReader(canDisplayFuture: boolean): boolean {
    return (this.predictedForGhost && canDisplayFuture)
      || this.trajectoryReader || this.analysisPanelReader || this.navTargetReader;
  }

  public get predictsFuture(): boolean { return this.hasFutureReader(true); }

  // 予測弧を読む者がいれば、現在の状態から sources を引く弧を用意して返す。いなければ null。
  public ensurePredictedArc(sources: readonly CelestialBody[]): PredictedArc | null {
    if (!this.predictsFuture) return null;
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
  public orbitalElementsAround(center: CelestialBody, centerPivot: number) {
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

  // dt のあいだに抗力が対気速度を奪い切るか。preciseReentry の個体は常に false。
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
    if (this.hasAttitude) {
      this.prevAtt = this.att;
      this.att = stepAttitude(this.att, this.torque, dt);
    }

    // 歩のあいだの環境の平均で、種別ごとの環境反応と熱を進める。
    const environment = weightedEnvironment(environmentSamples);
    this.behavior.stepEnvironment?.(this, dt, atmosphereBody, this.state.t, environment.sunlit, environment.sunDir);
    this.stepThermal(dt, environmentSamples, services);
    return integrated;
  }

  // 次の熱の歩で温度へ足す熱量 specificJoules [J/kg] を積む。
  public absorbHeat(specificJoules: number): void {
    this.pendingSpecificHeat += specificJoules;
  }

  // other と当たるか。既定では当たる。
  public contactsWith(other: DynamicMotion, simTime: number): boolean {
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
  ): SphereHit | null {
    return this.behavior.testSphereCollision?.(this, sphereCenter, sphereRadius, selfState) ?? null;
  }

  // 前の歩から今の歩へ動く球と固有の判定形状の最初の接触と、その時刻の歩内での割合 toi。
  // 触れていないか固有の形状を持たなければ null。
  public testCustomSweptSphereCollision(
    previousSphereCenter: Vec3, sphereCenter: Vec3, sphereRadius: number,
    previousSelfState: KinematicState, selfState: KinematicState,
  ): { readonly hit: SphereHit; readonly toi: number } | null {
    return this.behavior.testSweptSphereCollision?.(
      this, previousSphereCenter, sphereCenter, sphereRadius, previousSelfState, selfState,
    ) ?? null;
  }

  // 固有形状どうしの接触。形状を持たない個体との接触は null を返し、球対形状の経路へ戻す。
  public testCustomEntityCollision(
    other: DynamicMotion, selfState: KinematicState, otherState: KinematicState,
  ): ContactGeometry | null {
    return this.behavior.testEntityCollision?.(this, other, selfState, otherState) ?? null;
  }

  // 固有形状どうしの掃引接触。形状を持たない個体との接触は null を返す。
  public testCustomSweptEntityCollision(
    other: DynamicMotion,
    previousSelf: KinematicState, selfState: KinematicState,
    previousOther: KinematicState, otherState: KinematicState,
  ): ContactGeometry | null {
    return this.behavior.testSweptEntityCollision?.(
      this, other, previousSelf, selfState, previousOther, otherState,
    ) ?? null;
  }

  // 接触判定で本体と別に当たる付属物の Motion。既定は空。
  public contactProxies(simTime: number, dt: number): readonly DynamicMotion[] {
    return this.behavior.contactProxies?.(this, simTime, dt) ?? [];
  }

  // 接触を解いたあとの付属物の状態を、本体の側へ書き戻す。
  public applyContactProxies(dt: number): void {
    this.behavior.applyContactProxies?.(this, dt);
  }

  // 他の個体との接触を反応へ渡す。
  public collideWithEntity(
    other: DynamicMotion, contact: Contact, services: DynamicReactionServices,
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
    this.alive = false;
  }

  // simTime 以降で次に反応が起きる時刻。予定が無ければ null。
  public nextSimulationEventTime(simTime: number): number | null {
    return this.behavior.nextSimulationEventTime?.(this, simTime) ?? null;
  }

  // 範囲外・寿命などの消滅条件を反応に判定させる。
  public checkLoss(
    dt: number, simTime: number, services: DynamicReactionServices, viewerPos: Vec3,
    atmosphereBodies: readonly CelestialBody[],
  ): void {
    this.behavior.checkLoss?.(this, dt, simTime, services, viewerPos, atmosphereBodies);
  }

  // simDt ぶんの操作指令を反応に更新させる。
  public updateCommands(simDt: number): void {
    this.behavior.updateCommands?.(this, simDt);
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
      ?? (this.emissivity * this.bcInv) / DRAG_COEFFICIENT;
  }

  // 温度を dt 進め、上限を超えたら燃え尽きさせる。比熱 0 の個体は熱を持たない。
  private stepThermal(
    dt: number, samples: readonly DynamicsEnvironmentSample[], services: DynamicReactionServices,
  ): void {
    if (this.specificHeat <= 0) return;
    // 標本ごとの日射と空力加熱を重み付きで平均する。
    let heating = 0;
    let weightTotal = 0;
    for (let i = 0; i < samples.length; i++) {
      const weight = samples.length === 4 ? RK4_WEIGHTS[i]! : 1;
      const sample = samples[i]!;
      heating += weight * solarHeating(
        SOLAR_CONSTANT, sample.sunDist, sample.sunlit, this.solarAbsorbAreaPerMass(sample.sunDir));
      if (sample.atmosphere !== null && sample.atmosphereState !== null && this.bcInv > 0) {
        const { density, speed } = airflow(
          sub(sample.r, sample.atmosphereState.r), sub(sample.v, sample.atmosphereState.v), sample.atmosphere);
        heating += weight * aeroHeating(
          density, speed, this.bcInv, SG_CONST,
          sphereNoseRadius(this.bcInv, DRAG_COEFFICIENT, this.bulkDensity),
          (STAGNATION_AREA_FRACTION * this.bcInv) / DRAG_COEFFICIENT);
      }
      weightTotal += weight;
    }
    if (weightTotal > 0) heating /= weightTotal;
    // 放射冷却を差し引き、外から積まれた熱を足して温度を進める。
    const area = this.radiatingAreaPerMass();
    const cooling = radiativeCooling(
      this.temperature, ENV_TEMP, this.emissivity, area, this.specificHeat, dt);
    this.temperature = stepTemperature(this.temperature, heating - cooling, this.specificHeat, dt)
      + this.pendingSpecificHeat / this.specificHeat;
    this.pendingSpecificHeat = 0;
    this.thermalDeviation = stepThermalDeviation(
      this.thermalDeviation, this.temperature, this.emissivity, area, this.specificHeat, dt);
    // 上限を超えたら焼失の反応へ渡す。反応を持たない個体は消える。
    if (this.temperature <= this.maxTemperature) return;
    if (this.behavior.onBurnUp !== undefined) this.behavior.onBurnUp(this, services);
    else this.alive = false;
  }
}
