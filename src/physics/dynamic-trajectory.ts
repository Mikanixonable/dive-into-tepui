// 時刻付き状態(KinematicState)を「いま」として保持し、1ステップ前進させ、任意時刻を引ける単位。
// THREE/DOM 非依存の純データ構造(StateQueue と同じ「純粋だが状態を持つ」枠)。
//
// samples は常に「先端(state)を含む、間引き済みのサンプル列」という不変条件だけを前提にする
// ため、過去方向の履歴にも未来方向の予測列にも同じ実装をそのまま使える。
import { KinematicState, kinematicState } from './kinematic-state';
import { StateQueue } from './state-queue';
import { CelestialBody } from './celestial-body';
import { extrapolatedRelativeState } from './kepler-extrapolation';
import { Vec3, add } from '../math/vec3';
import { stepDynamics } from './dynamics';

export class DynamicTrajectory {
  // 直前ステップの状態。samples とは別フィールドで持つ — 間引かれた samples からは
  // 「直前サブステップの位置」が取れないため(ワープ中は1サンプルが数百秒に相当する)。
  private _prevState: KinematicState;
  // 先端(state)を含む、間引き済みのサンプル列。件数ではなく時間窓(keepDuration)+ 間隔
  // (sampleInterval)で管理し、両者は種別ごとに step の呼び出し元が渡す。最新要素が
  // 先端(state)そのもの。空になることはない。
  private readonly _samples = new StateQueue();
  // samplesOldestFirst() の結果のメモ。step/reset で無効化する — TrajectoryLine.syncGeometry の
  // 早期 return は samples の参照同一性で判定するため、内容が変わっていない間は同じ配列参照を
  // 返し続けないと、呼び出し側が同一内容を渡しても毎フレーム焼き直しになってしまう。
  private _samplesCache: readonly KinematicState[] | null = null;
  // 直近の step で渡された、先端位置で最も強く引く解析天体。extrapolatedAt が二体軌道の
  // 中心に使う。
  private _extrapolationCenter: CelestialBody | null = null;

  // state・prevState をともに初期状態で始める。
  constructor(state: KinematicState) {
    this._samples.push(state);
    this._prevState = state;
  }

  get state(): KinematicState { return this._samples.newest!; }
  get prevState(): KinematicState { return this._prevState; }
  get extrapolationCenter(): CelestialBody | null { return this._extrapolationCenter; }
  // 列の最も古い端での間引き間隔 [s]。列がどれだけ粗いかは列自身の属性であり、積んだ後に
  // 呼び出し側の設定が変わっても、既に積んだサンプルの粗さは変わらない。保持窓が飽和した
  // 列では、この端が最も古い保持サンプルとその1つ新しい側を挟む補間区間にあたる。
  get sampleInterval(): number { return this._samples.oldestGap; }

  // 全天体重力 + 2次重力場 + 大気抵抗 + 太陽輻射圧 + 推力で 1 ステップ RK4 積分する
  // (dynamics.ts の stepDynamics)。attractors はそのステップぶん呼び出し側が確定させた
  // 重力源一覧、occluders は日照率の遮蔽体一覧、atmosphereBody は抗力を及ぼすただ1体の
  // 大気天体(null なら抗力なし)。
  // sampleInterval・keepDuration は先端を積むときの保持方針(advanceTip)。
  // extrapolationCenter は extrapolatedAt が使う中心天体(省略時 null)。
  step(
    dt: number,
    attractors: readonly CelestialBody[],
    occluders: readonly CelestialBody[],
    atmosphereBody: CelestialBody | null,
    bcInv: number,
    srpCoeff: number,
    thrust: Vec3 | null,
    sampleInterval: number,
    keepDuration: number,
    extrapolationCenter: CelestialBody | null = null,
  ): void {
    const next = stepDynamics(
      this.state, dt, attractors, occluders, atmosphereBody, bcInv, srpCoeff, thrust);
    this.advanceTip(next, sampleInterval, keepDuration);
    this._extrapolationCenter = extrapolationCenter;
  }

  // 積分せず、外から与えられた状態を先端にする。保持方針・prevState の更新は step と同じ。
  follow(state: KinematicState, sampleInterval: number, keepDuration: number): void {
    this.advanceTip(state, sampleInterval, keepDuration);
  }

  // 先端を next にする。いまの先端は、1つ手前の保持サンプルから sampleInterval 秒以上
  // 離れていれば保持サンプルとして残り、そうでなければ捨てて置き換わる(解像度を落とす箇所は
  // ここ)。保持窓は keepDuration で、0 なら常に置き換えるだけ(デブリ・薬莢のコストを
  // ゼロに保つ)。prevState はいまの先端へ進む。
  private advanceTip(next: KinematicState, sampleInterval: number, keepDuration: number): void {
    const prev = this.state;
    if (keepDuration > 0 && (this._samples.size < 2 || this._samples.newestGap >= sampleInterval)) {
      this._samples.cleanup(keepDuration, 2);
    } else {
      this._samples.discardNewest();
    }
    this._samples.push(next);
    this._prevState = prev;
    this._samplesCache = null;
  }

  // 不連続な差し替え(剛体接触・反動など、積分を経ない外部からの上書き)。push の訂正契約
  // (StateQueue 冒頭のコメント)により、新しい時刻以降の無効になったサンプルは捨てられる。
  // 中心天体も、差し替えで先端の軌道自体が変わるため破棄する。
  reset(state: KinematicState): void {
    this._prevState = this.state;
    this._samples.push(state);
    this._extrapolationCenter = null;
    this._samplesCache = null;
  }

  // 保持区間全体を古い順に並べた1本の列。先端が動かない限り同じ配列参照を返す
  // (TrajectoryLine.syncGeometry の再 bake 抑制が参照同一性で判定するため)。
  samplesOldestFirst(): readonly KinematicState[] {
    if (this._samplesCache === null) this._samplesCache = this._samples.toArrayOldestFirst();
    return this._samplesCache;
  }

  // 保持区間内(最古 〜 先端)の任意時刻の状態。区間外は null。
  at(t: number): KinematicState | null { return this._samples.at(t); }

  // state より新しい時刻 t を、先端(state)を extrapolationCenter まわりの二体ケプラー軌道と
  // みなして外挿する。t が state 以前、または中心天体を保持していなければ at(t) と同じ。
  // centerStateAtT は問い合わせ時刻 t における中心天体の ECI 状態 — 天体暦への依存を
  // 持ち込まないため、解決は呼び出し側が行う。
  extrapolatedAt(t: number, centerStateAtT: KinematicState): KinematicState | null {
    const tip = this.state;
    if (t <= tip.t || this._extrapolationCenter === null) return this.at(t);
    const rel = extrapolatedRelativeState(tip, this._extrapolationCenter, t);
    if (rel === null) return null;
    return kinematicState<'eci'>(t, add(rel.r, centerStateAtT.r), add(rel.v, centerStateAtT.v));
  }
}
