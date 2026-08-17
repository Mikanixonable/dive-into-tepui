// 自機の予測列を、計画軌道の1区間として答える。GameEntity.predicted を [state0.t, end] の
// 範囲に切って答えるだけで積分は一切持たないので、PlanArc と違い毎フレーム作り直してよい。
// PlanArc と同じ形で答えるため、PlanPath は両者を区別せず読める。
import { KinematicState } from '../../physics/kinematic-state';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import { Attractor, BodyImpact } from '../../physics/attractor';
import { GameEntity } from '../game-entity/game-entity';
import { clipSamplesTo, stateAt, withinEnd } from './arc-range';

export class PredictedArc {
  // 積分を持たないので常に0。
  public readonly lastSteps = 0;

  private readonly _state0: KinematicState;
  private readonly _end: number;

  // entity の予測列を [state0.t, end] の範囲で答える。答える範囲の先頭が state0.t に決まるので、
  // それより前のアプシスは対象から外す。
  public constructor(
    private readonly entity: GameEntity,
    state0: KinematicState,
    end: number,
  ) {
    this._state0 = state0;
    this._end = end;
    entity.predictedApsides?.dropBefore(state0.t);
  }

  // この区間が答える範囲の先頭状態。
  public get state0(): KinematicState {
    return this._state0;
  }

  // この区間が答える終端時刻。
  public get end(): number {
    return this._end;
  }

  // entity の予測列そのもの。予測がまだ無ければ null。
  public get trajectory(): DynamicTrajectory | null {
    return this.entity.predicted;
  }

  // end でクリップした予測列のサンプル列。予測がまだ無ければ空配列。
  public get samples(): readonly KinematicState[] {
    return clipSamplesTo(this.entity.predicted?.samplesOldestFirst() ?? [], this._end);
  }

  // 時刻 t の状態。予測列が無い、end を超える、または予測の保持区間外なら null。
  public at(t: number): KinematicState | null {
    const trajectory = this.entity.predicted;
    return trajectory ? stateAt(trajectory, t, this._end) : null;
  }

  // 終端の状態。終端まで予測が伸びていなければ null。
  public endState(): KinematicState | null {
    return this.at(this._end);
  }

  // 予測列が天体表面へ達した状態と、その天体。end を超えていれば null。
  public impactPoint(): BodyImpact | null {
    const impact = this.entity.predictedImpact;
    return impact && withinEnd(impact.state.t, this._end) ? impact : null;
  }

  // 近地点・遠地点の検出に使っている中心天体。予測列がまだ無ければ null。
  public get apsisCenter(): Attractor | null {
    return this.entity.predictedApsides?.center ?? null;
  }

  // 答える範囲で最初の近地点。end を超えていれば null。
  public periapsisPoint(): KinematicState | null {
    const first = this.entity.predictedApsides?.periapsis ?? null;
    return first && withinEnd(first.t, this._end) ? first : null;
  }

  // 答える範囲で最初の遠地点。end を超えていれば null。
  public apoapsisPoint(): KinematicState | null {
    const first = this.entity.predictedApsides?.apoapsis ?? null;
    return first && withinEnd(first.t, this._end) ? first : null;
  }
}
