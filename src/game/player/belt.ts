// マガジンベルトの給弾状態とたわみ物理を管理する。
import { Attitude } from '../../physics/attitude';
import { Vec3 } from '../../math/vec3';
import { BeltPhysics, beltAnchor, type SerializedBeltPhysics } from './belt-physics';
import { MAG_ROUNDS } from './ammo-spec';
import type { ContactProxy } from '../dynamic/contact-proxy';
import type { EntityContactParticipant } from '../dynamic/dynamic-simulation-participant';

export interface SerializedBeltController {
  readonly feed: number;
  readonly physics: SerializedBeltPhysics;
}

export class BeltController {
  // physics は鎖のたわみ物理、feed は給弾進み(0..1)。
  public constructor(private readonly physics: BeltPhysics, private feed = 0) {}

  // linkCount 個の節点を鎖に並べて新しく作る。
  public static create(linkCount: number): BeltController {
    return new BeltController(BeltPhysics.create(linkCount));
  }

  // 直列化した給弾進みと鎖から復元する。
  public static deserialize(serialized: SerializedBeltController): BeltController {
    return new BeltController(BeltPhysics.deserialize(serialized.physics), serialized.feed);
  }

  // 給弾進みと鎖の直列化。
  public serialize(): SerializedBeltController {
    return { feed: this.feed, physics: this.physics.serialize() };
  }

  // 給弾進み(beltFeed)を弾薬状態から導出し、たわみ物理を進める。
  public update(
    dt: number,
    roundsInMag: number,
    att: Attitude,
    thrustAccelVec: Vec3,
  ): void {
    const targetFeed = 1 - roundsInMag / MAG_ROUNDS;
    // 次のマガジンに替わって給弾進みが巻き戻ったら、リンクを1つ詰める
    if (targetFeed < this.feed - 0.5) {
      this.physics.shiftBeltNodes();
      this.feed = targetFeed;
    } else {
      this.feed += (targetFeed - this.feed) * Math.min(1, dt * 12);
    }
    this.physics.update(dt, att, thrustAccelVec, this.feed);
  }

  // たわみ物理が解いた節点配置(いずれも機体座標系)。給弾口側の吊り元、吊り元から順に並ぶ
  // 各節の位置、各節のチェーン軸まわりのねじれ角 [rad]。
  public get anchor(): Vec3 { return beltAnchor(this.feed); }
  public get positions(): readonly Vec3[] { return this.physics.positions; }
  public get twists(): readonly number[] { return this.physics.twists; }

  // 各リンクの体軸座標を ECI 絶対状態に変換し、衝突判定用の接触代理として返す。owner は鎖を
  // 吊る艦で、接触判定で自身の節点との接触を除外する。
  public contactSections(
    owner: EntityContactParticipant, t: number, dt: number, baseR: Vec3, baseV: Vec3, att: Attitude,
  ): ContactProxy[] {
    return this.physics.contactSections(owner, t, dt, baseR, baseV, att);
  }

  // 衝突解決後の ECI 状態を体軸座標へ戻し、たわみ物理へ反映する。
  public applyContactSections(dt: number, baseR: Vec3, baseV: Vec3, att: Attitude): void {
    this.physics.applyContactSections(dt, baseR, baseV, att);
  }
}
