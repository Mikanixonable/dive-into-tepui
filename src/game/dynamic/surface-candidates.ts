// 表面へ触れうる天体の絞り込み。**絞り込みは判定器の答えを変えない** — 触れうる相手を
// 1つも落とさないことだけが正しさの条件で、通す数が多いぶんには構わない。除外の根拠は距離と
// 区間変位という物理量だけで、種別や時間加速倍率は見ない。
//
// 二段構えで、段ごとに何に依存するかが違う。
//  1. resetSpan — 区間だけで決まる。各天体の表面がその区間のあいだに届きうる範囲を求める。
//     **部分区間の到達範囲はこの範囲に含まれる**ので、区間を内側でさらに細分化して衝突処理する個体も、
//     組み直さずにそのまま使える。
//  2. narrow — 参加者の構成で決まる。区間を共有する多数を同じ時間枠で衝突処理するときだけ得になる
//     (参加者が1つなら into と同じ判定を二度やることになる)。
import { KinematicState } from '../../physics/kinematic-state';
import { Vec3, add, distSq, len, scale, sub, v3 } from '../../math/vec3';
import type { CelestialBody } from '../../physics/celestial-body';

// 区間の始点位置と、そこから表面が区間内に届きうる距離。
type BodyReach = {
  readonly body: CelestialBody;
  readonly r0: Vec3;
  readonly reach: number;
};

// 三次曲線が弦から離れうる距離の上限 [m]。Bezier の制御点は弦上の対応点から高々この距離しか
// 離れず、Bernstein 基底が単位分割なので曲線全体がその内側に収まる。掃引判定が対象とするのはこの曲線
// なので、弦だけで測ると通過判定を見落とす恐れがある。
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
  // そのうち、現在 into の抽出対象とする候補一覧。narrow を適用するまでは spanning と同じ要素構成。
  private readonly reachable: BodyReach[] = [];

  // into が選び先とする天体の数。
  get count(): number { return this.reachable.length; }

  // 区間 [tStart, tEnd] のあいだに各天体の表面が届きうる範囲を求める。以降の into と narrow は
  // この上で判定するため、区間の内側をさらに細かく分割して判定する個体も再構築が不要。
  // reachMargin は掃引ぶんに掛ける倍率で、1 が掃引そのもの — **絞り込みは安全側に倒してよい（見逃しがなければ過剰検出は許容される）**
  // ため、区間より細かい刻みで再計算した位置とのズレを吸収したい場合は大きめの値を指定する。
  resetSpan(
    bodies: readonly CelestialBody[], pivot: number, tStart: number, tEnd: number,
    reachMargin = 1,
  ): void {
    this.spanning.length = 0;
    this.reachable.length = 0;
    if (!(tStart <= tEnd)) return;
    // 範囲は区間の始点から測る。into が測る距離も参加者の始点からなので、両者の基準が揃う。
    for (const body of bodies) {
      const start = body.stateAt(pivot, tStart);
      const reach = body.def.radius
        + reachMargin * intervalReach(start, body.stateAt(pivot, tEnd));
      this.spanning.push({ body, r0: start.r, reach });
    }
    this.resetNarrow();
  }

  // narrow で狭めた候補を、区間の全候補へリセットする。**参加者リストや位置が変わる区切りごとに
  // 呼ぶ** — 狭めた結果はある1組の参加者に対してだけ正しい。
  resetNarrow(): void {
    this.reachable.length = 0;
    for (const candidate of this.spanning) this.reachable.push(candidate);
  }

  // into の抽出対象を、参加者リストのいずれかが接触しうる天体のみに絞り込む。絞り込み結果は次の resetNarrow
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

  // 参加者1つが区間内に接触しうる天体だけを out へ格納する。out は作業用配列。
  into(participant: SurfaceParticipant, out: CelestialBody[]): CelestialBody[] {
    out.length = 0;
    const { prevState } = participant;
    const reach = participant.radius + intervalReach(prevState, participant.state);
    for (const candidate of this.reachable) {
      const limit = reach + candidate.reach;
      if (distSq(prevState.r, candidate.r0) <= limit * limit) out.push(candidate.body);
    }
    return out;
  }
}
