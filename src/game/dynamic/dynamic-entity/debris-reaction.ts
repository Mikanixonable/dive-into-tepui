import type { WorldSfx } from '../../../audio/sfx/world-sfx';
import { kinematicState, type KinematicState } from '../../../physics/kinematic-state';
import type { Vec3 } from '../../../math/vec3';
import type { ContactGeometry } from '../../../physics/collision-response';
import type { SphereHit } from '../../../math/triangle-mesh';
import type { FlashEffects } from '../../vfx/flash-effects';
import type { DynamicMotion, DynamicMotionBehavior } from '../dynamic-motion';
import type { Contact } from './contact';
import type { DebrisKind } from './debris-kind';
import { bulletReactionOf } from './bullet-reaction';
import {
  casingEntityCollision, casingSphereCollision, casingSweptEntityCollision,
  casingSweptSphereCollision,
} from './casing-collision';

const BOOSTER_HARDWARE_LIFETIME = 2.4;
const CASING_LIFETIME = 1800;

export class DebrisReaction implements DynamicMotionBehavior {
  public get contactKind(): 'casing' | 'debris' {
    return this.kind === 'casing' ? 'casing' : 'debris';
  }

  public readonly testSphereCollision?: DynamicMotionBehavior['testSphereCollision'];
  public readonly testSweptSphereCollision?: DynamicMotionBehavior['testSweptSphereCollision'];
  public readonly testEntityCollision?: DynamicMotionBehavior['testEntityCollision'];
  public readonly testSweptEntityCollision?: DynamicMotionBehavior['testSweptEntityCollision'];

  public constructor(
    private readonly kind: DebrisKind['kind'],
    private readonly bornSim: number | null,
    private readonly worldSfx: WorldSfx,
    private readonly effects: FlashEffects,
  ) {
    if (kind !== 'casing') return;
    this.testSphereCollision = (
      self: DynamicMotion, sphereCenter: Vec3, sphereRadius: number, selfState: KinematicState,
    ): SphereHit | null => casingSphereCollision(self, sphereCenter, sphereRadius, selfState);
    this.testSweptSphereCollision = (
      self: DynamicMotion,
      previousSphereCenter: Vec3, sphereCenter: Vec3, sphereRadius: number,
      _previousSelfState: KinematicState, selfState: KinematicState,
    ): { readonly hit: SphereHit; readonly toi: number } | null => (
      casingSweptSphereCollision(self, previousSphereCenter, sphereCenter, sphereRadius, selfState)
    );
    this.testEntityCollision = (
      self: DynamicMotion, other: DynamicMotion,
      selfState: KinematicState, otherState: KinematicState,
    ): ContactGeometry | null => casingEntityCollision(self, other, selfState, otherState);
    this.testSweptEntityCollision = (
      self: DynamicMotion, other: DynamicMotion,
      previousSelfState: KinematicState, selfState: KinematicState,
      previousOtherState: KinematicState, otherState: KinematicState,
    ) => casingSweptEntityCollision(
      self, other, previousSelfState, selfState, previousOtherState, otherState,
    );
  }

  public onEntityContact(_self: DynamicMotion, other: DynamicMotion, contact: Contact): void {
    if (bulletReactionOf(other) !== null) {
      this.effects.spawnGasPuff(
        kinematicState<'eci'>(contact.selfState.t, contact.point, contact.selfState.v));
      return;
    }
    if (this.kind !== 'casing') return;
    if (other.contactKind === 'player') {
      this.worldSfx.clank();
      return;
    }
    if (other.contactKind === 'casing' && ownsCasingClank(contact)) this.worldSfx.clank();
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
    if (this.bornSim === null) return null;
    switch (this.kind) {
      case 'casing': return this.bornSim + CASING_LIFETIME;
      case 'boosterCover':
      case 'boosterBolt': return this.bornSim + BOOSTER_HARDWARE_LIFETIME;
      default: return null;
    }
  }
}

// 同じ接触を両当事者が受け取るため、法線の向きで一方だけを音の所有者にする。
function ownsCasingClank(contact: Contact): boolean {
  const { normal } = contact;
  if (normal.x !== 0) return normal.x > 0;
  if (normal.y !== 0) return normal.y > 0;
  if (normal.z !== 0) return normal.z > 0;
  const { selfState, otherState } = contact;
  if (selfState.r.x !== otherState.r.x) return selfState.r.x > otherState.r.x;
  if (selfState.r.y !== otherState.r.y) return selfState.r.y > otherState.r.y;
  return selfState.r.z > otherState.r.z;
}
