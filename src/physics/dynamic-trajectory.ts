// 時刻付き状態(KinematicState)を「いま」として保持し、1ステップ前進させ、任意時刻を引ける単位。
// THREE/DOM 非依存の純データ構造(StateQueue/Ephemeris と同じ「純粋だが状態を持つ」枠)。
//
// history は常に「自分の state より古い時刻のサンプル列」という不変条件だけを前提にする
// ため、過去方向の履歴にも未来方向の予測列にも同じ実装をそのまま使える。
import { KinematicState, hermiteInterpolate } from './kinematic-state';
import { StateQueue } from './state-queue';
import { Attractor } from './attractor';
import { Vec3 } from './vec3';
import { stepDynamics } from './dynamics';

export class DynamicTrajectory {
  private _state: KinematicState;
  // 直前ステップの状態。history とは別フィールドで持つ — 間引かれた history からは
  // 「直前サブステップの位置」が取れないため(ワープ中は1サンプルが数百秒に相当する)。
  private _prevState: KinematicState;
  // state より古いサンプル列(間引き済み)。件数ではなく時間窓(keepDuration)+ 間隔
  // (sampleInterval)で管理し、両者は種別ごとに step の呼び出し元が渡す。
  private readonly _history = new StateQueue();
  // samplesOldestFirst() の結果のメモ。step/reset で無効化する — SampledLine.syncGeometry の
  // 早期 return は samples の参照同一性で判定するため、内容が変わっていない間は同じ配列参照を
  // 返し続けないと、呼び出し側が同一内容を渡しても毎フレーム焼き直しになってしまう。
  private _samplesCache: readonly KinematicState[] | null = null;
  // 直近の step に渡された間引き間隔 [s]。列がどれだけ粗いかは列自身の属性であり、
  // 積んだ後に呼び出し側の設定が変わっても、既に積んだサンプルの粗さは変わらない。
  private _sampleInterval = 0;

  // state・prevState をともに初期状態で始める。
  constructor(state: KinematicState) {
    this._state = state;
    this._prevState = state;
  }

  get state(): KinematicState { return this._state; }
  get prevState(): KinematicState { return this._prevState; }
  get history(): StateQueue { return this._history; }
  get sampleInterval(): number { return this._sampleInterval; }

  // 全天体重力 + 2次重力場 + 大気抵抗 + 太陽輻射圧 + 推力で 1 ステップ RK4 積分する
  // (dynamics.ts の stepDynamics)。attractors はそのステップぶん呼び出し側が確定させた
  // 重力源一覧。
  // keepDuration > 0 かつ、直前の state が最新の記録サンプルから sampleInterval 秒以上
  // 離れているときだけ、その直前の state を history へ積む(解像度を落とす箇所はここ)。
  // 積んだ後は keepDuration を保持窓として history.cleanup する。keepDuration = 0 なら
  // history には一切触らない(デブリ・薬莢のコストをゼロに保つ)。
  step(
    dt: number,
    attractors: readonly Attractor[],
    bcInv: number,
    srpCoeff: number,
    penumbra: number,
    thrust: Vec3 | null,
    sampleInterval: number,
    keepDuration: number,
  ): void {
    const prev = this._state;
    const next = stepDynamics(prev, dt, attractors, bcInv, srpCoeff, penumbra, thrust);
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
    this._sampleInterval = sampleInterval;
    this._samplesCache = null;
  }

  // 不連続な差し替え(剛体接触・反動など、積分を経ない外部からの上書き)。history 側に
  // new state の時刻以降のサンプルが残っていると「history は state より古い」という
  // 不変条件が壊れるため、その分を捨てる。
  reset(state: KinematicState): void {
    this._history.discardFrom(state.t);
    this._prevState = this._state;
    this._state = state;
    this._samplesCache = null;
  }

  // 保持区間(history の最古 〜 state)を古い順に並べた1本の列。step/reset を挟まない限り
  // 同じ配列参照を返す(SampledLine.syncGeometry の再 bake 抑制が参照同一性で判定するため)。
  samplesOldestFirst(): readonly KinematicState[] {
    if (this._samplesCache === null) {
      const out = this._history.toArrayOldestFirst();
      out.push(this._state);
      this._samplesCache = out;
    }
    return this._samplesCache;
  }

  // 保持区間内(history の最古 〜 state)の任意時刻の状態。区間外は null。
  // history が空なら t === state.t のときだけ state を返す。history の最新サンプルより
  // 新しければ state との間を、それ以前は history 自身の補間を使う — 列と state をまたぐ
  // 継ぎ目をここに閉じ込めるので、呼び出し側が両者を突き合わせる必要がない。
  at(t: number): KinematicState | null {
    if (t > this._state.t) return null;
    if (t === this._state.t) return this._state;
    const newest = this._history.newest;
    if (newest === null) return null;
    if (t > newest.t) return hermiteInterpolate(newest, this._state, t);
    return this._history.at(t);
  }
}
