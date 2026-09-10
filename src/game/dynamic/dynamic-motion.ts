import { Q_IDENTITY } from '../../math/quat';
import { hitsSphere, type Ray } from '../../math/ray';
import type { SphereHit } from '../../math/triangle-mesh';
import { len, scale, sub, type Vec3, v3 } from '../../math/vec3';
import { type Attitude, stepAttitude } from '../../physics/attitude';
import { airflow } from '../../physics/atmosphere';
import { localOrbitPeriod } from '../../physics/attractor';
import type { CelestialBody } from '../../physics/celestial-body';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import { type KinematicState } from '../../physics/kinematic-state';
import { sunlitFactor } from '../../physics/shadow';
import { SOLAR_CONSTANT } from '../../physics/srp';
import {
  aeroHeating, radiativeCooling, solarHeating, sphereNoseRadius, stepTemperature,
  stepThermalDeviation,
} from '../../physics/thermal';
import { orbitalElementsOf } from '../../physics/elements';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import { DISPLAY_DURATION_MAX } from '../display-window-duration';
import type { StageOutcome } from '../stages/stage-outcome';
import type { Contact } from './dynamic-entity/contact';
import type { EntityRegistry } from './entity-registry';
import { PredictedArc, trajectorySampleInterval } from './predicted-arc';
import { atmosphericMaxStep, dragTakesFullAirspeed } from './time-step';

const DRAG_COEFFICIENT = 2.2;
const STAGNATION_AREA_FRACTION = 0.6;
const SG_CONST = 1.7415e-4;

export const HULL_EMISS = 0.85;
export const ENV_TEMP = 255;
export const SMALL_DEBRIS_BCINV = 8e-3;
export const SMALL_DEBRIS_SRP_COEFF = 4.7e-3;
export const SMALL_DEBRIS_BULK_DENSITY = 2700;
export const SMALL_DEBRIS_SPECIFIC_HEAT = 900;
export const SMALL_DEBRIS_RADIATING_AREA_PER_MASS = 0.01455;
export const SMALL_DEBRIS_MAX_TEMP = 933;

export interface DynamicReactionServices {
  readonly activeStage: StageOutcome;
  readonly registry: EntityRegistry;
}

export interface DynamicMotionBehavior {
  readonly contactKind?: string;
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
  hitBodyByRay?(self: DynamicMotion, ray: Ray, pos: Vec3): boolean;
  contactProxies?(self: DynamicMotion, simTime: number, dt: number): readonly DynamicMotion[];
  applyContactProxies?(self: DynamicMotion, dt: number): void;
  onEntityContact?(
    self: DynamicMotion, other: DynamicMotion, contact: Contact, context: DynamicReactionServices,
  ): void;
  onSurfaceContact?(
    self: DynamicMotion, body: CelestialBody, contact: Contact, context: DynamicReactionServices,
  ): void;
  onBurnUp?(self: DynamicMotion, context: DynamicReactionServices): void;
  stepEnvironment?(
    self: DynamicMotion, dt: number, atmosphereBody: CelestialBody | null,
    atmospherePivot: number, sunlit: number, sunDir: Vec3,
  ): void;
  radiatingAreaPerMass?(self: DynamicMotion): number;
  solarAbsorbAreaPerMass?(self: DynamicMotion, sunDir: Vec3): number;
  nextSimulationEventTime?(self: DynamicMotion, simTime: number): number | null;
  checkLoss?(
    self: DynamicMotion, dt: number, simTime: number, context: DynamicReactionServices,
    viewerPos: Vec3, atmosphereBodies: readonly CelestialBody[],
  ): void;
}

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

const PASSIVE_BEHAVIOR: DynamicMotionBehavior = Object.freeze({ contactKind: 'generic' });

function identityAttitude(): Attitude {
  return { q: Q_IDENTITY, w: v3(), inertia: v3(1, 1, 1) };
}

