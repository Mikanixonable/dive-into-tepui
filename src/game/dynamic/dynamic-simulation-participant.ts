// シミュレーション進行・軌道予測・衝突判定の各機構がエンティティおよびコレクションに要求するインターフェース。
import type { Vec3 } from '../../math/vec3';
import type { Attitude } from '../../physics/attitude';
import type { CelestialBody } from '../../physics/celestial-body';
import type { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import type { KinematicState } from '../../physics/kinematic-state';
import type { SphereHit } from '../../math/triangle-mesh';
import type { ContactGeometry } from '../../physics/collision-response';
import type { CompoundCylinderShape } from '../../physics/compound-cylinder-contact';
import type { CompoundSphereShape } from '../../physics/compound-sphere-contact';
import type { StageOutcome } from '../stages/stage-outcome';
import type { Contact } from './dynamic-entity/contact';
import type { ContactKind } from './dynamic-motion';
import type { EngagementParticipant, EngagementZone } from './engagement-zone';
import type { EntityRegistry } from './entity-registry';
import type { PredictedArc } from './predicted-arc';

// 接触・焼失・喪失の反応が、ゲーム上の帰結(勝敗の記録・個体の生成)を書き込む先。
export interface DynamicReactionServices {
  readonly activeStage: StageOutcome;
  readonly registry: EntityRegistry;
}

// 予測の弧を持ちうる個体。
export interface PredictableMotion {
  readonly followsPredictedArc: boolean;
  readonly predicted: DynamicTrajectory | null;
  readonly predictionTruncated: boolean;
  ensurePredictedArc(sources: readonly CelestialBody[]): PredictedArc | null;
}

// 予測軌道を計算・延伸する対象のエンティティ一覧。
export interface PredictableMotionRoster {
  allMotions(): readonly PredictableMotion[];
}

// 接触の掃引が読む、直前と現在の状態と接触半径 [m]。
export interface KinematicParticipant {
  readonly state: KinematicState;
  readonly prevState: KinematicState;
  readonly radius: number;
  // compound 接触の掃引始点姿勢。球だけの既存参加者は省略できる。
  readonly prevAtt: Attitude;
  // 接触側が姿勢と同じ世代の compound を読むための不変スナップショット。
  readonly compoundShape: CompoundCylinderShape | null;
  // 天体表面の候補絞り込みに使う、同じ世代の保守的な球代理。
  readonly surfaceShape: CompoundSphereShape | null;
  readonly shapeRevision: number;
}

// 物体どうしの接触に加わる当事者。
export interface EntityContactParticipant extends KinematicParticipant {
  readonly alive: boolean;
  readonly att: Attitude;
  readonly prevAtt: Attitude;
  readonly engagementAnchor: boolean;
  readonly collides: boolean;
  readonly attachedTo: EntityContactParticipant | null;
  readonly contactMass: number;
  readonly contactKind: ContactKind;
  // 接触ダメージの根拠に掛ける、相手から見たこの個体の重み。
  readonly contactDamageWeight: number;
  contactsWith(other: EntityContactParticipant, simTime: number): boolean;
  usesCustomSphereCollision(): boolean;
  usesCustomEntityCollision(): boolean;
  testCustomSphereCollision(
    center: Vec3, radius: number, self: KinematicState, selfAttitude: Attitude,
  ): SphereHit | null;
  testCustomSweptSphereCollision(
    previousCenter: Vec3, center: Vec3, radius: number,
    previousSelf: KinematicState, self: KinematicState,
    previousSelfAttitude: Attitude, selfAttitude: Attitude,
  ): { readonly hit: SphereHit; readonly toi: number } | null;
  testCustomEntityCollision(
    other: EntityContactParticipant, self: KinematicState, otherState: KinematicState,
  ): ContactGeometry | null;
  testCustomSweptEntityCollision(
    other: EntityContactParticipant,
    previousSelf: KinematicState, self: KinematicState,
    previousOther: KinematicState, otherState: KinematicState,
  ): ContactGeometry | null;
  absorbHeat(specificJoules: number): void;
  collideWithEntity(
    other: EntityContactParticipant, contact: Contact, services: DynamicReactionServices,
  ): void;
  // 接触の解決が補正した状態 state へ置き換える。
  reset(state: KinematicState): void;
}

// 天体表面との接触に加わる当事者。
export interface SurfaceContactParticipant extends KinematicParticipant {
  readonly alive: boolean;
  readonly att: Attitude;
  readonly attachedTo: EntityContactParticipant | null;
  absorbHeat(specificJoules: number): void;
  collideWithCelestialBody(
    body: CelestialBody, contact: Contact, services: DynamicReactionServices,
  ): void;
  // 天体表面からの押し戻しを反映した状態 state へ置き換える。
  reset(state: KinematicState): void;
}

// 実シミュレーションがサブステップごとに進め、接触を解く個体。
export interface DynamicSimulationParticipant extends EntityContactParticipant, SurfaceContactParticipant {
  readonly att: Attitude;
  placeContactProxies(simTime: number, dt: number): void;
  contactProxies(): readonly EntityContactParticipant[];
  applyContactProxies(dt: number): void;
  outpacedByDrag(dt: number, atmosphereBodies: readonly CelestialBody[], pivot: number): boolean;
  substepDivisions(dt: number, atmosphereBodies: readonly CelestialBody[], pivot: number): number;
  stepSimulation(
    dt: number, celestialBodies: readonly CelestialBody[], occluders: readonly CelestialBody[],
    atmosphereBody: CelestialBody | null, star: CelestialBody | null, pivot: number,
    services: DynamicReactionServices,
  ): boolean;
  nextSimulationEventTime(simTime: number): number | null;
  // シミュレーションから退場させる。
  kill(): void;
}

// 状態の健全さを見るときに読む個体の状態と、操作対象ではその姿勢。
export interface SimulationState {
  readonly state: KinematicState;
}

export interface SimulationControlled extends SimulationState {
  readonly att: Attitude;
}

// 実シミュレーションで進行させるエンティティ一覧。
export interface DynamicSimulationRoster {
  // エンティティ一覧の構成が変わるたびにインクリメントされるリビジョン番号。
  readonly collectionRevision: number;
  allMotions(): readonly DynamicSimulationParticipant[];
}

export interface SimulationLifecycle extends DynamicSimulationRoster {
  // 寿命と上限を判定し、非生存個体を登録一覧から除外する。dt [s] は直前に進めた長さ、zones はいまの交戦圏。
  cleanup(
    dt: number, simTime: number, activeStage: StageOutcome,
    zones: readonly EngagementZone<EngagementParticipant>[],
  ): void;
}
