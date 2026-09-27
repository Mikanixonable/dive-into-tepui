// モジュール船を一体剛体として進め、船体由来の形状・質量・補助システムを同期する。
import { cross, add, scale, sub, v3, type Vec3 } from '../../math/vec3';
import { LOCAL_RIGHT, qInvert, qRotate } from '../../math/quat';
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
  // ベルトに残っているマガジンの本数(装填中の1本を含む)。ベルトの接触代理の範囲を決める。
  magsLeft?(): number;
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

  // playerOwned に対応する接触種別と船体反応口を設定する。
  public constructor(
    playerOwned: boolean,
    private readonly reactions: ModularShipMotionReactions,
  ) {
    this.contactKind = playerOwned ? 'player' as const : 'generic' as const;
  }

  // 質量に応じて基準の弾道係数を換算する。
  public bcInv(self: DynamicMotion): number {
    return self.mass > 0 ? SHIP_BCINV * REFERENCE_SHIP_MASS / self.mass : 0;
  }

  // 質量に応じて基準の輻射圧係数を換算する。
  public srpCoeff(self: DynamicMotion): number {
    return self.mass > 0 ? SHIP_SRP_COEFF * REFERENCE_SHIP_MASS / self.mass : 0;
  }

  // 環境入力を船体の空力・熱・電力系へ反映する。
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
    // 給弾と冷却は船体状態に応じて進める。
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
    // 大気抵抗と高度警報へ現在の環境を渡す。
    motion.aero.update(motion.state.r, motion.state.v, atmosphereBody, atmospherePivot);
    this.reactions.updateAltitudeAlarm?.(
      dt, motion.state.r, atmosphereBody, atmospherePivot,
    );
    // 日照と発電量から電力状態を進める。
    motion.power.update(
      dt, sunlit, sunDir, motion.att, this.reactions.totalPowerGeneration?.() ?? 0,
    );
  }

  // 重心位置からラジエーターと給弾ベルトの接触代理を配置する。
  public placeContactProxies(self: DynamicMotion, simTime: number, dt: number): void {
    const motion = modularShipMotionOf(self);
    const rootOffset = qRotate(motion.att.q, motion.centerOffset);
    const rootVelocityOffset = qRotate(motion.att.q, cross(motion.att.w, motion.centerOffset));
    motion.radiator.placeContactFolds(
      sub(motion.state.r, rootOffset), sub(motion.state.v, rootVelocityOffset), motion.att, simTime,
    );
    motion.belt.placeContactSections(
      motion, this.reactions.magsLeft?.() ?? 0, simTime, dt, motion.state.r, motion.state.v, motion.att,
    );
  }

  // 衝突判定に使うラジエーターと給弾ベルトの接触代理を返す。
  public contactProxies(self: DynamicMotion): readonly EntityContactParticipant[] {
    const motion = modularShipMotionOf(self);
    return [...motion.radiator.contactFolds, ...motion.belt.contactSections];
  }

  // 接触した給弾ベルト区間の反力を船体へ反映する。
  public applyContactProxies(self: DynamicMotion, dt: number): void {
    const motion = modularShipMotionOf(self);
    motion.belt.applyContactSections(dt, motion.state.r, motion.state.v, motion.att);
  }

  // 船体とラジエーターを合わせた単位質量あたりの放熱面積を返す。
  public radiatingAreaPerMass(self: DynamicMotion): number {
    const motion = modularShipMotionOf(self);
    if (motion.mass <= 0) return 0;
    return SHIP_RADIATING_AREA_PER_MASS * REFERENCE_SHIP_MASS / motion.mass
      + motion.radiator.radiatingArea(this.reactions.totalCoolingRate?.() ?? 0) / motion.mass;
  }

  // 船体とラジエーターを合わせた単位質量あたりの日射吸収面積を返す。
  public solarAbsorbAreaPerMass(self: DynamicMotion, sunDir: Vec3): number {
    const motion = modularShipMotionOf(self);
    const hullArea = (motion.emissivity * motion.bcInv) / 2.2;
    return hullArea + motion.radiator.solarAbsorbArea(
      sunDir, motion.att, this.reactions.totalCoolingRate?.() ?? 0,
    ) / Math.max(motion.mass, 1e-9);
  }

  // 船体に起きた接触を反応先へ渡す。
  public onEntityContact(
    _self: DynamicMotion, other: DynamicMotion, contact: Contact, services: DynamicReactionServices,
  ): void {
    this.reactions.receiveEntityContact?.(other, contact, services);
  }

  // 指定時刻に相手との接触を許可するか返す。
  public contactsWith(self: DynamicMotion, other: DynamicMotion, simTime: number): boolean {
    return modularShipMotionOf(self).contactsAllowedWith(other, simTime);
  }

  // 接触猶予のうち、次にシミュレーションを区切る時刻を返す。
  public nextSimulationEventTime(self: DynamicMotion, simTime: number): number | null {
    return modularShipMotionOf(self).nextCollisionGraceBoundary(simTime);
  }

  // 船体表面への接触を反応先へ渡す。
  public onSurfaceContact(
    _self: DynamicMotion, body: CelestialBody, contact: Contact, services: DynamicReactionServices,
  ): void {
    this.reactions.receiveSurfaceContact?.(body, contact, services);
  }

  // 燃え尽きの発生を反応先へ渡す。
  public onBurnUp(_self: DynamicMotion, services: DynamicReactionServices): void {
    this.reactions.receiveBurnUp?.(services);
  }

  // 空力荷重が構造限界を超えたとき、船体喪失を通知する。
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