// 物理結果を変えうる状態をすべて所有する。描画は参照するだけで、ここへ表示状態を持ち込まない。
export class DynamicMotion {
  public readonly actual: DynamicTrajectory;
  public readonly hasAttitude: boolean;
  public readonly behavior: DynamicMotionBehavior;
  public att: Attitude;
  public alive = true;
  public mass: number;
  public radius: number;
  public collides: boolean;
  public engagementAnchor: boolean;
  public preciseReentry: boolean;
  public contactDamageWeight: number;
  public attachedTo: DynamicMotion | null = null;
  public torque: Vec3 = v3();
  public readonly bcInv: number;
  public readonly srpCoeff: number;
  public temperature: number;
  public thermalDeviation: number;
  public readonly specificHeat: number;
  public readonly bulkDensity: number;
  public readonly emissivity: number;
  public readonly maxTemperature: number;
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

  public constructor(state: KinematicState, options: DynamicMotionProperties = {}) {
    this.actual = new DynamicTrajectory(state);
    this.att = options.attitude ?? identityAttitude();
    this.hasAttitude = options.hasAttitude ?? true;
    this.mass = options.mass ?? 1;
    this.radius = options.radius ?? 0;
    this.collides = options.collides ?? false;
    this.engagementAnchor = options.engagementAnchor ?? false;
    this.preciseReentry = options.preciseReentry ?? false;
    this.contactDamageWeight = options.contactDamageWeight ?? 1;
    this.bcInv = options.bcInv ?? 0;
    this.srpCoeff = options.srpCoeff ?? 0;
    this.temperature = options.temperature ?? ENV_TEMP;
    this.thermalDeviation = options.thermalDeviation ?? 0;
    this.specificHeat = options.specificHeat ?? 0;
    this.bulkDensity = options.bulkDensity ?? SMALL_DEBRIS_BULK_DENSITY;
    this.fixedRadiatingAreaPerMass = options.radiatingAreaPerMass ?? 0;
    this.emissivity = options.emissivity ?? HULL_EMISS;
    this.maxTemperature = options.maxTemperature ?? Infinity;
    this.baseHistoryDuration = options.historyDuration ?? 0;
    this.predictedForGhost = options.predictedForGhost ?? false;
    this.behavior = options.behavior ?? PASSIVE_BEHAVIOR;
  }

  public get state(): KinematicState { return this.actual.state; }
  public set state(state: KinematicState) { this.reset(state); }
  public get prevState(): KinematicState { return this.actual.prevState; }
  public get predicted(): DynamicTrajectory | null { return this.predictedArc?.trajectory ?? null; }
  public get arc(): PredictedArc | null { return this.predictedArc; }
  public get predictionTruncated(): boolean { return this.predictedArc?.truncated ?? false; }
  public get contactKind(): string { return this.behavior.contactKind ?? 'generic'; }
  public get contactMass(): number { return this.behavior.contactMass?.(this) ?? this.mass; }
  public get thrust(): Vec3 | null { return this._thrust; }
  public set thrust(thrust: Vec3 | null) {
    this._thrust = thrust;
    if (thrust !== null) this.invalidatePrediction();
  }

  public reset(state: KinematicState): void {
    this.actual.reset(state);
    this.invalidatePrediction();
  }

  public intersectsRay(ray: Ray, pos: Vec3): boolean {
    return this.behavior.hitBodyByRay?.(this, ray, pos) ?? hitsSphere(ray, pos, this.radius);
  }

  public requestHistoryDuration(sec: number): void {
    if (this.baseHistoryDuration <= 0) return;
    this.requestedHistoryDuration = Math.max(0, Math.min(DISPLAY_DURATION_MAX, sec));
  }

  public hasFutureReader(canDisplayFuture: boolean): boolean {
    return (this.predictedForGhost && canDisplayFuture)
      || this.trajectoryReader || this.analysisPanelReader || this.navTargetReader;
  }

  public get predictsFuture(): boolean { return this.hasFutureReader(true); }

