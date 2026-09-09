import type { WorldSfx } from '../../../audio/sfx/world-sfx';
import { lenSq, sub } from '../../../math/vec3';
import { ENGAGEMENT_RANGE } from '../engagement-zone';
import type {
  DynamicMotion,
  DynamicMotionBehavior,
  DynamicReactionServices,
} from '../dynamic-motion';

const SELF_CONTACT_GRACE = 2.0;
const BULLET_CLOSE_PASS_DIST = 40;

export type Shooter = 'player' | 'enemy';
export type BulletType = 'normal' | 'plasma';

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

  public contactsWith(_self: DynamicMotion, other: DynamicMotion, simTime: number): boolean {
    if (other.contactKind === 'bullet') return false;
    const ship = other.attachedTo ?? other;
    if (this.shooter === 'enemy' && ship.contactKind === 'enemy') return false;
    const ownShip = (this.shooter === 'player' && ship.contactKind === 'player')
      || (this.shooter === 'enemy' && ship.contactKind === 'enemy');
    return !ownShip || simTime - this.bornSim > SELF_CONTACT_GRACE;
  }

  public onEntityContact(self: DynamicMotion): void {
    self.alive = false;
  }

  public nextSimulationEventTime(_self: DynamicMotion, simTime: number): number | null {
    return this.expiresAt >= simTime ? this.expiresAt : null;
  }

  public checkLoss(
    self: DynamicMotion,
    _dt: number,
    simTime: number,
    _services: DynamicReactionServices,
    viewerPos: import('../../../math/vec3').Vec3,
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

  private get expiresAt(): number {
    return this.bornSim + this.lifetime;
  }
}

export function bulletReactionOf(motion: DynamicMotion): BulletReaction | null {
  return motion.behavior instanceof BulletReaction ? motion.behavior : null;
}
