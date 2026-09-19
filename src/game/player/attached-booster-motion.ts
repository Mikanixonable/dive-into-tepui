import { LOCAL_FORWARD, qRotate } from '../../math/quat';
import { scale, type Vec3 } from '../../math/vec3';
import {
  boosterAverageAcceleration,
  type BoosterStack,
  type SerializedBoosterStack,
  type BoosterStage,
} from './booster-stack';
import type { Attitude } from '../../physics/attitude';

// 接続中ブースターを積み、その寄与で質量と慣性を組み直す機体の面。
export interface BoosterHostMotion {
  readonly mass: number;
  readonly att: Attitude;
  rebuildMassAndInertia(boosterMass: number, boosterStageCount: number): void;
}

// 接続中ブースターの段、燃料、推力を管理し、段を変えるたびに寄与を機体の質量・慣性へ反映させる。
export class AttachedBoosterMotion {
  // 直近の区間の推力と燃焼率。段を燃やすたびに求め直すキャッシュ。
  private thrustValue: Vec3 | null = null;
  private burnRatioValue = 0;

  // ship に積んだ段 stack を持つ。構築時点の段の寄与は、ship が自分の質量・慣性へ入れておく。
  public constructor(private readonly ship: BoosterHostMotion, private readonly stack: BoosterStack) {}

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
    this.ship.rebuildMassAndInertia(this.stack.totalMass, this.stack.stages.length);
  }

  // 最後尾段の点火状態を反転し、操作後の点火状態を返す。
  public toggleIgnition(): boolean {
    return this.stack.toggleIgnition();
  }

  // 最後尾段を物理状態から外し、外した段を返す。段が無ければ null。
  public detachOutermost(): BoosterStage | null {
    const stage = this.stack.detachOutermost();
    if (stage === null) return null;
    this.ship.rebuildMassAndInertia(this.stack.totalMass, this.stack.stages.length);
    this.clearThrust();
    return stage;
  }

  // simDt 秒ぶん燃焼させ、区間平均の加速度を求める。
  public step(simDt: number): void {
    const massBefore = this.ship.mass;
    const burn = this.stack.step(simDt);
    this.ship.rebuildMassAndInertia(this.stack.totalMass, this.stack.stages.length);
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

  // 段スタックの直列化。
  public serialize(): SerializedBoosterStack {
    return this.stack.serialize();
  }
}
