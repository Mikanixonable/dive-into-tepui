// マガジンベルトの給弾状態とたわみ物理を管理する。表示メッシュは BeltView が所有する。
import { Attitude } from '../../physics/attitude';
import { Vec3 } from '../../math/vec3';
import { BeltPhysics, BeltSection } from './belt-physics';
import type { DynamicMotion } from '../dynamic/dynamic-motion';
import { MAG_ROUNDS } from './ammo-spec';

export const BELT_MAX_VISIBLE = 18; // ベルト描画の最大リンク数

export class Belt {
  private readonly physics: BeltPhysics;
  private feed = 0;

  // たわみ物理を初期化する。owner は接触判定で自身の節点との接触を除外する吊り元の艦。
  public constructor(owner: DynamicMotion) {
    this.physics = new BeltPhysics(BELT_MAX_VISIBLE, owner);
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

  // View が各リンクの位置・向きを同期するために、物理状態を読み取り専用で公開する。
  get viewState(): BeltPhysics { return this.physics; }

  // 各リンクの体軸座標を ECI 絶対状態に変換し、衝突判定用の BeltSection として返す。
  contactSections(t: number, dt: number, baseR: Vec3, baseV: Vec3, att: Attitude): BeltSection[] {
    return this.physics.contactSections(t, dt, baseR, baseV, att);
  }

  // 衝突解決後の ECI 状態を体軸座標へ戻し、たわみ物理へ反映する。
  applyContactSections(dt: number, baseR: Vec3, baseV: Vec3, att: Attitude): void {
    this.physics.applyContactSections(dt, baseR, baseV, att);
  }
}
