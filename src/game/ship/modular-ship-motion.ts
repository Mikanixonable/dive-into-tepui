// モジュール船を一体剛体として進め、船体由来の形状・質量・補助システムを同期する。
import { cross, add, sub, v3, type Vec3 } from '../../math/vec3';
import { LOCAL_RIGHT, qRotate } from '../../math/quat';
import type { Attitude } from '../../physics/attitude';
import type { CelestialBody } from '../../physics/celestial-body';
import { kinematicState, type KinematicState } from '../../physics/kinematic-state';
import {
  DynamicMotion,
  type DynamicMotionBehavior,
} from '../dynamic/dynamic-motion';
import type { Contact } from '../dynamic/dynamic-entity/contact';
import type { DynamicReactionServices, EntityContactParticipant } from '../dynamic/dynamic-simulation-participant';
import {
  MAX_HULL_TEMP,
  SHIP_RADIATING_AREA_PER_MASS,
  SHIP_BCINV,
  SHIP_SRP_COEFF,
  shipMotionOptions,
} from '../dynamic/dynamic-entity/ship';
import type { SerializedPowerSystem } from '../player/power';
import type { SerializedRadiatorSystem } from '../player/radiator';
import { AeroLoad } from '../player/aero-load';
import { BeltController, type SerializedBeltController } from '../player/belt';
import { PowerSystem } from '../player/power';
import { RadiatorSystem } from '../player/radiator';
import type { ShipAssembly } from './ship-assembly';
import { shipPhysicsShape, type ShipPhysicsShape } from './ship-physics-shape';

// 空力・輻射圧係数を質量あたりへ換算する基準質量 [kg]。
const REFERENCE_SHIP_MASS = 1_000;

export interface ModularShipMotionReactions {
  roundsInMagazine?(): number;
  stepBarrelThermal?(dt: number): void;
  thrustAcceleration?(): Vec3;
  radiatorWear?(): Readonly<Record<string, number>>;
  totalCoolingRate?(): number;
  totalPowerGeneration?(): number;
  updateAltitudeAlarm?(
    dt: number, position: Vec3, atmosphereBody: CelestialBody | null, atmospherePivot: number,
  ): void;
  receiveEntityContact?(
    other: EntityContactParticipant, contact: Contact, services: DynamicReactionServices,
  ): void;
  receiveSurfaceContact?(
    body: CelestialBody, contact: Contact, services: DynamicReactionServices,
  ): void;
  receiveRadiatorContact?(
    moduleId: string, other: EntityContactParticipant, contact: Contact, services: DynamicReactionServices,
  ): void;
  receiveStructuralLoss?(services: DynamicReactionServices): void;
  receiveBurnUp?(services: DynamicReactionServices): void;
}

export interface ModularShipMotionSystems {
  readonly temperature?: number;
  readonly beltLinkCount?: number;
  readonly beltSave?: SerializedBeltController;
  readonly radiatorSave?: SerializedRadiatorSystem;
  readonly powerSave?: SerializedPowerSystem;
}

class ModularShipBehavior implements DynamicMotionBehavior {
  public readonly contactKind;

  public constructor(
    playerOwned: boolean,
    private readonly reactions: ModularShipMotionReactions,
  ) {
    this.contactKind = playerOwned ? 'player' as const : 'generic' as const;
  }

  public bcInv(self: DynamicMotion): number {
    return self.mass > 0 ? SHIP_BCINV * REFERENCE_SHIP_MASS / self.mass : 0;
  }

  public srpCoeff(self: DynamicMotion): number {
    return self.mass > 0 ? SHIP_SRP_COEFF * REFERENCE_SHIP_MASS / self.mass : 0;
  }

  public stepEnvironment(
    self: DynamicMotion,
    dt: number,
    atmosphereBody: CelestialBody | null,
    atmospherePivot: number,
    sunlit: number,
    sunDir: Vec3,
  ): void {
    const motion = modularShipMotionOf(self);
    if (!motion.alive) return;
    motion.belt.update(
      dt,
      this.reactions.roundsInMagazine?.() ?? 0,
      motion.att,
      this.reactions.thrustAcceleration?.() ?? v3(),
    );
    motion.radiator.update(
      dt,
      this.reactions.radiatorWear?.() ?? {},
    );
    this.reactions.stepBarrelThermal?.(dt);
    motion.aero.update(motion.state.r, motion.state.v, atmosphereBody, atmospherePivot);
    this.reactions.updateAltitudeAlarm?.(
      dt, motion.state.r, atmosphereBody, atmospherePivot,
    );
    motion.power.update(
      dt, sunlit, sunDir, motion.att, this.reactions.totalPowerGeneration?.() ?? 0,
    );
  }

