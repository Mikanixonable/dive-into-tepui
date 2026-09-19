// 本体に取り付いた付属物(放熱板の折り・ベルトの節点)の接触代理。物体どうしの接触の解決に本体と
// 別の剛体として加わり、状態は本体の側が reset で置き直す。
import { Q_IDENTITY } from '../../math/quat';
import { v3 } from '../../math/vec3';
import type { Attitude } from '../../physics/attitude';
import type { KinematicState } from '../../physics/kinematic-state';
import type { Contact } from './dynamic-entity/contact';
import type { ContactKind } from './dynamic-motion';
import type { DynamicReactionServices, EntityContactParticipant } from './dynamic-simulation-participant';

// 代理は固有の判定形状を持たないので、姿勢は接触の幾何に効かない。
const STILL_ATTITUDE: Attitude = { q: Q_IDENTITY, w: v3(), inertia: v3(1, 1, 1) };

// 代理が他の個体と接触したときの、本体の側のゲーム上の反応。
export type ContactProxyReaction = (
  other: EntityContactParticipant, contact: Contact, services: DynamicReactionServices,
) => void;

export class ContactProxy implements EntityContactParticipant {
  public readonly alive = true;
  public readonly collides = true;
  public readonly engagementAnchor = false;
  public readonly contactDamageWeight = 1;
  public readonly att = STILL_ATTITUDE;
  public readonly prevAtt = STILL_ATTITUDE;
  // いまの状態と、その前に置いた状態。本体の状態から置き直すキャッシュ。
  private current: KinematicState;
  private previous: KinematicState;

  // attachedTo に取り付いた、種別 contactKind・質量 contactMass [kg]・半径 radius [m] の代理を、生成
  // 時点の実際の状態 state に置く — 仮の状態で始めると、最初に置き直した区間を偽って掃引する。
  // onContact は他の個体と接触したときの反応で、null なら反応しない。
  public constructor(
    public readonly attachedTo: EntityContactParticipant,
    public readonly contactKind: ContactKind,
    public readonly contactMass: number,
    public readonly radius: number,
    state: KinematicState,
    private readonly onContact: ContactProxyReaction | null = null,
  ) {
    this.current = state;
    this.previous = state;
  }

  public get state(): KinematicState { return this.current; }
  public get prevState(): KinematicState { return this.previous; }

  // 状態を state へ置き直す。いまの状態は、接触の掃引が区間の始点に読む直前の状態になる。
  public reset(state: KinematicState): void {
    this.previous = this.current;
    this.current = state;
  }

  // 当たるのは、本体とその付属物のほかの個体。
  public contactsWith(other: EntityContactParticipant): boolean {
    return other !== this.attachedTo && other.attachedTo !== this.attachedTo;
  }

  public usesCustomSphereCollision(): boolean { return false; }
  public usesCustomEntityCollision(): boolean { return false; }
  public testCustomSphereCollision(): null { return null; }
  public testCustomSweptSphereCollision(): null { return null; }
  public testCustomEntityCollision(): null { return null; }
  public testCustomSweptEntityCollision(): null { return null; }

  public absorbHeat(): void {}

  // 他の個体との接触を本体の反応へ渡す。
  public collideWithEntity(
    other: EntityContactParticipant, contact: Contact, services: DynamicReactionServices,
  ): void {
    this.onContact?.(other, contact, services);
  }
}
