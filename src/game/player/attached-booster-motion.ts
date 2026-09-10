import { LOCAL_FORWARD, qRotate } from '../../math/quat';
import { scale, v3, type Vec3 } from '../../math/vec3';
import type { AttachedBoostersDisplay } from '../../render/dynamic/player/attached-boosters-view';
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

  public constructor(private readonly ship: DynamicMotion, saved?: BoosterStackData) {
    this.stack = saved ? BoosterStack.importData(saved) : new BoosterStack();
    for (const stage of this.stack.stages) nextBoosterId(stage.id);
    this.refreshShipMassAndInertia();
  }

  public get stages(): readonly BoosterStage[] { return this.stack.stages; }
  public get thrust(): Vec3 | null { return this.thrustValue; }
  public get burnRatio(): number { return this.burnRatioValue; }

  // 段の並びと噴射炎を組むための、そのフレームの表示値。
  public get display(): AttachedBoostersDisplay {
    return {
      stageIds: this.stack.stageIds,
      firing: this.thrustValue !== null,
      burnRatio: this.burnRatioValue,
    };
  }

  // 段を最後尾へ接続する。
  public attach(stage: BoosterStage): void {
    this.stack.attach(stage);
    this.refreshShipMassAndInertia();
    this.ship.invalidatePrediction();
  }

  // 最後尾段の点火状態を反転する。
  public toggleIgnition(): boolean {
    const ignited = this.stack.toggleIgnition();
    this.ship.invalidatePrediction();
    return ignited;
  }

  // 最後尾段を物理状態から外し、外した段を返す。
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

  public serialize(): BoosterStackData {
    return this.stack.exportData();
  }

  // 段の質量と長さを機体全体の質量・慣性へ反映する。
  private refreshShipMassAndInertia(): void {
    this.ship.mass = PLAYER_MASS + this.stack.totalMass;
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
