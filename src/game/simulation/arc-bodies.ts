// 1本の積分弧が引く天体の一覧と、その維持。候補(レジストリの全天体)を毎歩ぜんぶ
// 解決する代わりに、いま効きうる天体だけを成員として保持する。成員は解決するついでに抜ける
// 条件を見る。成員でない候補は「最短でもこの時刻までは効き得ない」期限を持ち、その時刻が
// 来たときだけ解決して入る条件を見る。
import type { Attractor, AttractorId } from '../../physics/attractor';
import type { KinematicState } from '../../physics/kinematic-state';
import { len, sub } from '../../physics/vec3';
import * as C from '../const';

// 積分が引きうる天体1体ぶんの、時刻に依らない素性。
export type FutureBodyCandidate = {
  readonly id: AttractorId;
  readonly mu: number; // 重力定数 GM [m^3/s^2]。0 なら重力源にならない
  readonly radius: number; // 表面半径 [m]
};

// 弧が天体を引く相手。候補の顔ぶれは弧を作った時点で確定する。
export type FutureAttractorProvider = {
  readonly candidates: () => readonly FutureBodyCandidate[];
  // 候補1体の時刻 t での状態。
  readonly bodyAt: (id: AttractorId, t: number) => Attractor;
};

// 弧の1歩が読む天体一式。gravity は引力を持つ天体、collision は表面到達の相手。
export type ArcBodyWindow = {
  readonly gravity: readonly Attractor[];
  readonly collision: readonly Attractor[];
};

// 候補1体ぶんの成員判定の状態。
type Watch = {
  readonly candidate: FutureBodyCandidate;
  // 引力が GRAVITY_NEGLIGIBLE_ACCEL を割ると言い切れる距離 [m]。直達項 mu/d² と ECI 原点補正項
  // mu/D² の和は 2mu/min(d,D)² を超えないので、min(d,D) がこれを上回れば寄与は無視できる。
  readonly gravityReach: number;
  // 寄与が無視できても成員のままにする天体。中心天体の解決が空の一覧を引くのを防ぐ。
  readonly pinned: boolean;
  member: boolean;
  nextVisitT: number;
};

// 候補の状態が「効き始める」までの猶予 [s]。重力(寄与が無視できなくなる距離まで)と表面到達
// (半径まで)のうち早いほうを、保守的に見積もった接近速度で割る。
function slackTime(w: Watch, body: Attractor, from: KinematicState): number {
  const dist = len(sub(body.state.r, from.r));
  // 原点補正項は問い合わせ位置に依らず天体の原点距離だけで決まるので、近いほうの距離で見る。
  const gravitySlack = w.candidate.mu === 0
    ? Infinity
    : Math.min(dist, len(body.state.r)) - w.gravityReach;
  const collisionSlack = dist - body.radius;
  const slack = Math.min(gravitySlack, collisionSlack);
  if (slack <= 0) return 0;
  const closing = (len(sub(body.state.v, from.v)) + len(body.state.v)) * C.ARC_BODY_CLOSING_SAFETY
    + C.ARC_BODY_CLOSING_MARGIN;
  return slack / closing;
}

// 最も重い天体の id。引力を持つ天体が候補に無ければ null。
function heaviestGravityId(candidates: readonly FutureBodyCandidate[]): AttractorId | null {
  let id: AttractorId | null = null;
  let mu = 0;
  for (const c of candidates) {
    if (c.mu <= mu) continue;
    id = c.id;
    mu = c.mu;
  }
  return id;
}

export class ArcBodies {
  // 候補1体につき1つ。顔ぶれは弧の一生を通じて同じなので、構築時に組んで持ち続ける。
  private readonly watches: readonly Watch[];
  // 直近の resolve で解決した天体の数と、そのうち期限到来で訪問したものの数。
  lastResolved = 0;
  lastRevisited = 0;

  constructor(private readonly sources: FutureAttractorProvider) {
    const candidates = sources.candidates();
    const pinnedId = heaviestGravityId(candidates);
    this.watches = candidates.map((candidate) => ({
      candidate,
      gravityReach: Math.sqrt(2 * candidate.mu / C.GRAVITY_NEGLIGIBLE_ACCEL),
      pinned: candidate.id === pinnedId,
      member: false,
      nextVisitT: -Infinity,
    }));
  }

  // 時刻 t に弧が読む天体一式。from は判定の基準にする弧の先端状態、stepDt はこの解決のあとに
  // 踏む刻み幅 [s](まだ決まっていない最初の解決では 0 でよい)。返る配列はこの呼び出しごとに
  // 新しく、呼び出し側が次の解決まで保持してよい。
  resolve(t: number, from: KinematicState, stepDt: number): ArcBodyWindow {
    // 次の歩で表面へ届きうる天体が一覧の外に残らないよう、刻み幅の数歩ぶん先まで入れておく。
    const lead = Math.max(stepDt, C.ARC_MIN_STEP_DT) * C.ARC_BODY_LEAD_STEPS;
    const gravity: Attractor[] = [];
    const collision: Attractor[] = [];
    this.lastResolved = 0;
    this.lastRevisited = 0;
    for (const w of this.watches) {
      if (!w.member && w.nextVisitT > t) continue;
      if (!w.member) this.lastRevisited++;
      const body = this.sources.bodyAt(w.candidate.id, t);
      this.lastResolved++;
      const slack = slackTime(w, body, from);
      w.member = w.pinned || slack <= lead;
      w.nextVisitT = t + Math.max(0, slack - lead);
      if (!w.member) continue;
      if (w.candidate.mu !== 0) gravity.push(body);
      collision.push(body);
    }
    return { gravity, collision };
  }
}

