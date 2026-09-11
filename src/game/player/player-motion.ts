import type { Vec3 } from '../../math/vec3';
import type { Attitude } from '../../physics/attitude';
import type { CelestialBody } from '../../physics/celestial-body';
import type { KinematicState } from '../../physics/kinematic-state';
import type { BoosterStackData } from './booster-stack';
import type { PowerSaveData, RadiatorSaveData } from '../save/save-data';
import type { Contact } from '../dynamic/dynamic-entity/contact';
import { DynamicMotion, type DynamicMotionBehavior } from '../dynamic/dynamic-motion';
import type { DynamicReactionServices } from '../dynamic/dynamic-simulation-participant';
import {
  MAX_HULL_TEMP,
  PLAYER_MASS,
  SHIP_RADIATING_AREA_PER_MASS,
  shipMotionOptions,
} from '../dynamic/dynamic-entity/ship';
import { AeroLoad } from './aero-load';
import { AttachedBoosterMotion } from './attached-booster-motion';
import { Belt } from './belt';
import { PowerSystem } from './power';
import { RadiatorSystem, type RadiatorSide } from './radiator';

export interface PlayerMotionReactions {
  roundsInMagazine(): number;
  thrustAcceleration(): Vec3;
  radiatorWear(): Record<RadiatorSide, number>;
  totalCoolingRate(): number;
  totalPowerGeneration(): number;
  stepBarrelThermal(dt: number): void;
  updateAltitudeAlarm(
    dt: number, position: Vec3, atmosphereBody: CelestialBody | null, atmospherePivot: number,
  ): void;
  receiveEntityContact(
    other: DynamicMotion, contact: Contact, services: DynamicReactionServices,
  ): void;
  receiveRadiatorContact(
    side: RadiatorSide, other: DynamicMotion, contact: Contact, services: DynamicReactionServices,
  ): void;
  receiveSurfaceContact(contact: Contact, services: DynamicReactionServices): void;
  receiveStructuralLoss(services: DynamicReactionServices): void;
  receiveBurnUp(services: DynamicReactionServices): void;
}

class PlayerBehavior implements DynamicMotionBehavior {
  public readonly contactKind = 'player';

  public constructor(private readonly reactions: PlayerMotionReactions) {}

  // 機体に付随する物理系を、同じ環境入力で1区間進める。
  public stepEnvironment(
    self: DynamicMotion,
    dt: number,
    atmosphereBody: CelestialBody | null,
    atmospherePivot: number,
    sunlit: number,
    sunDir: Vec3,
  ): void {
    const motion = self as PlayerMotion;
    if (!motion.alive) return;
    motion.belt.update(
      dt, this.reactions.roundsInMagazine(), motion.att, this.reactions.thrustAcceleration(),
    );
    motion.radiator.update(dt, this.reactions.radiatorWear());
    this.reactions.stepBarrelThermal(dt);
    motion.aero.update(motion.state.r, motion.state.v, atmosphereBody, atmospherePivot);
    this.reactions.updateAltitudeAlarm(dt, motion.state.r, atmosphereBody, atmospherePivot);
    motion.power.update(
      dt, sunlit, sunDir, motion.att, this.reactions.totalPowerGeneration(),
    );
  }

  // 艦体と、展開中の放熱板・ベルト節点を接触形状として返す。
  public contactProxies(self: DynamicMotion, simTime: number, dt: number): readonly DynamicMotion[] {
    const motion = self as PlayerMotion;
    motion.contactProxyScratch.length = 0;
    motion.contactProxyScratch.push(...motion.radiator.contactFolds(
      motion.state.r, motion.state.v, motion.att, simTime,
    ));
    motion.contactProxyScratch.push(...motion.belt.contactSections(
      simTime, dt, motion.state.r, motion.state.v, motion.att,
    ));
    return motion.contactProxyScratch;
  }

  // 接触解決後のベルト節点を、機体座標系の鎖へ書き戻す。
  public applyContactProxies(self: DynamicMotion, dt: number): void {
    const motion = self as PlayerMotion;
    motion.belt.applyContactSections(dt, motion.state.r, motion.state.v, motion.att);
  }

  public radiatingAreaPerMass(self: DynamicMotion): number {
    const motion = self as PlayerMotion;
    return SHIP_RADIATING_AREA_PER_MASS
      + motion.radiator.radiatingArea(this.reactions.totalCoolingRate()) / PLAYER_MASS;
  }

  public solarAbsorbAreaPerMass(self: DynamicMotion, sunDir: Vec3): number {
    const motion = self as PlayerMotion;
    const hullArea = (motion.emissivity * motion.bcInv) / 2.2;
    return hullArea + motion.radiator.solarAbsorbArea(
      sunDir, motion.att, this.reactions.totalCoolingRate(),
    ) / PLAYER_MASS;
  }

  public onEntityContact(
    _self: DynamicMotion, other: DynamicMotion, contact: Contact, services: DynamicReactionServices,
  ): void {
    this.reactions.receiveEntityContact(other, contact, services);
  }

  public onSurfaceContact(
    _self: DynamicMotion,
    _body: CelestialBody,
    contact: Contact,
    services: DynamicReactionServices,
  ): void {
    this.reactions.receiveSurfaceContact(contact, services);
  }

  public onBurnUp(_self: DynamicMotion, services: DynamicReactionServices): void {
    this.reactions.receiveBurnUp(services);
  }

  public checkLoss(
    self: DynamicMotion,
    _dt: number,
    _simTime: number,
    services: DynamicReactionServices,
  ): void {
    if ((self as PlayerMotion).aero.overStructuralLimit) {
      this.reactions.receiveStructuralLoss(services);
    }
  }
}

// 自機の軌道・姿勢・物性と、機体に付随する物理系を一体として管理する。
export class PlayerMotion extends DynamicMotion {
  public readonly belt: Belt;
  public readonly aero = new AeroLoad();
  public readonly radiator: RadiatorSystem;
  public readonly power: PowerSystem;
  public readonly attachedBoosters: AttachedBoosterMotion;
  public readonly contactProxyScratch: DynamicMotion[] = [];

  // beltLinkCount は給弾ベルトの節点数で、表示するリンクメッシュの数と揃える。
  public constructor(
    state: KinematicState,
    attitude: Attitude,
    radius: number,
    temperature: number,
    beltLinkCount: number,
    reactions: PlayerMotionReactions,
    radiatorSave?: RadiatorSaveData,
    powerSave?: PowerSaveData,
    boosterSave?: BoosterStackData,
  ) {
    super(state, shipMotionOptions(attitude, radius, {
      mass: PLAYER_MASS,
      collides: true,
      engagementAnchor: true,
      preciseReentry: true,
      temperature,
      maxTemperature: MAX_HULL_TEMP,
      behavior: new PlayerBehavior(reactions),
    }));
    this.belt = new Belt(this, beltLinkCount);
    this.radiator = new RadiatorSystem(
      this,
      (side, other, contact, services) => (
        reactions.receiveRadiatorContact(side, other, contact, services)
      ),
      radiatorSave,
    );
    this.power = new PowerSystem(powerSave);
    this.attachedBoosters = new AttachedBoosterMotion(this, boosterSave);
  }
}

// 操作対象の Motion が、自機固有の物理系を持つか。
export function isPlayerMotion(motion: DynamicMotion): motion is PlayerMotion {
  return motion instanceof PlayerMotion;
}
