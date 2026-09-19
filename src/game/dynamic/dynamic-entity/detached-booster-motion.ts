import { LOCAL_FORWARD, qRotate } from '../../../math/quat';
import { scale, type Vec3 } from '../../../math/vec3';
import type { Attitude } from '../../../physics/attitude';
import type { KinematicState } from '../../../physics/kinematic-state';
import {
  BoosterStack,
  boosterAverageAcceleration,
  type BoosterStage,
} from '../../player/booster-stack';
import { DEFAULT_HISTORY_DURATION } from '../predicted-arc';
import {
  DynamicMotion,
  SMALL_DEBRIS_BULK_DENSITY,
  SMALL_DEBRIS_MAX_TEMP,
  SMALL_DEBRIS_RADIATING_AREA_PER_MASS,
  SMALL_DEBRIS_SPECIFIC_HEAT,
  SMALL_DEBRIS_SRP_COEFF,
  type DynamicMotionBehavior,
  type DynamicMotionThermal,
} from '../dynamic-motion';
import type { EntityContactParticipant } from '../dynamic-simulation-participant';

const BOOSTER_COLLISION_RADIUS = 4.2; // 長さ8mの段を包む接触球 [m]

// 分離ブースターの燃焼と、分離直後の接触の猶予。
class DetachedBoosterBehavior implements DynamicMotionBehavior {
  public readonly contactKind = 'booster';
  public readonly stack: BoosterStack;
  // 直近の刻みの燃焼比と区間平均の加速度 [m/s^2](キャッシュ)。
  private lastBurnRatio = 0;
  private lastAcceleration = 0;

  // 段 stage 1つを燃やし、collisionEnableAt [sim s] まで接触させない。
  public constructor(stage: BoosterStage, private readonly collisionEnableAt: number) {
    this.stack = new BoosterStack([stage]);
  }

  public get burnRatio(): number { return this.lastBurnRatio; }

  // 残った段の質量 [kg]。
  public mass(): number {
    return this.stack.totalMass;
  }

  // simDt 秒ぶん燃料を燃やし、その区間の平均の加速度を求める。
  public updateCommands(_self: DynamicMotion, simDt: number): void {
    const massBefore = this.stack.totalMass;
    const result = this.stack.burnOver(simDt);
    this.stack.burn(simDt);
    this.lastBurnRatio = result.burnRatio;
    this.lastAcceleration = boosterAverageAcceleration(result, massBefore, this.stack.totalMass);
  }

  // 直近の区間の平均の加速度を、機首の向きの推力加速度(ECI)にする。燃えていなければ null。
  public commandedThrust(self: DynamicMotion): Vec3 | null {
    return this.lastAcceleration <= 0 ? null : scale(qRotate(self.att.q, LOCAL_FORWARD), this.lastAcceleration);
  }

  // 接触猶予が終わる時刻でシミュレーション区間を分割する。
  public nextSimulationEventTime(_self: DynamicMotion, simTime: number): number | null {
    return this.collisionEnableAt > simTime ? this.collisionEnableAt : null;
  }

  // 分離直後の接触猶予中は接触へ参加しない。
  public contactsWith(_self: DynamicMotion, _other: EntityContactParticipant, simTime: number): boolean {
    return simTime > this.collisionEnableAt;
  }
}

// 分離ブースターの燃焼、質量、接触開始時刻を管理する。
export class DetachedBoosterMotion extends DynamicMotion {
  private readonly booster: DetachedBoosterBehavior;

  // 段 stage を state・attitude で飛ばし、collisionEnableAt まで接触させない。thermal は熱の状態で、
  // 省くと環境温度から始める。alive は生死で、省くと生きた状態で始める。
  public constructor(
    state: KinematicState,
    attitude: Attitude,
    stage: BoosterStage,
    public readonly collisionEnableAt: number,
    thermal?: DynamicMotionThermal,
    alive?: boolean,
  ) {
    const behavior = new DetachedBoosterBehavior(stage, collisionEnableAt);
    // 質量は残った段から、熱の物性は小さな金属片の値で決める
    super(state, {
      alive,
      attitude,
      ...thermal,
      radius: BOOSTER_COLLISION_RADIUS,
      collides: true,
      preciseReentry: true,
      contactDamageWeight: 0.35,
      bcInv: 0.006,
      srpCoeff: SMALL_DEBRIS_SRP_COEFF,
      specificHeat: SMALL_DEBRIS_SPECIFIC_HEAT,
      bulkDensity: SMALL_DEBRIS_BULK_DENSITY,
      radiatingAreaPerMass: SMALL_DEBRIS_RADIATING_AREA_PER_MASS,
      maxTemperature: SMALL_DEBRIS_MAX_TEMP,
      historyDuration: DEFAULT_HISTORY_DURATION,
      behavior,
    });
    this.booster = behavior;
  }

  // 燃やしている段。
  public get stage(): BoosterStage {
    return this.booster.stack.stages[0]!;
  }

  // 直近の刻みの燃焼比。
  public get burnRatio(): number {
    return this.booster.burnRatio;
  }
}
