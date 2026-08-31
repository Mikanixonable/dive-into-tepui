// 表面へ触れうる天体の絞り込み。**絞り込みは判定器の答えを変えない** — 触れうる相手を
// 1つも落とさないことだけが正しさの条件で、通す数が多いぶんには構わない。除外の根拠は距離と
// 区間変位という物理量だけで、種別や時間加速倍率は見ない。
//
// 二段構えで、段ごとに何に依存するかが違う。
//  1. resetSpan — 区間だけで決まる。各天体の表面がその区間のあいだに届きうる範囲を求める。
//     **部分区間の到達範囲はこの範囲に含まれる**ので、区間を内側でさらに割って解く個体も、
//     組み直さずにそのまま使える。
//  2. narrow — 参加者の顔ぶれで決まる。区間を共有する多数を同じ窓で解くときだけ得になる
//     (参加者が1つなら into と同じ判定を二度やることになる)。
import { CelestialMotion } from '../../physics/celestial-motion';
import { KinematicState } from '../../physics/kinematic-state';
import { Vec3, add, len, scale, sub, v3 } from '../../math/vec3';

// 区間の始点位置と、そこから表面が区間内に届きうる距離。
type BodyReach = {
  readonly body: CelestialMotion;
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
  // 区間 [tStart, tEnd] のあいだに各天体の表面が届きうる範囲。
  private readonly spanning: BodyReach[] = [];
  // そのうち、いま into が選び先とする一覧。narrow を掛けるまでは spanning と同じ顔ぶれ。
  private readonly reachable: BodyReach[] = [];

  // into が選び先とする天体の数。
  get count(): number { return this.reachable.length; }

  // 区間 [tStart, tEnd] のあいだに各天体の表面が届きうる範囲を求める。以降の into と narrow は
  // この上で答えるので、区間の内側をさらに細かく割って解く個体も組み直しを要さない。
  resetSpan(
    bodies: readonly CelestialMotion[], pivot: number, tStart: number, tEnd: number,
  ): void {
    this.spanning.length = 0;
    this.reachable.length = 0;
    if (!(tStart <= tEnd)) return;
    for (const body of bodies) {
      const start = body.stateAt(pivot, tStart);
      const reach = body.def.radius + intervalReach(start, body.stateAt(pivot, tEnd));
      this.spanning.push({ body, r0: start.r, reach });
    }
    for (const candidate of this.spanning) this.reachable.push(candidate);
  }

  // into の選び先を、この顔ぶれの誰かが触れうる天体だけへ狭める。狭めた結果は次の resetSpan
  // まで残るので、**区間を共有する参加者へ続けて into を掛けるあいだにだけ掛ける。**
  narrow(participants: readonly SurfaceParticipant[]): void {
    this.reachable.length = 0;
    if (participants.length === 0) return;

    // 参加者全体を覆う球の中心と、そこから表面が届きうる最大距離。into が個体ごとに測る
    // 距離はこの margin を超えないので、ここで落とした天体が into を通ることはない。
    let sum = v3();
    for (const p of participants) sum = add(sum, p.prevState.r);
    const center = scale(sum, 1 / participants.length);
    let margin = 0;
    for (const p of participants) {
      margin = Math.max(margin, len(sub(p.prevState.r, center)) + p.radius + intervalReach(p.prevState, p.state));
    }
    for (const candidate of this.spanning) {
      if (len(sub(center, candidate.r0)) <= margin + candidate.reach) this.reachable.push(candidate);
    }
  }

  // 参加者1つが区間内に触れうる天体だけを out へ書く。out は呼び出し側が所有する。
  into(participant: SurfaceParticipant, out: CelestialMotion[]): CelestialMotion[] {
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
