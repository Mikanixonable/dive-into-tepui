// 交戦圏の組み立て(SPEC/COMBAT.md「交戦圏」)。自機と基地のそれぞれを中心とする半径
// ENGAGEMENT_RANGE の球で、重なる球は1つの交戦圏にまとめる。戦闘が起こりうる範囲そのものを
// 表し、位置がその範囲に入るかと、その範囲の基準変位を答える。
import { Vec3, sub } from '../../math/vec3';
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
  const p = a.state.r, q = b.state.r;
  const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
  const reach = 2 * ENGAGEMENT_RANGE;
  return dx * dx + dy * dy + dz * dz <= reach * reach;
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
      const c = anchor.state.r;
      const dx = c.x - r.x, dy = c.y - r.y, dz = c.z - r.z;
      if (dx * dx + dy * dy + dz * dz <= ENGAGEMENT_RANGE * ENGAGEMENT_RANGE) return true;
    }
    return false;
  }
}

// 生存していて中心になる個体を、球が重なるものどうし連結成分にまとめて返す。交戦圏の並びと
// 各交戦圏の中心の並びは entities の並びを保つ。
// 中心が無いとき、および交戦できる倍率でないとき(canEngage が偽)は空。
export function engagementZones<E extends EngagementParticipant>(
  entities: readonly E[], canEngage: boolean,
): readonly EngagementZone<E>[] {
  if (!canEngage) return [];
  const anchors = entities.filter((e) => e.alive && e.engagementAnchor);

  // 重なる球を同じ成分番号へ寄せる。中心は数体なので総当たりで足りる。
  const component = anchors.map((_, i) => i);
  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      if (component[i] === component[j] || !overlaps(anchors[i]!, anchors[j]!)) continue;
      const merged = component[j]!, into = component[i]!;
      for (let k = 0; k < anchors.length; k++) {
        if (component[k] === merged) component[k] = into;
      }
    }
  }

  // 成分ごとに中心を集める。初めて現れた成分の位置が、そのまま交戦圏の並びになる。
  const zones: EngagementZone<E>[] = [];
  const membersOf = new Map<number, E[]>();
  for (let i = 0; i < anchors.length; i++) {
    const members = membersOf.get(component[i]!);
    if (members !== undefined) {
      members.push(anchors[i]!);
      continue;
    }
    const created = [anchors[i]!];
    membersOf.set(component[i]!, created);
    zones.push(new EngagementZone(created));
  }
  return zones;
}
