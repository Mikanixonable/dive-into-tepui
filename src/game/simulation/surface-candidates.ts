// 表面へ触れうる天体の絞り込み。区間を共有する参加者全員を覆う一覧を1回だけ組み、個体ごとには
// その短い一覧へ安価な距離判定を掛ける。**絞り込みは判定器の答えを変えない** — 触れうる相手を
// 1つも落とさないことだけが正しさの条件で、通す数が多いぶんには構わない。除外の根拠は距離と
// 区間変位という物理量だけで、種別や時間加速倍率は見ない。
import { Attractor, attractorStateAt } from '../../physics/attractor';
import { KinematicState } from '../../physics/kinematic-state';
import { Vec3, add, len, scale, sub, v3 } from '../../physics/vec3';

// 区間の始点位置と、そこから表面が区間内に届きうる距離。
type BodyReach = {
  readonly body: Attractor;
  readonly r0: Vec3;
  readonly reach: number;
};

// 三次曲線が弦から離れうる距離の上限 [m]。Bezier の制御点は弦上の対応点から高々この距離しか
// 離れず、Bernstein 基底が単位分割なので曲線全体がその内側に収まる。掃引が解くのはこの曲線
// なので、弦だけで測ると通過を落としうる。
function chordDeviationBound(start: KinematicState, end: KinematicState): number {
  const dt = end.t - start.t;
  const chord = sub(end.r, start.r);
  return Math.max(len(sub(scale(start.v, dt), chord)), len(sub(chord, scale(end.v, dt)))) / 3;
}

// 区間 [prevState, state] を渡る間に、この状態の中心が始点からどれだけ離れうるか [m]。
function intervalReach(prev: KinematicState, next: KinematicState): number {
  return len(sub(next.r, prev.r)) + chordDeviationBound(prev, next);
}

// 絞り込みの参加者。区間の両端の状態と接触半径を持つ。
export type SurfaceParticipant = {
  readonly prevState: KinematicState;
  readonly state: KinematicState;
  readonly radius: number;
};

export class SurfaceCandidates {
  // 直前の reset で選ばれた、この区間で誰かが触れうる天体。
  private readonly reachable: BodyReach[] = [];

  // 直近の reset が選んだ天体の数。
  get count(): number { return this.reachable.length; }

  // 区間を共有する参加者全員に対し、この区間で誰かが触れうる天体を選び直す。参加者の区間が
  // 少しずつずれていても落とさないよう、天体の変位は全参加者の区間の合併で見る。
  reset(participants: readonly SurfaceParticipant[], bodies: readonly Attractor[]): void {
    this.reachable.length = 0;
    if (participants.length === 0) return;

    // 参加者全体を覆う球の中心と、そこから表面が届きうる最大距離。
    let sum = v3();
    for (const p of participants) sum = add(sum, p.prevState.r);
    const center = scale(sum, 1 / participants.length);
    let margin = 0;
    let tStart = Infinity;
    let tEnd = -Infinity;
    for (const p of participants) {
      margin = Math.max(margin, len(sub(p.prevState.r, center)) + p.radius + intervalReach(p.prevState, p.state));
      tStart = Math.min(tStart, p.prevState.t);
      tEnd = Math.max(tEnd, p.state.t);
    }
    if (!(tStart <= tEnd)) return;

    for (const body of bodies) {
      const start = attractorStateAt(body, tStart);
      const reach = body.radius + intervalReach(start, attractorStateAt(body, tEnd));
      if (len(sub(center, start.r)) <= margin + reach) {
        this.reachable.push({ body, r0: start.r, reach });
      }
    }
  }

  // 参加者1つが区間内に触れうる天体だけを out へ書く。out は呼び出し側が所有する。
  into(participant: SurfaceParticipant, out: Attractor[]): Attractor[] {
    out.length = 0;
    const { prevState } = participant;
    const reach = participant.radius + intervalReach(prevState, participant.state);
    for (const candidate of this.reachable) {
      const dx = prevState.r.x - candidate.r0.x;
      const dy = prevState.r.y - candidate.r0.y;
      const dz = prevState.r.z - candidate.r0.z;
      const limit = reach + candidate.reach;
      if (dx * dx + dy * dy + dz * dz <= limit * limit) out.push(candidate.body);
    }
    return out;
  }
}
