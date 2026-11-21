// DynamicMotion の型側 — 種別ごとの振る舞い差し込みと、生成時に渡す物性の宣言。
// クラスの実体は dynamic-motion.ts。型だけを引きたい消費者が積分器の実装を引かないよう
// ここへ切り離す。全ての参照が import type なので実行時の循環にはならない。
import type { Ray } from '../../math/ray';
import type { SphereHit } from '../../math/triangle-mesh';
import type { ContactGeometry } from '../../physics/collision-response';
import type { Vec3 } from '../../math/vec3';
import type { Attitude, RotatingFrame } from '../../physics/attitude';
import type { CelestialBody } from '../../physics/celestial-body';
import type { KinematicState } from '../../physics/kinematic-state';
import type { Contact } from './entity/contact';
import type { DynamicReactionServices, EntityContactParticipant } from './dynamic-simulation-participant';
import type { EngagementParticipant, EngagementZone } from './engagement-zone';
import type { DynamicMotion } from './dynamic-motion';

// 接触した相手を見分ける種別。
export type ContactKind =
  | 'generic' | 'player' | 'radiator-fold' | 'belt-section' | 'bullet' | 'debris' | 'casing'
  | 'enemy' | 'ammo' | 'rcs-fuel';

// 種別ごとに差し込む反応。省いたメソッドは DynamicMotion の既定の振る舞いになる。
export interface DynamicMotionBehavior {
  readonly contactKind?: ContactKind;
  contactMass?(self: DynamicMotion): number;
  // simDt ぶんの自律の指令(燃焼など)を進める。
  updateCommands?(self: DynamicMotion, simDt: number): void;
  // 直近の updateCommands が決めた推力加速度(ECI)。噴いていなければ null。
  commandedThrust?(self: DynamicMotion): Vec3 | null;
  // 各積分ステップの直前に呼ぶ自律の指令(自動操縦の推力・トルクなど)。この歩の長さ dt [s] と、
  // その歩に使う重力源・評価時刻を受ける。
  stepCommands?(
    self: DynamicMotion, dt: number, attractors: readonly CelestialBody[], pivot: number,
  ): void;
  // この個体が要求する積分刻みの上限 [s](燃焼中の細かい刻みなど)。制約しないなら null。
  maxSubstepDuration?(self: DynamicMotion): number | null;
  // 姿勢の基準にする回転座標系(周回の局所系など)。慣性系で進めるなら null。
  attitudeFrame?(
    self: DynamicMotion, state: KinematicState, attractors: readonly CelestialBody[], pivot: number,
  ): RotatingFrame | null;
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
  readonly attitude?: Attitude | null;
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

export const PASSIVE_BEHAVIOR: DynamicMotionBehavior = Object.freeze({ contactKind: 'generic' });
