import { cross, add, v3, type Vec3 } from '../../math/vec3';
import { qRotate } from '../../math/quat';
import type { Attitude } from '../../physics/attitude';
import type { CelestialBody } from '../../physics/celestial-body';
import { kinematicState, type KinematicState } from '../../physics/kinematic-state';
import {
  DynamicMotion,
  type DynamicMotionBehavior,
} from '../dynamic/dynamic-motion';
import type { Contact } from '../dynamic/dynamic-entity/contact';
import type { DynamicReactionServices } from '../dynamic/dynamic-simulation-participant';
import {
  SHIP_BCINV,
  SHIP_SRP_COEFF,
  shipMotionOptions,
} from '../dynamic/dynamic-entity/ship';
import type { ShipAssembly } from './ship-assembly';
import { shipPhysicsShape, type ShipPhysicsShape } from './ship-physics-shape';

// 既定戦闘船で既存の空力・輻射圧を再現する基準質量 [kg]。
const REFERENCE_SHIP_MASS = 1_000;

export interface ModularShipMotionReactions {
  receiveEntityContact?(
    other: DynamicMotion, contact: Contact, services: DynamicReactionServices,
  ): void;
  receiveSurfaceContact?(
    body: CelestialBody, contact: Contact, services: DynamicReactionServices,
  ): void;
  receiveBurnUp?(services: DynamicReactionServices): void;
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

  public onEntityContact(
    _self: DynamicMotion, other: DynamicMotion, contact: Contact, services: DynamicReactionServices,
  ): void {
    this.reactions.receiveEntityContact?.(other, contact, services);
  }

  public onSurfaceContact(
    _self: DynamicMotion, body: CelestialBody, contact: Contact, services: DynamicReactionServices,
  ): void {
    this.reactions.receiveSurfaceContact?.(body, contact, services);
  }

  public onBurnUp(_self: DynamicMotion, services: DynamicReactionServices): void {
    this.reactions.receiveBurnUp?.(services);
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

  public constructor(
    public readonly assembly: ShipAssembly,
    state: KinematicState,
    attitude: Attitude,
    reactions: ModularShipMotionReactions = {},
  ) {
    const shape = shipPhysicsShape(assembly);
    if (shape === null) throw new Error('modular ship requires a non-empty valid assembly');
    super(state, shipMotionOptions(withInertia(attitude, shape), shape.mass.boundingRadius, {
      mass: shape.mass.totalMass,
      collides: true,
      engagementAnchor: assembly.playerOwned,
      preciseReentry: true,
      behavior: new ModularShipBehavior(assembly.playerOwned, reactions),
    }));
    this.physicsShapeValue = shape;
    this.replaceCollisionProperties({
      mass: shape.mass.totalMass,
      radius: shape.mass.boundingRadius,
      centerOfMass: shape.centerOffset,
      inertia: shape.mass.inertia,
      compoundShape: shape.shape,
    });
  }

  public get physicsShape(): ShipPhysicsShape { return this.physicsShapeValue; }
  public get centerOffset(): Vec3 { return this.physicsShapeValue.centerOffset; }

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
    this.att = { ...this.att, w: nextW };
    this.prevAtt = { ...this.prevAtt, w: nextW };
    this.replaceCollisionProperties({
      mass: next.mass.totalMass,
      radius: next.mass.boundingRadius,
      centerOfMass: next.centerOffset,
      inertia: next.mass.inertia,
      compoundShape: next.shape,
    });
    this.physicsShapeValue = next;
    this.reset(nextState);
  }
}
