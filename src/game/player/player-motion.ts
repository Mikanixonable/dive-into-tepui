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
  SHIP_BCINV,
  SHIP_RADIATING_AREA_PER_MASS,
  SHIP_SRP_COEFF,
  shipMotionOptions,
} from '../dynamic/dynamic-entity/ship';
import { PLAYER_MASS } from './player-loadout';
import { AeroLoad } from './aero-load';
import { AttachedBoosterMotion } from './attached-booster-motion';
import { BeltController } from './belt';
import { PowerSystem } from './power';
import { RadiatorSystem, type RadiatorSide } from './radiator';

// 自機の Motion が Entity 側から読む値と、接触・喪失を通知する先。
export interface PlayerMotionWeaponPort {
  roundsInMagazine(): number;
  stepBarrelThermal(dt: number): void;
}

export interface PlayerMotionEnvironmentPort {
  thrustAcceleration(): Vec3;
  radiatorWear(): Record<RadiatorSide, number>;
  totalCoolingRate(): number;
  totalPowerGeneration(): number;
}

export interface AltitudeAlarmPort {
  updateAltitudeAlarm(
    dt: number, position: Vec3, atmosphereBody: CelestialBody | null, atmospherePivot: number,
  ): void;
}

export interface PlayerMotionContactPort {
  receiveEntityContact(
    other: DynamicMotion, contact: Contact, services: DynamicReactionServices,
  ): void;
  receiveRadiatorContact(
    side: RadiatorSide, other: DynamicMotion, contact: Contact, services: DynamicReactionServices,
  ): void;
  receiveSurfaceContact(contact: Contact, services: DynamicReactionServices): void;
}

export interface PlayerMotionLossPort {
  receiveStructuralLoss(services: DynamicReactionServices): void;
  receiveBurnUp(services: DynamicReactionServices): void;
}

export interface PlayerMotionReactions {
  readonly weapon: PlayerMotionWeaponPort;
  readonly environment: PlayerMotionEnvironmentPort;
  readonly altitudeAlarm: AltitudeAlarmPort;
  readonly contact: PlayerMotionContactPort;
  readonly loss: PlayerMotionLossPort;
}

// 自機に付随する物理系を進め、接触・喪失を reactions へ通知する振る舞い。
class PlayerBehavior implements DynamicMotionBehavior {
  public readonly contactKind = 'player';
  // contactProxies が毎回詰め直して返す接触代理の列。
  private readonly contactProxyScratch: DynamicMotion[] = [];

  public constructor(private readonly reactions: PlayerMotionReactions) {}

  // 艦体の断面積が同じなら、ブースター込みの質量に反比例して弾道係数を変える。
  public bcInv(self: DynamicMotion): number {
    return self.mass > 0 ? SHIP_BCINV * PLAYER_MASS / self.mass : 0;
  }

  // 艦体の反射面積が同じなら、ブースター込みの質量に反比例して輻射圧を変える。
  public srpCoeff(self: DynamicMotion): number {
    return self.mass > 0 ? SHIP_SRP_COEFF * PLAYER_MASS / self.mass : 0;
  }

  // 機体に付随する物理系を、同じ環境入力で1区間進める。
  public stepEnvironment(
    self: DynamicMotion,
    dt: number,
    atmosphereBody: CelestialBody | null,
    atmospherePivot: number,
    sunlit: number,
    sunDir: Vec3,
  ): void {
    const motion = playerMotionOf(self);
    // 撃破された機体の付随物理系は凍結する。
    if (!motion.alive) return;
    motion.belt.update(
      dt, this.reactions.weapon.roundsInMagazine(), motion.att, this.reactions.environment.thrustAcceleration(),
    );
    motion.radiator.update(dt, this.reactions.environment.radiatorWear());
    this.reactions.weapon.stepBarrelThermal(dt);
    motion.aero.update(motion.state.r, motion.state.v, atmosphereBody, atmospherePivot);
    this.reactions.altitudeAlarm.updateAltitudeAlarm(dt, motion.state.r, atmosphereBody, atmospherePivot);
    motion.power.update(
      dt, sunlit, sunDir, motion.att, this.reactions.environment.totalPowerGeneration(),
    );
  }

