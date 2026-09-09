import type { WorldSfx } from '../../../audio/sfx/world-sfx';
import { kinematicState } from '../../../physics/kinematic-state';
import type { FlashEffects } from '../../vfx/flash-effects';
import type { DynamicMotion, DynamicMotionBehavior } from '../dynamic-motion';
import type { Contact } from './contact';
import type { DebrisKind } from './debris-motion';
import { bulletReactionOf } from './bullet-reaction';

const BOOSTER_HARDWARE_LIFETIME = 2.4;
const CASING_LIFETIME = 1800;

export class DebrisReaction implements DynamicMotionBehavior {
  public readonly contactKind = 'debris';

  public constructor(
    private readonly debrisKind: DebrisKind,
    private readonly worldSfx: WorldSfx,
    private readonly effects: FlashEffects,
  ) {}

  public onEntityContact(_self: DynamicMotion, other: DynamicMotion, contact: Contact): void {
    if (bulletReactionOf(other) !== null) {
      this.effects.spawnGasPuff(
        kinematicState<'eci'>(contact.selfState.t, contact.point, contact.selfState.v));
      return;
    }
    if (this.debrisKind.kind === 'casing' && other.contactKind === 'player') this.worldSfx.clank();
  }

  public nextSimulationEventTime(_self: DynamicMotion, simTime: number): number | null {
    const expiresAt = this.expiresAt;
    return expiresAt !== null && expiresAt >= simTime ? expiresAt : null;
  }

  public checkLoss(self: DynamicMotion, _dt: number, simTime: number): void {
    const expiresAt = this.expiresAt;
    if (expiresAt !== null && simTime >= expiresAt) self.alive = false;
  }

  private get expiresAt(): number | null {
    switch (this.debrisKind.kind) {
      case 'casing': return this.debrisKind.bornSim + CASING_LIFETIME;
      case 'boosterCover':
      case 'boosterBolt': return this.debrisKind.bornSim + BOOSTER_HARDWARE_LIFETIME;
      default: return null;
    }
  }
}
