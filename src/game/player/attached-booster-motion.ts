import { LOCAL_FORWARD, qRotate } from '../../math/quat';
import { scale, v3, type Vec3 } from '../../math/vec3';
import type { DynamicMotion } from '../dynamic/dynamic-motion';
import {
  PLAYER_INERTIA_PITCH,
  PLAYER_INERTIA_ROLL,
  PLAYER_INERTIA_YAW,
  PLAYER_MASS,
} from '../dynamic/dynamic-entity/ship';
import {
  BoosterStack,
  boosterAverageAcceleration,
  nextBoosterId,
  type BoosterStackData,
  type BoosterStage,
} from './booster-stack';

// 接続中ブースターの段、燃料、推力と、段を含む機体の質量・慣性を管理する。
export class AttachedBoosterMotion {
  private readonly stack: BoosterStack;
  private thrustValue: Vec3 | null = null;
  private burnRatioValue = 0;

  // ship の質量・慣性に段を反映して始める。saved があれば段スタックを復元し、その段の ID を
  // 採番済みにする。
  public constructor(private readonly ship: DynamicMotion, saved?: BoosterStackData) {
    this.stack = saved ? BoosterStack.importData(saved) : new BoosterStack();
    for (const stage of this.stack.stages) nextBoosterId(stage.id);
    this.refreshShipMassAndInertia();
  }

  public get stages(): readonly BoosterStage[] { return this.stack.stages; }
  // 船体側から最後尾へ並ぶ段の識別子。
  public get stageIds(): readonly string[] { return this.stack.stageIds; }
  // 直近の区間の推力加速度(ECI)。噴いていなければ null。
  public get thrust(): Vec3 | null { return this.thrustValue; }
  // 直近の区間のうち燃焼していた割合 (0..1)。
  public get burnRatio(): number { return this.burnRatioValue; }

  // 段を最後尾へ接続する。
  public attach(stage: BoosterStage): void {
    this.stack.attach(stage);
    this.refreshShipMassAndInertia();
    this.ship.invalidatePrediction();
  }

  // 最後尾段の点火状態を反転し、操作後の点火状態を返す。
  public toggleIgnition(): boolean {
    const ignited = this.stack.toggleIgnition();
    this.ship.invalidatePrediction();
    return ignited;
  }

  // 最後尾段を物理状態から外し、外した段を返す。段が無ければ null。
  public detachOutermost(): BoosterStage | null {
    const stage = this.stack.detachOutermost();
    if (stage === null) return null;
    this.refreshShipMassAndInertia();
    this.clearThrust();
    this.ship.invalidatePrediction();
    return stage;
  }

  // simDt 秒ぶん燃焼させ、区間平均の加速度を求める。
  public step(simDt: number): void {
    const massBefore = PLAYER_MASS + this.stack.totalMass;
    const burn = this.stack.step(simDt);
    this.refreshShipMassAndInertia();
    this.burnRatioValue = burn.burnRatio;
    const acceleration = boosterAverageAcceleration(burn, massBefore, this.ship.mass);
    this.thrustValue = acceleration > 0
      ? scale(qRotate(this.ship.att.q, LOCAL_FORWARD), acceleration)
      : null;
  }

  // 区間推力と燃焼率をゼロへ戻す。
  public clearThrust(): void {
    this.thrustValue = null;
    this.burnRatioValue = 0;
  }

  // 段スタックの保存形。
  public serialize(): BoosterStackData {
    return this.stack.exportData();
  }

  // 段の質量と長さを機体全体の質量・慣性へ反映する。
  private refreshShipMassAndInertia(): void {
    this.ship.mass = PLAYER_MASS + this.stack.totalMass;
    // 慣性は質量比に比例し、ピッチ・ヨーだけは段の列が長いほど増える(ロールは機軸まわり)
    const massRatio = this.ship.mass / PLAYER_MASS;
    const lengthFactor = 1 + 0.35 * this.stack.stages.length ** 2;
    this.ship.att = {
      ...this.ship.att,
      inertia: v3(
        PLAYER_INERTIA_PITCH * massRatio * lengthFactor,
        PLAYER_INERTIA_YAW * massRatio * lengthFactor,
        PLAYER_INERTIA_ROLL * massRatio,
      ),
    };
  }
}
