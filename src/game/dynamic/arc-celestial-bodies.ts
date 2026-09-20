// 1本の積分弧が引く天体の一覧。候補の天体のうち、いま効きうる天体を成員として保ち、成員でない
// 候補は効き得ない期限が来たときに見直す。
import type { CelestialBody } from '../../physics/celestial-body';
import type { KinematicState } from '../../physics/kinematic-state';
import { len, sub } from '../../math/vec3';
import { gravityReachOf } from './attractors';
import { ARC_MIN_STEP_DT } from './time-step';
import type { CelestialBodyDef } from '../../physics/celestial-body-def';

// 一覧の外にある天体が「いつまで効き得ないか」を見積もるときの、接近速さの安全率と下限 [m/s]。
// 接近速さを小さく見積もると取りこぼすので保守側に取る。下限は、相対速度がいま 0 の天体にも
// 有限の期限を与えるため。
const ARC_BODY_CLOSING_SAFETY = 2;
const ARC_BODY_CLOSING_MARGIN = 2000;

// 一覧へ入れておく先読み時間を、そのときの刻み幅の何歩ぶんに取るか。次の1歩で表面へ届きうる
// 天体が一覧の外に残ると、その歩の掃引到達判定がその天体を見ないまま通り抜ける。
const ARC_BODY_LEAD_STEPS = 4;

// 弧の1歩が読む天体一式。gravity は引力を持つ天体、collision は表面到達の相手、
// pivot はこの一式を解決した(= 天体の位置を厳密に引いた)時刻。
export interface ArcCelestialBodyWindow {
  readonly pivot: number;
  readonly gravity: readonly CelestialBody[];
  readonly collision: readonly CelestialBody[];
}

// 候補1体ぶんの成員判定の状態。
interface Watch {
  readonly motion: CelestialBody;
  readonly candidate: Pick<CelestialBodyDef, 'id' | 'mu' | 'radius'>;
  // 引力の寄与を無視できると言い切れる距離 [m]。
  readonly gravityReach: number;
  // 寄与が無視できても成員のままにする天体。中心天体の解決が空の一覧を引くのを防ぐ。
  readonly pinned: boolean;
  member: boolean;
  nextVisitT: number;
}

// 候補の状態が「効き始める」までの猶予 [s]。重力(寄与が無視できなくなる距離まで)と表面到達
// (半径まで)のうち早いほうを、保守的に見積もった接近速度で割る。
function slackTime(w: Watch, body: CelestialBody, pivot: number, from: KinematicState): number {
  const state = body.stateAt(pivot);
  const dist = len(sub(state.r, from.r));
  // 原点補正項は問い合わせ位置に依らず天体の原点距離だけで決まるので、近いほうの距離で見る。
  const gravitySlack = w.candidate.mu === 0
    ? Infinity
    : Math.min(dist, len(state.r)) - w.gravityReach;
  const collisionSlack = dist - body.def.radius;
  const slack = Math.min(gravitySlack, collisionSlack);
  if (slack <= 0) return 0;
  const closing = (len(sub(state.v, from.v)) + len(state.v)) * ARC_BODY_CLOSING_SAFETY
    + ARC_BODY_CLOSING_MARGIN;
  return slack / closing;
}

// 最も重い天体の id。引力を持つ天体が候補に無ければ null。
function heaviestGravityId(candidates: readonly Pick<CelestialBodyDef, 'id' | 'mu' | 'radius'>[]): string | null {
  let id: string | null = null;
  let mu = 0;
  for (const c of candidates) {
    if (c.mu <= mu) continue;
    id = c.id;
    mu = c.mu;
  }
  return id;
}

// 弧1本に影響する天体候補と見直し期限。resolve は弧先端の時刻順に呼び出す。
export class ArcCelestialBodies {
  // 候補1体につき1つ。
  private readonly watches: readonly Watch[];
  // 直近の resolve で解決した天体の数と、そのうち期限到来で訪問したものの数。
  private _lastResolved = 0;
  private _lastRevisited = 0;

  public get lastResolved(): number { return this._lastResolved; }
  public get lastRevisited(): number { return this._lastRevisited; }

  // sources は候補天体の配列。生成後に配列要素は変更されない。
  public constructor(sources: readonly CelestialBody[]) {
    const candidates = sources.map((m) => m.def);
    // 最も重い天体は、寄与が無視できても成員に留める。
    const pinnedId = heaviestGravityId(candidates);
    this.watches = sources.map((motion) => ({
      motion,
      candidate: motion.def,
      gravityReach: gravityReachOf(motion.def.mu),
      pinned: motion.id === pinnedId,
      member: false,
      nextVisitT: -Infinity,
    }));
  }

  // 時刻 t で弧の計算対象となる天体一式を返す。from は判定基準となる弧先端の状態、
  // stepDt は次ステップの刻み幅 [s]（初回解決時は 0）。返却配列は呼び出しごとに
  // 新規生成され、次の解決まで保持できる。
  public resolve(t: number, from: KinematicState, stepDt: number): ArcCelestialBodyWindow {
    // 成員に入れておく先読み時間 [s]
    const lead = Math.max(stepDt, ARC_MIN_STEP_DT) * ARC_BODY_LEAD_STEPS;
    const gravity: CelestialBody[] = [];
    const collision: CelestialBody[] = [];
    this._lastResolved = 0;
    this._lastRevisited = 0;
    // 成員と、見直しの期限が来た候補だけを判定し直す
    for (const w of this.watches) {
      if (!w.member && w.nextVisitT > t) continue;
      if (!w.member) this._lastRevisited++;
      const body = w.motion;
      this._lastResolved++;
      const slack = slackTime(w, body, t, from);
      w.member = w.pinned || slack <= lead;
      w.nextVisitT = t + Math.max(0, slack - lead);
      if (!w.member) continue;
      if (w.candidate.mu !== 0) gravity.push(body);
      collision.push(body);
    }
    return { pivot: t, gravity, collision };
  }
}

