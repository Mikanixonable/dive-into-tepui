// 破片1つの寿命と接触の振る舞い。弾が当たったことを出来事として記録する。薬莢は円筒の当たり
// 判定を持ち、自機や他の薬莢へ触れたことも記録する。
import { kinematicState, type KinematicState } from '../../../physics/kinematic-state';
import { add, addScaled, scale, sub, type Vec3 } from '../../../math/vec3';
import { qRotate } from '../../../math/quat';
import type { ContactGeometry } from '../../../physics/collision-response';
import type { SphereHit } from '../../../math/triangle-mesh';
import type { DynamicMotion, DynamicMotionBehavior } from '../dynamic-motion';
import type { DynamicReactionServices, EntityContactParticipant } from '../dynamic-simulation-participant';
import type { Contact } from './contact';
import type { DebrisKind, DebrisSlide } from './debris-kind';
import { bulletReactionOf } from './bullet-reaction';
import {
  casingEntityCollision, casingSphereCollision, casingSweptEntityCollision,
  casingSweptSphereCollision,
} from './casing-collision';

const CASING_LIFETIME = 1800;

export class DebrisReaction implements DynamicMotionBehavior {
  // 接触の相手が見る自分の種別。薬莢は自機・薬莢との接触を記録するので、他の破片と分ける。
  public get contactKind(): 'casing' | 'debris' {
    return this.kind === 'casing' ? 'casing' : 'debris';
  }

  public readonly testSphereCollision?: DynamicMotionBehavior['testSphereCollision'];
  public readonly testSweptSphereCollision?: DynamicMotionBehavior['testSweptSphereCollision'];
  public readonly testEntityCollision?: DynamicMotionBehavior['testEntityCollision'];
  public readonly testSweptEntityCollision?: DynamicMotionBehavior['testSweptEntityCollision'];

  // 排出経路のある破片は、終端へ達するまで機体座標系の滑りに沿って進む。
  private slide: DebrisSlide | null;

  // bornSim が null の破片は寿命で消えない。薬莢は円筒の形に沿った当たり判定を備える — 判定の
  // 有無が個体差なので、メソッドでなくフィールドで持つ。
  public constructor(
    private readonly kind: DebrisKind['kind'],
    private readonly bornSim: number | null,
    slide: DebrisSlide | null = null,
  ) {
    this.slide = slide;
    if (kind !== 'casing') return;
    // 球との接触(静止・掃引)
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
    // 薬莢どうしの接触(静止・掃引)
    this.testEntityCollision = (
      self: DynamicMotion, other: EntityContactParticipant,
      selfState: KinematicState, otherState: KinematicState,
    ): ContactGeometry | null => casingEntityCollision(self, other, selfState, otherState);
    this.testSweptEntityCollision = (
      self: DynamicMotion, other: EntityContactParticipant,
      previousSelfState: KinematicState, selfState: KinematicState,
      previousOtherState: KinematicState, otherState: KinematicState,
    ) => casingSweptEntityCollision(
      self, other, previousSelfState, selfState, previousOtherState, otherState,
    );
  }

  // 排出経路のある破片を経路に沿って進める。経路は生まれた時点の等速の機体座標系で from→to を
  // なぞり、終端へ達したら以後は自由な破片になる。
  public updateCommands(self: DynamicMotion, _simDt: number): void {
    const slide = this.slide;
    if (slide === null) return;
    const elapsed = self.state.t - slide.bornSim;
    // 終端へ達した破片は座標拘束を解いて自由飛行へ戻す。
    if (elapsed >= slide.duration) {
      this.slide = null;
      return;
    }
    const frac = Math.max(0, elapsed / slide.duration);
    const body = addScaled(slide.from, sub(slide.to, slide.from), frac);
    // 出生時の等速機体座標系から位置と滑り速度を組み直す。
    self.reset(kinematicState(
      self.state.t,
      add(add(slide.r0, scale(slide.v0, elapsed)), qRotate(slide.q0, body)),
      add(slide.v0, qRotate(slide.q0, scale(sub(slide.to, slide.from), 1 / slide.duration))),
    ));
  }

  // 排出経路に沿っているあいだは機体の壁を抜けて出るので、どの相手とも接触させない。
  public contactsWith(_self: DynamicMotion, _other: EntityContactParticipant, _simTime: number): boolean {
    return this.slide === null;
  }

  // 弾が当たったこと、薬莢が自機か他の薬莢へ当たったことを出来事として記録する。
  public onEntityContact(
    _self: DynamicMotion, other: EntityContactParticipant, contact: Contact, services: DynamicReactionServices,
  ): void {
    if (bulletReactionOf(other) !== null) {
      services.registry.events.record({
        kind: 'debrisStruckByBullet',
        state: kinematicState<'eci'>(contact.selfState.t, contact.point, contact.selfState.v),
      });
      return;
    }
    // 薬莢は自機・他の薬莢への接触も記録する
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
    if (expiresAt !== null && simTime >= expiresAt) self.kill();
  }

  // 寿命の尽きる時刻 [sim s]。寿命を持たない種別では null。
  private get expiresAt(): number | null {
    if (this.bornSim === null) return null;
    switch (this.kind) {
      case 'casing': return this.bornSim + CASING_LIFETIME;
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
