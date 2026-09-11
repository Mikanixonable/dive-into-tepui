import type { WorldSfx } from '../../../audio/sfx/world-sfx';
import { lenSq, sub, type Vec3 } from '../../../math/vec3';
import { ENGAGEMENT_RANGE } from '../engagement-zone';
import type { DynamicMotion, DynamicMotionBehavior } from '../dynamic-motion';
import type { DynamicReactionServices } from '../dynamic-simulation-participant';

// 自機の弾が自機に当たりはじめるまでの、発射からの猶予 [sim s]。
const SELF_CONTACT_GRACE = 2.0;
// 敵弾が視点の近くを通ったとみなす距離 [m]。
const BULLET_CLOSE_PASS_DIST = 40;

export type Shooter = 'player' | 'enemy';
export type BulletType = 'normal' | 'plasma';

// 弾1発の当たる相手・寿命・消滅の判定。
export class BulletReaction implements DynamicMotionBehavior {
  public readonly contactKind = 'bullet';
  private passedClose = false;

  public constructor(
    private readonly bornSim: number,
    private readonly lifetime: number,
    public readonly shooter: Shooter,
    public readonly type: BulletType,
    public readonly damage: number,
    private readonly worldSfx: WorldSfx,
  ) {}

  // other と当たるか。弾同士、敵弾と敵機、発射から猶予内の自機の弾と自機を除く。
  public contactsWith(_self: DynamicMotion, other: DynamicMotion, simTime: number): boolean {
    if (other.contactKind === 'bullet') return false;
    const ship = other.attachedTo ?? other;
    if (this.shooter === 'enemy' && ship.contactKind === 'enemy') return false;
    const ownShip = this.shooter === 'player' && ship.contactKind === 'player';
    return !ownShip || simTime - this.bornSim > SELF_CONTACT_GRACE;
  }

  // 何かに当たった弾は消える。
  public onEntityContact(self: DynamicMotion): void {
    self.alive = false;
  }

  // 寿命の尽きる時刻 [sim s]。simTime がそれを過ぎていれば null。
  public nextSimulationEventTime(_self: DynamicMotion, simTime: number): number | null {
    return this.expiresAt >= simTime ? this.expiresAt : null;
  }

  // 交戦範囲の外へ出たか寿命の尽きた弾を消す。敵のプラズマ弾が視点の近くを初めて通ると
  // 磁気干渉音を鳴らす。
  public checkLoss(
    self: DynamicMotion,
    _dt: number,
    simTime: number,
    _services: DynamicReactionServices,
    viewerPos: Vec3,
  ): void {
    if (!self.alive) return;
    if (this.shooter === 'enemy' && !this.passedClose
      && lenSq(sub(self.state.r, viewerPos)) < BULLET_CLOSE_PASS_DIST * BULLET_CLOSE_PASS_DIST) {
      this.passedClose = true;
      if (this.type === 'plasma') this.worldSfx.magneticInterference();
    }
    if (lenSq(sub(self.state.r, viewerPos)) > ENGAGEMENT_RANGE * ENGAGEMENT_RANGE
      || simTime >= this.expiresAt) self.alive = false;
  }

  // 寿命の尽きる時刻 [sim s]。
  private get expiresAt(): number {
    return this.bornSim + this.lifetime;
  }
}

// motion が弾なら、その反応。弾でなければ null。
export function bulletReactionOf(motion: DynamicMotion): BulletReaction | null {
  return motion.behavior instanceof BulletReaction ? motion.behavior : null;
}