  public ensurePredictedArc(sources: readonly CelestialBody[]): PredictedArc | null {
    if (!this.predictsFuture) return null;
    this.predictedArc ??= new PredictedArc(
      this.state, sources, this.radius, this.bcInv, this.srpCoeff,
      /* keplerTail */ true, /* consumable */ true,
    );
    return this.predictedArc;
  }

  public invalidatePrediction(): void {
    this.predictedArc = null;
  }

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

  public orbitalElementsAround(center: CelestialBody, centerPivot: number) {
    return orbitalElementsOf(this.state, center, centerPivot);
  }

  public substepDivisions(
    dt: number, atmosphereBodies: readonly CelestialBody[], pivot: number,
  ): number {
    if (!this.preciseReentry) return 1;
    const innerDt = atmosphericMaxStep(this.state, this.bcInv, atmosphereBodies, pivot);
    return innerDt >= dt ? 1 : Math.ceil(dt / innerDt);
  }

  public outpacedByDrag(
    dt: number, atmosphereBodies: readonly CelestialBody[], pivot: number,
  ): boolean {
    return !this.preciseReentry
      && dragTakesFullAirspeed(this.state, this.bcInv, atmosphereBodies, pivot, dt);
  }

  public stepSimulation(
    dt: number, celestialBodies: readonly CelestialBody[], occluders: readonly CelestialBody[],
    atmosphereBody: CelestialBody | null, star: CelestialBody | null, pivot: number,
    context: DynamicReactionServices,
  ): boolean {
    const interval = this.historySampleInterval(celestialBodies, pivot);
    const integrated = !this.followPredicted(this.state.t + dt, interval);
    if (integrated) {
      this.actual.step(
        dt, celestialBodies, occluders, atmosphereBody, pivot, this.bcInv, this.srpCoeff,
        this.thrust, interval, this.historyDuration,
      );
      this.invalidatePrediction();
    }
    if (this.hasAttitude) this.att = stepAttitude(this.att, this.torque, dt);

    const sun = this.specificHeat > 0 ? star : null;
    const toSun = sun === null ? v3() : sub(sun.positionAt(pivot), this.state.r);
    const sunDist = len(toSun);
    const sunDir = sunDist > 0 ? scale(toSun, 1 / sunDist) : v3();
    const sunlit = sun === null ? 0 : sunlitFactor(this.state.r, sun, occluders, pivot);
    this.behavior.stepEnvironment?.(this, dt, atmosphereBody, pivot, sunlit, sunDir);
    this.stepThermal(dt, atmosphereBody, pivot, sunDist, sunlit, sunDir, context);
    return integrated;
  }

  public absorbHeat(specificJoules: number): void {
    this.pendingSpecificHeat += specificJoules;
  }

  public contactsWith(other: DynamicMotion, simTime: number): boolean {
    return this.behavior.contactsWith?.(this, other, simTime) ?? true;
  }

  public usesCustomSphereCollision(): boolean {
    return this.behavior.testSphereCollision !== undefined;
  }

  public testCustomSphereCollision(
    sphereCenter: Vec3, sphereRadius: number, selfState: KinematicState,
  ): SphereHit | null {
    return this.behavior.testSphereCollision?.(this, sphereCenter, sphereRadius, selfState) ?? null;
  }

  public testCustomSweptSphereCollision(
    previousSphereCenter: Vec3, sphereCenter: Vec3, sphereRadius: number,
    previousSelfState: KinematicState, selfState: KinematicState,
  ): { readonly hit: SphereHit; readonly toi: number } | null {
    return this.behavior.testSweptSphereCollision?.(
      this, previousSphereCenter, sphereCenter, sphereRadius, previousSelfState, selfState,
    ) ?? null;
  }

  public contactProxies(simTime: number, dt: number): readonly DynamicMotion[] {
    return this.behavior.contactProxies?.(this, simTime, dt) ?? [];
  }

  public applyContactProxies(dt: number): void {
    this.behavior.applyContactProxies?.(this, dt);
  }

