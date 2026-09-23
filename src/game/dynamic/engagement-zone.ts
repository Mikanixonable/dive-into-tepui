// 交戦圏の組み立て(SPEC/COMBAT.md「交戦圏」)。自機と基地のそれぞれを中心とする半径
// ENGAGEMENT_RANGE の球で、重なる球は1つの交戦圏にまとめる。戦闘が起こりうる範囲そのものを
// 表し、位置がその範囲に入るかの内外判定と、その範囲の基準変位を算出・提供する。
import { Vec3, sub, distSq } from '../../math/vec3';
import type { KinematicState } from '../../physics/kinematic-state';

// 交戦圏の半径 [m]。中心(自機・基地)からこの距離までが、敵の射撃・弾の飛翔・物体どうしの
// 接触の範囲。
export const ENGAGEMENT_RANGE = 30e3;

// 交戦圏が読む個体の側面。中心になる個体も、所属を問われる個体もこれで足りる。
export interface EngagementParticipant {
  readonly alive: boolean;
  readonly engagementAnchor: boolean;
  readonly state: KinematicState;
  readonly prevState: KinematicState;
}

// 2つの中心の球が重なるか(中心間距離が半径の2倍以内)。
function overlaps(a: EngagementParticipant, b: EngagementParticipant): boolean {
  const reach = 2 * ENGAGEMENT_RANGE;
  return distSq(a.state.r, b.state.r) <= reach * reach;
}

// 中心の球が連結した1つの交戦圏。
export class EngagementZone<E extends EngagementParticipant> {
  // anchors はこの交戦圏の中心になる個体で、渡された並びを保つ。先頭が基準変位の持ち主。
  public constructor(public readonly anchors: readonly E[]) { }

  // この区間の基準変位 [m](先頭の中心の state.r − prevState.r)。到達量はこれとの差で測る。
  public get referenceDisplacement(): Vec3 {
    const head = this.anchors[0]!;
    return sub(head.state.r, head.prevState.r);
  }

  // 位置 r [m, ECI] がこの交戦圏に入るか(いずれかの中心から ENGAGEMENT_RANGE 以内)。
  public contains(r: Vec3): boolean {
    for (const anchor of this.anchors) {
      if (distSq(anchor.state.r, r) <= ENGAGEMENT_RANGE * ENGAGEMENT_RANGE) return true;
    }
    return false;
  }
}

// サブステップごとに交戦圏を組む hot path 用の再利用ビルダ。
// build() の返り値と各 zone/anchors は次の build() で上書きされるため、その場で使い切る。
export class EngagementZoneBuilder<E extends EngagementParticipant> {
  private readonly anchors: E[] = [];
  private readonly component: number[] = [];
  private readonly componentToZone: number[] = [];
  private readonly memberPool: E[][] = [];
  private readonly zonePool: EngagementZone<E>[] = [];
  private readonly activeZones: EngagementZone<E>[] = [];

  // 生存していて中心になる個体を、球が重なるものどうし連結成分にまとめる。
  // 交戦圏と各中心の並びは entities の並びを保つ。
  public build(entities: readonly E[], canEngage: boolean): readonly EngagementZone<E>[] {
    this.activeZones.length = 0;
    this.anchors.length = 0;
    this.component.length = 0;
    this.componentToZone.length = 0;
    if (!canEngage) return this.activeZones;

    for (const entity of entities) {
      if (entity.alive && entity.engagementAnchor) this.anchors.push(entity);
    }
    const count = this.anchors.length;
    if (count === 0) return this.activeZones;

    // 重なる球を同じ成分番号へ寄せる。中心は数体なので総当たりで足りる。
    this.component.length = count;
    for (let i = 0; i < count; i++) this.component[i] = i;
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        if (this.component[i] === this.component[j] || !overlaps(this.anchors[i]!, this.anchors[j]!)) continue;
        const merged = this.component[j]!, into = this.component[i]!;
        for (let k = 0; k < count; k++) {
          if (this.component[k] === merged) this.component[k] = into;
        }
      }
    }

    // Map を毎回作らず、成分番号(0..count-1)を直接 zone index へ写す。
    this.componentToZone.length = count;
    this.componentToZone.fill(-1);
    let zoneCount = 0;
    for (let i = 0; i < count; i++) {
      const component = this.component[i]!;
      let zoneIndex = this.componentToZone[component]!;
      if (zoneIndex < 0) {
        zoneIndex = zoneCount++;
        this.componentToZone[component] = zoneIndex;
        let members = this.memberPool[zoneIndex];
        if (members === undefined) {
          members = [];
          this.memberPool.push(members);
          this.zonePool.push(new EngagementZone(members));
        } else {
          members.length = 0;
        }
        this.activeZones.push(this.zonePool[zoneIndex]!);
      }
      this.memberPool[zoneIndex]!.push(this.anchors[i]!);
    }
    return this.activeZones;
  }
}

// 単発利用向けの互換入口。Simulator のように毎サブステップ呼ぶ側は EngagementZoneBuilder を保持して
// build() を繰り返し、作業配列と zone 実体を使い回す。
export function engagementZones<E extends EngagementParticipant>(
  entities: readonly E[], canEngage: boolean,
): readonly EngagementZone<E>[] {
  return new EngagementZoneBuilder<E>().build(entities, canEngage);
}
