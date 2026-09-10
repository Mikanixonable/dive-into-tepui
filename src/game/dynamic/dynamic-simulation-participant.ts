import type { Vec3 } from '../../math/vec3';
import type { Attitude } from '../../physics/attitude';
import type { CelestialBody } from '../../physics/celestial-body';
import type { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import type { KinematicState } from '../../physics/kinematic-state';
import type { SphereHit } from '../../math/triangle-mesh';
import type { StageOutcome } from '../stages/stage-outcome';
import type { Contact } from './dynamic-entity/contact';
import type { EntityRegistry } from './entity-registry';
import type { PredictedArc } from './predicted-arc';

export interface PredictableMotion {
  hasFutureReader(canDisplayFuture: boolean): boolean;
  readonly predictsFuture: boolean;
  readonly predicted: DynamicTrajectory | null;
  readonly predictionTruncated: boolean;
  ensurePredictedArc(sources: readonly CelestialBody[]): PredictedArc | null;
}

export interface PredictableMotionRoster {
  allMotions(): readonly PredictableMotion[];
}

export interface KinematicParticipant {
  state: KinematicState;
  readonly prevState: KinematicState;
  readonly radius: number;
}

export interface EntityContactParticipant extends KinematicParticipant {
  alive: boolean;
  readonly engagementAnchor: boolean;
  readonly collides: boolean;
  readonly attachedTo: EntityContactParticipant | null;
  readonly contactMass: number;
  contactsWith(other: EntityContactParticipant, simTime: number): boolean;
  usesCustomSphereCollision(): boolean;
  testCustomSphereCollision(center: Vec3, radius: number, self: KinematicState): SphereHit | null;
  testCustomSweptSphereCollision(
    previousCenter: Vec3, center: Vec3, radius: number,
    previousSelf: KinematicState, self: KinematicState,
  ): { readonly hit: SphereHit; readonly toi: number } | null;
  absorbHeat(specificJoules: number): void;
  collideWithEntity(
    other: EntityContactParticipant, contact: Contact,
    context: { readonly activeStage: StageOutcome; readonly registry: EntityRegistry },
  ): void;
}

export interface SurfaceContactParticipant extends KinematicParticipant {
  alive: boolean;
  readonly attachedTo: EntityContactParticipant | null;
  absorbHeat(specificJoules: number): void;
  collideWithCelestialBody(
    body: CelestialBody, contact: Contact,
    context: { readonly activeStage: StageOutcome; readonly registry: EntityRegistry },
  ): void;
}

export interface DynamicSimulationParticipant extends EntityContactParticipant, SurfaceContactParticipant {
  readonly att: Attitude;
  contactProxies(simTime: number, dt: number): readonly DynamicSimulationParticipant[];
  applyContactProxies(dt: number): void;
  outpacedByDrag(dt: number, atmosphereBodies: readonly CelestialBody[], pivot: number): boolean;
  substepDivisions(dt: number, atmosphereBodies: readonly CelestialBody[], pivot: number): number;
  stepSimulation(
    dt: number, celestialBodies: readonly CelestialBody[], occluders: readonly CelestialBody[],
    atmosphereBody: CelestialBody | null, star: CelestialBody | null, pivot: number,
    context: { readonly activeStage: StageOutcome; readonly registry: EntityRegistry },
  ): boolean;
  nextSimulationEventTime(simTime: number): number | null;
}

export interface SimulationState {
  readonly state: KinematicState;
}

export interface SimulationControlled extends SimulationState {
  readonly att: Attitude;
}

export interface DynamicSimulationRoster {
  readonly collectionRevision: number;
  allMotions(): readonly DynamicSimulationParticipant[];
}

export interface SimulationLifecycle extends DynamicSimulationRoster {
  cleanup(
    dt: number, simTime: number, activeStage: StageOutcome,
    viewerPos: Vec3, atmosphereBodies: readonly CelestialBody[],
  ): void;
}
