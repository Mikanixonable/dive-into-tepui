// マガジンベルトの給弾状態とたわみ物理を管理する。
import { Attitude } from '../../physics/attitude';
import { Vec3 } from '../../math/vec3';
import { BeltPhysics, BeltSection } from './belt-physics';
import type { DynamicMotion } from '../dynamic/dynamic-motion';
import type { BeltNodes } from '../../render/dynamic/player/belt-view';
import { MAG_ROUNDS } from './ammo-spec';

export class Belt {
  private readonly physics: BeltPhysics;
  private feed = 0;

  // たわみ物理を初期化する。owner は接触判定で自身の節点との接触を除外する吊り元の艦、
  // linkCount は鎖に並べる節点の数。
  public constructor(owner: DynamicMotion, linkCount: number) {
    this.physics = new BeltPhysics(linkCount, owner);
  }

  // 給弾進み(beltFeed)を弾薬状態から導出し、たわみ物理を進める。
  update(
    dt: number,
    roundsInMag: number,
    att: Attitude,
    thrustAccelVec: Vec3,
  ): void {
    const targetFeed = 1 - roundsInMag / MAG_ROUNDS;
    if (targetFeed < this.feed - 0.5) {
      this.physics.shiftBeltNodes();
      this.feed = targetFeed;
    } else {
      this.feed += (targetFeed - this.feed) * Math.min(1, dt * 12);
    }
    this.physics.update(dt, att, thrustAccelVec, this.feed);
  }

  // たわみ物理が解いた、機体座標系の節点配置。
  get nodes(): BeltNodes { return this.physics; }

  // 各リンクの体軸座標を ECI 絶対状態に変換し、衝突判定用の BeltSection として返す。
  contactSections(t: number, dt: number, baseR: Vec3, baseV: Vec3, att: Attitude): BeltSection[] {
    return this.physics.contactSections(t, dt, baseR, baseV, att);
  }

  // 衝突解決後の ECI 状態を体軸座標へ戻し、たわみ物理へ反映する。
  applyContactSections(dt: number, baseR: Vec3, baseV: Vec3, att: Attitude): void {
    this.physics.applyContactSections(dt, baseR, baseV, att);
  }
}