  // 艦体と、展開中の放熱板・ベルト節点を接触形状として返す。
  public contactProxies(self: DynamicMotion, simTime: number, dt: number): readonly DynamicMotion[] {
    const motion = playerMotionOf(self);
    this.contactProxyScratch.length = 0;
    this.contactProxyScratch.push(...motion.radiator.contactFolds(
      motion.state.r, motion.state.v, motion.att, simTime,
    ));
    this.contactProxyScratch.push(...motion.belt.contactSections(
      simTime, dt, motion.state.r, motion.state.v, motion.att,
    ));
    return this.contactProxyScratch;
  }

  // 接触解決後のベルト節点を、機体座標系の鎖へ書き戻す。
  public applyContactProxies(self: DynamicMotion, dt: number): void {
    const motion = playerMotionOf(self);
    motion.belt.applyContactSections(dt, motion.state.r, motion.state.v, motion.att);
  }

  // 艦体の放射面積に、展開中の放熱板の面積を足した質量あたりの値 [m^2/kg]。
  public radiatingAreaPerMass(self: DynamicMotion): number {
    const motion = playerMotionOf(self);
    if (motion.mass <= 0) return 0;
    return SHIP_RADIATING_AREA_PER_MASS * PLAYER_MASS / motion.mass
      + motion.radiator.radiatingArea(this.reactions.environment.totalCoolingRate()) / motion.mass;
  }

  // 艦体と放熱板が sunDir からの日射を吸収する、質量あたりの面積 [m^2/kg]。
  public solarAbsorbAreaPerMass(self: DynamicMotion, sunDir: Vec3): number {
    const motion = playerMotionOf(self);
    const hullArea = (motion.emissivity * motion.bcInv) / 2.2;
    return hullArea + motion.radiator.solarAbsorbArea(
      sunDir, motion.att, this.reactions.environment.totalCoolingRate(),
    ) / Math.max(motion.mass, 1e-9);
  }

  // 他の個体との接触を reactions へ渡す。
  public onEntityContact(
    _self: DynamicMotion, other: DynamicMotion, contact: Contact, services: DynamicReactionServices,
  ): void {
    this.reactions.contact.receiveEntityContact(other, contact, services);
  }

  // 天体表面への接触を reactions へ渡す。
  public onSurfaceContact(
    _self: DynamicMotion,
    _body: CelestialBody,
    contact: Contact,
    services: DynamicReactionServices,
  ): void {
    this.reactions.contact.receiveSurfaceContact(contact, services);
  }

  // 温度上限を超えた焼失を reactions へ渡す。
  public onBurnUp(_self: DynamicMotion, services: DynamicReactionServices): void {
    this.reactions.loss.receiveBurnUp(services);
  }

  // 空力荷重が構造限界を超えていれば、構造喪失を reactions へ渡す。
  public checkLoss(
    self: DynamicMotion,
    _dt: number,
    _simTime: number,
    services: DynamicReactionServices,
  ): void {
    if (playerMotionOf(self).aero.overStructuralLimit) {
      this.reactions.loss.receiveStructuralLoss(services);
    }
  }
}

// 自機の軌道・姿勢・物性と、機体に付随する物理系を一体として管理する。
export class PlayerMotion extends DynamicMotion {
  public readonly belt: BeltController;
  public readonly aero = new AeroLoad();
  public readonly radiator: RadiatorSystem;
  public readonly power: PowerSystem;
  public readonly attachedBoosters: AttachedBoosterMotion;

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
    // 付随物理系は、この Motion を本体として組む。保存があればその状態から戻す。
    this.belt = new BeltController(this, beltLinkCount);
    this.radiator = new RadiatorSystem(
      this,
      (side, other, contact, services) => (
        reactions.contact.receiveRadiatorContact(side, other, contact, services)
      ),
      radiatorSave,
    );
    this.power = new PowerSystem(powerSave);
    this.attachedBoosters = new AttachedBoosterMotion(this, boosterSave);
  }
}

function playerMotionOf(motion: DynamicMotion): PlayerMotion {
  if (!(motion instanceof PlayerMotion)) throw new Error('PlayerBehavior received a non-player motion');
  return motion;
}

// motion を自機の Motion へ絞り込む型ガード。
export function isPlayerMotion(motion: DynamicMotion): motion is PlayerMotion {
  return motion instanceof PlayerMotion;
}