// 形状が持つ慣性テンソルを姿勢値へ反映する。
function withInertia(attitude: Attitude, shape: ShipPhysicsShape): Attitude {
  return { ...attitude, inertia: shape.mass.inertia };
}

// 慣性が変わった後も各軸の角運動量を保つ角速度を返す。
function componentwiseAngularMomentumVelocity(
  angularVelocity: Vec3, oldInertia: Vec3, nextInertia: Vec3,
): Vec3 {
  return v3(
    angularVelocity.x * oldInertia.x / nextInertia.x,
    angularVelocity.y * oldInertia.y / nextInertia.y,
    angularVelocity.z * oldInertia.z / nextInertia.z,
  );
}

// 船体運動の位置と速度は、組立の重心を基準にする。
export class ModularShipMotion extends DynamicMotion {
  private physicsShapeValue: ShipPhysicsShape;
  private readonly collisionGraceUntil = new Map<EntityContactParticipant, number>();
  public readonly belt: BeltController;
  public readonly aero = new AeroLoad();
  public readonly radiator: RadiatorSystem;
  public readonly power: PowerSystem;

  // assembly から剛体と補助系を構築し、systems の記録があれば復元する。
  public constructor(
    public readonly assembly: ShipAssembly,
    state: KinematicState,
    attitude: Attitude,
    reactions: ModularShipMotionReactions = {},
    systems: ModularShipMotionSystems = {},
  ) {
    // 船体形状から初期質量・慣性・衝突特性を得る。
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
    // 補助系の記録を復元するか、既定値から組み立てる。
    this.belt = systems.beltSave
      ? BeltController.deserialize(systems.beltSave)
      : BeltController.create(systems.beltLinkCount ?? 18);
    this.synchronizeBeltMount(shape);
    // ラジエーター接触を船体側の反応口へ渡す。
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

  // 並進と回転の初期状態をまとめて差し替える。
  public resetRigidState(state: KinematicState, attitude: Attitude = this.att): void {
    this.resetAttitude(attitude);
    this.reset(state);
  }

  // worldPoint に加わる力積 [N·s] で、重心速度と機体座標系の角速度を瞬時に更新する。
  public applyImpulseAtPoint(impulse: Vec3, worldPoint: Vec3): void {
    const attitude = this.att;
    const worldToBody = qInvert(attitude.q);
    // 作用点の腕と力積から、機体座標での角運動量変化を求める。
    const armBody = qRotate(worldToBody, sub(worldPoint, this.state.r));
    const impulseBody = qRotate(worldToBody, impulse);
    const angularImpulse = cross(armBody, impulseBody);
    // 対角慣性で角速度を更新し、並進には全力積を適用する。
    const nextAttitude: Attitude = {
      ...attitude,
      w: v3(
        attitude.w.x + angularImpulse.x / attitude.inertia.x,
        attitude.w.y + angularImpulse.y / attitude.inertia.y,
        attitude.w.z + angularImpulse.z / attitude.inertia.z,
      ),
    };
    const nextState = kinematicState<'eci'>(
      this.state.t,
      this.state.r,
      add(this.state.v, scale(impulse, 1 / this.mass)),
    );
    this.resetRigidState(nextState, nextAttitude);
  }

  // 指定した時刻まで相手との衝突を猶予する。
  public ignoreCollisionWith(other: EntityContactParticipant, until: number): void {
    if (!Number.isFinite(until) || until <= this.state.t) return;
    this.collisionGraceUntil.set(other, until);
    this.invalidatePrediction();
  }

  // 衝突猶予の期限に応じて、相手との接触可否を返す。
  public contactsAllowedWith(other: EntityContactParticipant, simTime: number): boolean {
    const until = this.collisionGraceUntil.get(other);
    if (until === undefined) return true;
    if (simTime > until) {
      this.collisionGraceUntil.delete(other);
      return true;
    }
    return false;
  }

  // 現在時刻より先にある衝突猶予の最短期限を返す。
  public nextCollisionGraceBoundary(simTime: number): number | null {
    let earliest = Infinity;
    for (const [other, until] of this.collisionGraceUntil) {
      if (until > simTime) earliest = Math.min(earliest, until);
      else this.collisionGraceUntil.delete(other);
    }
    return Number.isFinite(earliest) ? earliest : null;
  }

  // 組立変更後の質量特性を反映し、組立原点の運動と各軸角運動量を保つ。
  public synchronizeAssembly(): void {
    // 新しい重心へ並進状態を移し、組立原点の速度を保つ。
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
    // 衝突形状と補助系を新しい組立へ揃える。
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

  // 有効な主砲の給弾口を、船体重心基準の帯制御系へ反映する。
  private synchronizeBeltMount(shape: ShipPhysicsShape): void {
    // 砲の給弾口と方向を船体座標へ移す。
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

// DynamicMotion を船体の具象型として取り出し、型が異なれば例外にする。
function modularShipMotionOf(motion: DynamicMotion): ModularShipMotion {
  if (!(motion instanceof ModularShipMotion)) {
    throw new Error('ModularShipBehavior received a non-modular ship motion');
  }
  return motion;
}

// motion がモジュール船の剛体運動かを判定する。
export function isModularShipMotion(motion: DynamicMotion): motion is ModularShipMotion {
  return motion instanceof ModularShipMotion;
}