  public placeContactProxies(self: DynamicMotion, simTime: number, dt: number): void {
    const motion = modularShipMotionOf(self);
    const rootOffset = qRotate(motion.att.q, motion.centerOffset);
    const rootVelocityOffset = qRotate(motion.att.q, cross(motion.att.w, motion.centerOffset));
    motion.radiator.placeContactFolds(
      sub(motion.state.r, rootOffset), sub(motion.state.v, rootVelocityOffset), motion.att, simTime,
    );
    motion.belt.placeContactSections(motion, simTime, dt, motion.state.r, motion.state.v, motion.att);
  }

  public contactProxies(self: DynamicMotion): readonly EntityContactParticipant[] {
    const motion = modularShipMotionOf(self);
    return [...motion.radiator.contactFolds, ...motion.belt.contactSections];
  }

  public applyContactProxies(self: DynamicMotion, dt: number): void {
    const motion = modularShipMotionOf(self);
    motion.belt.applyContactSections(dt, motion.state.r, motion.state.v, motion.att);
  }

  public radiatingAreaPerMass(self: DynamicMotion): number {
    const motion = modularShipMotionOf(self);
    if (motion.mass <= 0) return 0;
    return SHIP_RADIATING_AREA_PER_MASS * REFERENCE_SHIP_MASS / motion.mass
      + motion.radiator.radiatingArea(this.reactions.totalCoolingRate?.() ?? 0) / motion.mass;
  }

  public solarAbsorbAreaPerMass(self: DynamicMotion, sunDir: Vec3): number {
    const motion = modularShipMotionOf(self);
    const hullArea = (motion.emissivity * motion.bcInv) / 2.2;
    return hullArea + motion.radiator.solarAbsorbArea(
      sunDir, motion.att, this.reactions.totalCoolingRate?.() ?? 0,
    ) / Math.max(motion.mass, 1e-9);
  }

  public onEntityContact(
    _self: DynamicMotion, other: DynamicMotion, contact: Contact, services: DynamicReactionServices,
  ): void {
    this.reactions.receiveEntityContact?.(other, contact, services);
  }

  public contactsWith(self: DynamicMotion, other: DynamicMotion, simTime: number): boolean {
    return modularShipMotionOf(self).contactsAllowedWith(other, simTime);
  }

  public nextSimulationEventTime(self: DynamicMotion, simTime: number): number | null {
    return modularShipMotionOf(self).nextCollisionGraceBoundary(simTime);
  }

  public onSurfaceContact(
    _self: DynamicMotion, body: CelestialBody, contact: Contact, services: DynamicReactionServices,
  ): void {
    this.reactions.receiveSurfaceContact?.(body, contact, services);
  }

  public onBurnUp(_self: DynamicMotion, services: DynamicReactionServices): void {
    this.reactions.receiveBurnUp?.(services);
  }

  public checkLoss(
    self: DynamicMotion,
    _dt: number,
    _simTime: number,
    services: DynamicReactionServices,
  ): void {
    if (modularShipMotionOf(self).aero.overStructuralLimit) {
      this.reactions.receiveStructuralLoss?.(services);
    }
  }
}

function withInertia(attitude: Attitude, shape: ShipPhysicsShape): Attitude {
  return { ...attitude, inertia: shape.mass.inertia };
}

function componentwiseAngularMomentumVelocity(
  angularVelocity: Vec3, oldInertia: Vec3, nextInertia: Vec3,
): Vec3 {
  return v3(
    angularVelocity.x * oldInertia.x / nextInertia.x,
    angularVelocity.y * oldInertia.y / nextInertia.y,
    angularVelocity.z * oldInertia.z / nextInertia.z,
  );
}

// ShipAssembly から導いた一体剛体。state.r は常に現在の COM を表し、assembly 座標の
// 原点との差は centerOffset にだけ保持する。
export class ModularShipMotion extends DynamicMotion {
  private physicsShapeValue: ShipPhysicsShape;
  private readonly collisionGraceUntil = new Map<EntityContactParticipant, number>();
  public readonly belt: BeltController;
  public readonly aero = new AeroLoad();
  public readonly radiator: RadiatorSystem;
  public readonly power: PowerSystem;

  public constructor(
    public readonly assembly: ShipAssembly,
    state: KinematicState,
    attitude: Attitude,
    reactions: ModularShipMotionReactions = {},
    systems: ModularShipMotionSystems = {},
  ) {
    const shape = shipPhysicsShape(assembly);
    if (shape === null) throw new Error('modular ship requires a non-empty valid assembly');
    super(state, shipMotionOptions(withInertia(attitude, shape), shape.mass.boundingRadius, {
      mass: shape.mass.totalMass,
      collides: true,
      engagementAnchor: assembly.playerOwned,
      preciseReentry: true,
      temperature: systems.temperature,
      maxTemperature: MAX_HULL_TEMP,
      behavior: new ModularShipBehavior(assembly.playerOwned, reactions),
    }));
    this.physicsShapeValue = shape;
    this.replaceCollisionProperties({
      mass: shape.mass.totalMass,
      radius: shape.mass.boundingRadius,
      centerOfMass: shape.centerOffset,
      inertia: shape.mass.inertia,
      compoundShape: shape.shape,
      surfaceShape: shape.surfaceShape,
    });
    this.belt = systems.beltSave
      ? BeltController.deserialize(systems.beltSave)
      : BeltController.create(systems.beltLinkCount ?? 18);
    this.synchronizeBeltMount(shape);
    const onRadiatorContact = (moduleId: string, other: EntityContactParticipant, contact: Contact,
      services: DynamicReactionServices): void => {
      reactions.receiveRadiatorContact?.(moduleId, other, contact, services);
    };
    this.radiator = systems.radiatorSave === undefined
      ? new RadiatorSystem(this, onRadiatorContact, undefined, undefined, assembly)
      : RadiatorSystem.deserialize(systems.radiatorSave, this, onRadiatorContact, assembly);
    this.power = systems.powerSave
      ? PowerSystem.deserialize(systems.powerSave, assembly)
      : new PowerSystem(undefined, undefined, undefined, assembly);
    this.radiator.syncAssembly(assembly);
    this.power.syncAssembly(assembly);
  }

