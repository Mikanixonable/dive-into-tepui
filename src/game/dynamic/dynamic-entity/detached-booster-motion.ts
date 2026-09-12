import { LOCAL_FORWARD, qRotate } from '../../../math/quat';
import { scale } from '../../../math/vec3';
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
} from '../dynamic-motion';

const BOOSTER_COLLISION_RADIUS = 4.2; // 長さ8mの段を包む接触球 [m]

class DetachedBoosterBehavior implements DynamicMotionBehavior {
  public readonly contactKind = 'booster';
  public readonly stack: BoosterStack;
  public burnRatio = 0;

  public constructor(stage: BoosterStage, private readonly collisionEnableAt: number) {
    this.stack = new BoosterStack([stage]);
  }

  // 燃料消費後の平均推力を、その区間の加速度へ変換する。
  public updateCommands(self: DynamicMotion, simDt: number): void {
    const massBefore = this.stack.totalMass;
    const result = this.stack.step(simDt);
    self.mass = this.stack.totalMass;
    this.burnRatio = result.burnRatio;
    const acceleration = boosterAverageAcceleration(result, massBefore, self.mass);
    self.thrust = acceleration <= 0
      ? null
      : scale(qRotate(self.att.q, LOCAL_FORWARD), acceleration);
  }

  // 接触猶予が終わる時刻でシミュレーション区間を分割する。
  public nextSimulationEventTime(_self: DynamicMotion, simTime: number): number | null {
    return this.collisionEnableAt > simTime ? this.collisionEnableAt : null;
  }

  // 分離直後の接触猶予中は接触へ参加しない。
  public contactsWith(_self: DynamicMotion, _other: DynamicMotion, simTime: number): boolean {
    return simTime > this.collisionEnableAt;
  }
}

// 分離ブースターの燃焼、質量、接触開始時刻を管理する。
export class DetachedBoosterMotion extends DynamicMotion {
  private readonly booster: DetachedBoosterBehavior;

  public constructor(
    state: KinematicState,
    attitude: Attitude,
    stage: BoosterStage,
    public readonly collisionEnableAt: number,
  ) {
    const behavior = new DetachedBoosterBehavior(stage, collisionEnableAt);
    super(state, {
      attitude,
      mass: behavior.stack.totalMass,
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

  public get stage(): BoosterStage {
    return this.booster.stack.stages[0]!;
  }

  public get burnRatio(): number {
    return this.booster.burnRatio;
  }
}
