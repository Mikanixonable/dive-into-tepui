import { distSq, type Vec3 } from '../../../math/vec3';
import type { EngagementParticipant, EngagementZone } from '../engagement-zone';
import { DynamicMotion, type DynamicMotionBehavior } from '../dynamic-motion';
import type { DynamicReactionServices, EntityContactParticipant } from '../dynamic-simulation-participant';

// 自機の弾が自機に当たりはじめるまでの、発射からの猶予 [sim s]。
const SELF_CONTACT_GRACE = 2.0;
// 敵弾が交戦圏の中心(自機・基地)の近くを通ったとみなす距離 [m]。
const BULLET_CLOSE_PASS_DIST = 40;

// 位置 r [m, ECI] が、いずれかの交戦圏の中心から BULLET_CLOSE_PASS_DIST 未満にあるか。
function nearAnyAnchor(r: Vec3, zones: readonly EngagementZone<EngagementParticipant>[]): boolean {
  const closeSq = BULLET_CLOSE_PASS_DIST * BULLET_CLOSE_PASS_DIST;
  return zones.some((zone) => zone.anchors.some((anchor) => distSq(anchor.state.r, r) < closeSq));
}

export type Shooter = 'player' | 'enemy';
export type BulletType = 'normal' | 'plasma';

// 弾1発の発射時刻・寿命・撃ち手・弾種・ダメージと、敵弾が交戦圏の中心の近くを通ったか。
export interface SerializedBulletReaction {
  readonly bornSim: number;
  readonly lifetime: number;
  readonly shooter: Shooter;
  readonly type: BulletType;
  readonly damage: number;
  readonly passedClose: boolean;
}

// 弾1発の当たる相手・寿命・消滅の判定。
export class BulletReaction implements DynamicMotionBehavior {
  public readonly contactKind = 'bullet';

  // bornSim [sim s] に撃たれ lifetime [sim s] だけ飛ぶ弾。damage は命中した相手へ与えるダメージ
  // [HP]、passedClose は交戦圏の中心の近くを通ったことを記録済みか。
  public constructor(
    private readonly bornSim: number,
    private readonly lifetime: number,
    public readonly shooter: Shooter,
    public readonly type: BulletType,
    public readonly damage: number,
    private passedClose = false,
  ) {}

  // 直列化した形から復元する。
  public static deserialize(serialized: SerializedBulletReaction): BulletReaction {
    const { bornSim, lifetime, shooter, type, damage, passedClose } = serialized;
    return new BulletReaction(bornSim, lifetime, shooter, type, damage, passedClose);
  }

  // 直列化した形へ変換する。
  public serialize(): SerializedBulletReaction {
    return {
      bornSim: this.bornSim,
      lifetime: this.lifetime,
      shooter: this.shooter,
      type: this.type,
      damage: this.damage,
      passedClose: this.passedClose,
    };
  }

  // other と当たるか。弾同士、敵弾と敵機、発射から猶予内の自機の弾と自機を除く。
  public contactsWith(_self: DynamicMotion, other: EntityContactParticipant, simTime: number): boolean {
    if (other.contactKind === 'bullet') return false;
    const ship = other.attachedTo ?? other;
    if (this.shooter === 'enemy' && ship.contactKind === 'enemy') return false;
    const ownShip = this.shooter === 'player' && ship.contactKind === 'player';
    return !ownShip || simTime - this.bornSim > SELF_CONTACT_GRACE;
  }

  // 何かに当たった弾は消える。
  public onEntityContact(self: DynamicMotion): void {
    self.kill();
  }

  // 寿命の尽きる時刻 [sim s]。simTime がそれを過ぎていれば null。
  public nextSimulationEventTime(_self: DynamicMotion, simTime: number): number | null {
    return this.expiresAt >= simTime ? this.expiresAt : null;
  }

  // 交戦圏 zones の外へ出たか寿命の尽きた弾を消す。zones が空なら寿命だけで消す。敵のプラズマ弾が
  // 交戦圏の中心の近くを初めて通り過ぎたことは、その場で記録する。
  public checkLoss(
    self: DynamicMotion,
    _dt: number,
    simTime: number,
    services: DynamicReactionServices,
    zones: readonly EngagementZone<EngagementParticipant>[],
  ): void {
    if (!self.alive) return;
    if (this.shooter === 'enemy' && !this.passedClose && nearAnyAnchor(self.state.r, zones)) {
      this.passedClose = true;
      if (this.type === 'plasma') services.registry.events.record({ kind: 'plasmaPassedClose' });
    }
    const outsideZones = zones.length > 0 && !zones.some((zone) => zone.contains(self.state.r));
    if (outsideZones || simTime >= this.expiresAt) self.kill();
  }

  // 寿命の尽きる時刻 [sim s]。
  private get expiresAt(): number {
    return this.bornSim + this.lifetime;
  }
}

// 接触の相手 participant が弾なら、その反応。弾でなければ null。
export function bulletReactionOf(participant: EntityContactParticipant): BulletReaction | null {
  return participant instanceof DynamicMotion && participant.behavior instanceof BulletReaction
    ? participant.behavior : null;
}