  public collideWithEntity(
    other: DynamicMotion, contact: Contact, context: DynamicReactionServices,
  ): void {
    this.behavior.onEntityContact?.(this, other, contact, context);
  }

  public collideWithCelestialBody(
    body: CelestialBody, contact: Contact, context: DynamicReactionServices,
  ): void {
    if (this.behavior.onSurfaceContact !== undefined) {
      this.behavior.onSurfaceContact(this, body, contact, context);
      return;
    }
    this.alive = false;
  }

  public nextSimulationEventTime(simTime: number): number | null {
    return this.behavior.nextSimulationEventTime?.(this, simTime) ?? null;
  }

  public checkLoss(
    dt: number, simTime: number, context: DynamicReactionServices, viewerPos: Vec3,
    atmosphereBodies: readonly CelestialBody[],
  ): void {
    this.behavior.checkLoss?.(this, dt, simTime, context, viewerPos, atmosphereBodies);
  }

  public updateCommands(simDt: number): void {
    this.behavior.updateCommands?.(this, simDt);
  }

  private get historyDuration(): number {
    return Math.max(this.baseHistoryDuration, this.requestedHistoryDuration);
  }

  private historySampleInterval(celestialBodies: readonly CelestialBody[], pivot: number): number {
    return this.historyDuration > 0
      ? trajectorySampleInterval(localOrbitPeriod(this.state.r, celestialBodies, pivot), this.historyDuration)
      : 0;
  }

  private followPredicted(t: number, sampleInterval: number): boolean {
    if (this.thrust !== null) return false;
    const state = this.predictedArc?.trajectory.at(t) ?? null;
    if (state === null) return false;
    this.actual.follow(state, sampleInterval, this.historyDuration);
    return true;
  }

  private radiatingAreaPerMass(): number {
    return this.behavior.radiatingAreaPerMass?.(this) ?? this.fixedRadiatingAreaPerMass;
  }

  private solarAbsorbAreaPerMass(sunDir: Vec3): number {
    return this.behavior.solarAbsorbAreaPerMass?.(this, sunDir)
      ?? (this.emissivity * this.bcInv) / DRAG_COEFFICIENT;
  }

  private stepThermal(
    dt: number, atmosphereBody: CelestialBody | null, atmospherePivot: number,
    sunDist: number, sunlit: number, sunDir: Vec3, context: DynamicReactionServices,
  ): void {
    if (this.specificHeat <= 0) return;
    const atm = atmosphereBody?.atmosphereAt(atmospherePivot) ?? null;
    let heating = solarHeating(
      SOLAR_CONSTANT, sunDist, sunlit, this.solarAbsorbAreaPerMass(sunDir));
    if (atm !== null && this.bcInv > 0) {
      const atmosphereState = atmosphereBody!.stateAt(atmospherePivot);
      const { density, speed } = airflow(
        sub(this.state.r, atmosphereState.r), sub(this.state.v, atmosphereState.v), atm);
      heating += aeroHeating(
        density, speed, this.bcInv, SG_CONST,
        sphereNoseRadius(this.bcInv, DRAG_COEFFICIENT, this.bulkDensity),
        (STAGNATION_AREA_FRACTION * this.bcInv) / DRAG_COEFFICIENT);
    }
    const area = this.radiatingAreaPerMass();
    const cooling = radiativeCooling(
      this.temperature, ENV_TEMP, this.emissivity, area, this.specificHeat, dt);
    this.temperature = stepTemperature(this.temperature, heating - cooling, this.specificHeat, dt)
      + this.pendingSpecificHeat / this.specificHeat;
    this.pendingSpecificHeat = 0;
    this.thermalDeviation = stepThermalDeviation(
      this.thermalDeviation, this.temperature, this.emissivity, area, this.specificHeat, dt);
    if (this.temperature <= this.maxTemperature) return;
    if (this.behavior.onBurnUp !== undefined) this.behavior.onBurnUp(this, context);
    else this.alive = false;
  }
}
