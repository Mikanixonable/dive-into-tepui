// 時刻付き状態(OrbitState)を「いま」として保持し、1ステップ前進させ、任意時刻を引ける単位。
// THREE/DOM 非依存の純データ構造(StateQueue/Ephemeris と同じ「純粋だが状態を持つ」枠)。
//
// game/game-entity/ の GameEntity はこれを1本(current)持って state/history を転送する。
// 将来 GameEntity が2本目(predicted)を持つとき、過去列にも未来列にも同じこの実装を使う —
// history は常に「自分の state より古い時刻のサンプル列」であり、current ではそれが過去、
// predicted ではそれが「現在〜先端の間」になるだけで、構造も操作(step/at)もまったく同じ。
import { OrbitState, hermiteInterpolate } from './orbital';
import { StateQueue } from './state-queue';
import { Attractor } from './attractor';
import { Vec3 } from './vec3';
import { stepDynamicsRK4 } from './dynamics';

export class OrbitEntity {
  private _state: OrbitState;
  // 直前ステップの状態。history とは別フィールドで持つ(hit.ts の線分衝突判定・
  // targeter.ts の標的面通過判定が要るのは「直前サブステップの位置」で、間引かれた
  // history からは取れないため — ワープ中は1サンプルが数百秒に相当する)。
  private _prevState: OrbitState;
  // state より古いサンプル列(間引き済み)。件数ではなく時間窓(keepDuration)+ 間隔
  // (sampleInterval)で管理する — 呼び出し側(GameEntity)が種別ごとに渡す。
  private readonly _history = new StateQueue();

  // state・prevState をともに初期状態で始める。
  constructor(state: OrbitState) {
    this._state = state;
    this._prevState = state;
  }

  get state(): OrbitState { return this._state; }
  get prevState(): OrbitState { return this._prevState; }
  get history(): StateQueue { return this._history; }

  // 全天体重力 + J2 + 大気抵抗 + 推力で 1 ステップ RK4 積分する(dynamics.ts の
  // stepDynamicsRK4)。bodies はそのステップぶん呼び出し側が確定させた重力源一覧。
  // keepDuration > 0 かつ、直前の state が最新の記録サンプルから sampleInterval 秒以上
  // 離れているときだけ、その直前の state を history へ積む(解像度を落とす箇所はここ)。
  // 積んだ後は keepDuration を保持窓として history.cleanup する。keepDuration = 0 なら
  // history には一切触らない(デブリ・薬莢のコストをゼロに保つ)。
  step(
    dt: number,
    bodies: readonly Attractor[],
    bcInv: number,
    thrust: Vec3 | null,
    sampleInterval: number,
    keepDuration: number,
  ): void {
    const prev = this._state;
    const next = stepDynamicsRK4(prev, dt, bodies, bcInv, thrust);
    // 間引き済み history への記録
    if (keepDuration > 0) {
      const newest = this._history.newest;
      if (newest === null || prev.t - newest.t >= sampleInterval) {
        this._history.push(prev);
        this._history.cleanup(keepDuration, 2);
      }
    }
    this._prevState = prev;
    this._state = next;
  }

  // 不連続な差し替え(剛体接触・反動など、積分を経ない外部からの上書き)。history 側に
  // new state の時刻以降のサンプルが残っていると「history は state より古い」という
  // 不変条件が壊れるため、その分を捨てる。
  reset(state: OrbitState): void {
    this._history.discardFrom(state.t);
    this._prevState = this._state;
    this._state = state;
  }

  // 保持区間(history の最古 〜 state)を古い順に並べた1本の列。
  samplesOldestFirst(): OrbitState[] {
    const out = this._history.toArrayOldestFirst();
    out.push(this._state);
    return out;
  }

  // 保持区間内(history の最古 〜 state)の任意時刻の状態。区間外は null。
  // history が空なら t === state.t のときだけ state を返す。history の最新サンプルより
  // 新しければ state との間を、それ以前は history 自身の補間を使う — 列と state をまたぐ
  // 継ぎ目をここに閉じ込めるので、呼び出し側が両者を突き合わせる必要がない。
  at(t: number): OrbitState | null {
    if (t > this._state.t) return null;
    if (t === this._state.t) return this._state;
    const newest = this._history.newest;
    if (newest === null) return null;
    if (t > newest.t) return hermiteInterpolate(newest, this._state, t);
    return this._history.at(t);
  }
}