  public get physicsShape(): ShipPhysicsShape { return this.physicsShapeValue; }
  public get centerOffset(): Vec3 { return this.physicsShapeValue.centerOffset; }

  public resetRigidState(state: KinematicState, attitude: Attitude = this.att): void {
    this.resetAttitude(attitude);
    this.reset(state);
  }

  public ignoreCollisionWith(other: EntityContactParticipant, until: number): void {
    if (!Number.isFinite(until) || until <= this.state.t) return;
    this.collisionGraceUntil.set(other, until);
    this.invalidatePrediction();
  }

  public contactsAllowedWith(other: EntityContactParticipant, simTime: number): boolean {
    const until = this.collisionGraceUntil.get(other);
    if (until === undefined) return true;
    if (simTime > until) {
      this.collisionGraceUntil.delete(other);
      return true;
    }
    return false;
  }

  public nextCollisionGraceBoundary(simTime: number): number | null {
    let earliest = Infinity;
    for (const [other, until] of this.collisionGraceUntil) {
      if (until > simTime) earliest = Math.min(earliest, until);
      else this.collisionGraceUntil.delete(other);
    }
    return Number.isFinite(earliest) ? earliest : null;
  }

  // assembly の変更後に shape と物性を同時更新する。COM の移動は assembly 原点の
  // world pose を保つ並進へ変換し、回転によるその点の速度と対角角運動量も連続にする。
  public synchronizeAssembly(): void {
    const next = shipPhysicsShape(this.assembly);
    if (next === null) throw new Error('cannot synchronize an empty or invalid ship assembly');
    const previous = this.physicsShapeValue;
    const deltaBody = v3(
      next.centerOffset.x - previous.centerOffset.x,
      next.centerOffset.y - previous.centerOffset.y,
      next.centerOffset.z - previous.centerOffset.z,
    );
    const deltaWorld = qRotate(this.att.q, deltaBody);
    const rotationalVelocityBody = cross(this.att.w, deltaBody);
    const nextState = kinematicState<'eci'>(
      this.state.t,
      add(this.state.r, deltaWorld),
      add(this.state.v, qRotate(this.att.q, rotationalVelocityBody)),
    );
    const nextW = componentwiseAngularMomentumVelocity(
      this.att.w, previous.mass.inertia, next.mass.inertia,
    );
    this.resetAttitude({ ...this.att, w: nextW }, { ...this.prevAtt, w: nextW });
    this.replaceCollisionProperties({
      mass: next.mass.totalMass,
      radius: next.mass.boundingRadius,
      centerOfMass: next.centerOffset,
      inertia: next.mass.inertia,
      compoundShape: next.shape,
      surfaceShape: next.surfaceShape,
    });
    this.physicsShapeValue = next;
    this.synchronizeBeltMount(next);
    this.reset(nextState);
  }

  private synchronizeBeltMount(shape: ShipPhysicsShape): void {
    const weapon = this.assembly.modules.find(module => module.kind === 'weapon' && module.hp > 0);
    if (weapon === undefined) return;
    const definition = this.assembly.definition(weapon.id);
    const transform = this.assembly.worldTransformOf(weapon.id);
    if (definition === null || transform === null) return;
    const moduleAnchor = definition.feedPort;
    const anchor = add(
      transform.position,
      qRotate(transform.rotation, moduleAnchor),
    );
    this.belt.setMount(
      v3(
        anchor.x - shape.centerOffset.x,
        anchor.y - shape.centerOffset.y,
        anchor.z - shape.centerOffset.z,
      ),
      qRotate(transform.rotation, LOCAL_RIGHT),
    );
  }
}

function modularShipMotionOf(motion: DynamicMotion): ModularShipMotion {
  if (!(motion instanceof ModularShipMotion)) {
    throw new Error('ModularShipBehavior received a non-modular ship motion');
  }
  return motion;
}

export function isModularShipMotion(motion: DynamicMotion): motion is ModularShipMotion {
  return motion instanceof ModularShipMotion;
}
