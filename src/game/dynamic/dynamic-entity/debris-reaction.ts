// 破片1つの寿命と接触の振る舞い。薬莢だけは形のある当たり判定を持ち、船体や他の薬莢へ
// 触れたことを出来事として記録する。
import { kinematicState, type KinematicState } from '../../../physics/kinematic-state';
import type { Vec3 } from '../../../math/vec3';
import type { ContactGeometry } from '../../../physics/collision-response';
import type { SphereHit } from '../../../math/triangle-mesh';
import type { DynamicMotion, DynamicMotionBehavior } from '../dynamic-motion';
import type { DynamicReactionServices } from '../dynamic-simulation-participant';
import type { Contact } from './contact';
import type { DebrisKind } from './debris-kind';
import { bulletReactionOf } from './bullet-reaction';
import {
  casingEntityCollision, casingSphereCollision, casingSweptEntityCollision,
  casingSweptSphereCollision,
} from './casing-collision';

// 段間カバー・爆砕ボルトが残る時間 [sim s]。
const BOOSTER_HARDWARE_LIFETIME = 2.4;
// 薬莢が残る時間 [sim s]。
const CASING_LIFETIME = 1800;

export class DebrisReaction implements DynamicMotionBehavior {
  // 接触の相手が見る自分の種別。薬莢は船体・薬莢との接触を記録するので、他の破片と分ける。
  public get contactKind(): 'casing' | 'debris' {
    return this.kind === 'casing' ? 'casing' : 'debris';
  }

  public readonly testSphereCollision?: DynamicMotionBehavior['testSphereCollision'];
  public readonly testSweptSphereCollision?: DynamicMotionBehavior['testSweptSphereCollision'];
  public readonly testEntityCollision?: DynamicMotionBehavior['testEntityCollision'];
  public readonly testSweptEntityCollision?: DynamicMotionBehavior['testSweptEntityCollision'];

  // bornSim が null の破片は寿命で消えない。薬莢のときだけ、円筒の形に沿った当たり判定を
  // 備える — 判定の有無そのものが個体差なので、メソッドではなくフィールドで持たせる。
  public constructor(
    private readonly kind: DebrisKind['kind'],
    private readonly bornSim: number | null,
  ) {
    if (kind !== 'casing') return;
    this.testSphereCollision = (
      self: DynamicMotion, sphereCenter: Vec3, sphereRadius: number, selfState: KinematicState, selfAttitude,
    ): SphereHit | null => casingSphereCollision(self, sphereCenter, sphereRadius, selfState, selfAttitude);
    this.testSweptSphereCollision = (
      self: DynamicMotion,
      previousSphereCenter: Vec3, sphereCenter: Vec3, sphereRadius: number,
      previousSelfState: KinematicState, selfState: KinematicState, previousSelfAttitude, selfAttitude,
    ): { readonly hit: SphereHit; readonly toi: number } | null => (
      casingSweptSphereCollision(
        self, previousSphereCenter, sphereCenter, sphereRadius,
        previousSelfState, selfState, previousSelfAttitude, selfAttitude,
      )
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

  // 弾が当たったこと、薬莢が船体か他の薬莢へ当たったことを出来事として記録する。
  public onEntityContact(
    _self: DynamicMotion, other: DynamicMotion, contact: Contact, services: DynamicReactionServices,
  ): void {
    if (bulletReactionOf(other) !== null) {
      services.registry.events.record({
        kind: 'debrisStruckByBullet',
        state: kinematicState<'eci'>(contact.selfState.t, contact.point, contact.selfState.v),
      });
      return;
    }
    // 薬莢は船体・他の薬莢への接触も記録する。薬莢どうしは同じ接触を両当事者が受け取るので、
    // 片側だけを記録の所有者にする。
    if (this.kind !== 'casing') return;
    if (other.contactKind === 'player') {
      services.registry.events.record({ kind: 'casingContacted' });
      return;
    }
    if (other.contactKind === 'casing' && ownsCasingContact(contact)) {
      services.registry.events.record({ kind: 'casingContacted' });
    }
  }

  // 寿命の尽きる時刻 [sim s]。寿命を持たない、または simTime が過ぎていれば null。
  public nextSimulationEventTime(_self: DynamicMotion, simTime: number): number | null {
    const expiresAt = this.expiresAt;
    return expiresAt !== null && expiresAt >= simTime ? expiresAt : null;
  }

  // 寿命の尽きた破片を消す。
  public checkLoss(self: DynamicMotion, _dt: number, simTime: number): void {
    const expiresAt = this.expiresAt;
    if (expiresAt !== null && simTime >= expiresAt) self.alive = false;
  }

  // 寿命の尽きる時刻 [sim s]。寿命を持たない種別では null。
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

// 同じ接触を両当事者が受け取るため、法線の向きで一方だけを出来事の所有者にする。
function ownsCasingContact(contact: Contact): boolean {
  const { normal } = contact;
  if (normal.x !== 0) return normal.x > 0;
  if (normal.y !== 0) return normal.y > 0;
  if (normal.z !== 0) return normal.z > 0;
  const { selfState, otherState } = contact;
  if (selfState.r.x !== otherState.r.x) return selfState.r.x > otherState.r.x;
  if (selfState.r.y !== otherState.r.y) return selfState.r.y > otherState.r.y;
  return selfState.r.z > otherState.r.z;
}
