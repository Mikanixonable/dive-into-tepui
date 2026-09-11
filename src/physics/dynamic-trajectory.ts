// 時刻付き状態(KinematicState)を「いま」として保持し、1ステップ前進させ、任意時刻を引ける単位。
// 先端(state)を含む間引き済みのサンプル列を持ち、過去方向の履歴にも未来方向の予測列にも使える。
import { KinematicState, kinematicState } from './kinematic-state';
import { StateQueue } from './state-queue';
import { extrapolatedRelativeState } from './kepler-extrapolation';
import { Vec3, add } from '../math/vec3';
import { stepDynamicsWithSamples, type DynamicsEnvironmentSample } from './dynamics';
import type { CelestialBody } from './celestial-body';

// 先端を二体ケプラー軌道とみなすときの中心天体と、それを厳密に引いた時刻。
export interface ExtrapolationCenter {
  readonly celestialBody: CelestialBody;
  readonly pivot: number;
}

export class DynamicTrajectory {
  // 直前ステップの状態。samples とは別フィールドで持つ — 間引かれた samples からは
  // 「直前サブステップの位置」が取れないため(ワープ中は1サンプルが数百秒に相当する)。
  private _prevState: KinematicState;
  // 先端(state)を含む、間引き済みのサンプル列。保持は時間窓(keepDuration)と間隔
  // (sampleInterval)で決まり、どちらも step/follow の引数で受け取る。最新要素が先端そのもので、
  // 常に1件以上ある。
  private readonly _samples = new StateQueue();
  // samplesOldestFirst() の結果のメモ。先端を動かすたびに無効化する。
  private _samplesCache: readonly KinematicState[] | null = null;
  // 直近の step で渡された、先端位置で最も強く引く解析天体。extrapolatedAt が二体軌道の
  // 中心に使う。中心天体を渡されずに進んだ列と、不連続な差し替えのあとは null。
  private _extrapolationCenter: ExtrapolationCenter | null = null;

  // state・prevState をともに初期状態で始める。
  public constructor(state: KinematicState) {
    this._samples.push(state);
    this._prevState = state;
  }

  public get state(): KinematicState { return this._samples.newest!; }
  public get prevState(): KinematicState { return this._prevState; }
  public get extrapolationCenter(): ExtrapolationCenter | null { return this._extrapolationCenter; }
  // 列の古い端(最も古い2サンプル)の時刻差 [s]。積んだ時点の間引き間隔で決まり、
  // 以後の step に渡す sampleInterval には左右されない。
  public get sampleInterval(): number { return this._samples.oldestGap; }

  // 全天体重力 + 2次重力場 + 大気抵抗 + 太陽輻射圧 + 推力で dt 秒ぶん積分して先端を進め、
  // そのステップ内の環境サンプルを返す。attractors はそのステップぶん確定させた重力源一覧、
  // occluders は日照率の遮蔽体一覧、atmosphereBody は抗力を及ぼすただ1体の大気天体(null なら抗力なし)。
  // sampleInterval・keepDuration は先端を積むときの保持方針(advanceTip)。
  // extrapolationCenter は extrapolatedAt が使う中心天体(省略時 null)。
  public step(
    dt: number,
    attractors: readonly CelestialBody[],
    occluders: readonly CelestialBody[],
    atmosphereBody: CelestialBody | null,
    pivot: number,
    bcInv: number,
    srpCoeff: number,
    thrust: Vec3 | null,
    sampleInterval: number,
    keepDuration: number,
    extrapolationCenter: CelestialBody | null = null,
  ): readonly DynamicsEnvironmentSample[] {
    const result = stepDynamicsWithSamples(
      this.state, dt, attractors, occluders, atmosphereBody, pivot, bcInv, srpCoeff, thrust);
    this.advanceTip(result.state, sampleInterval, keepDuration);
    this._extrapolationCenter = extrapolationCenter === null
      ? null : { celestialBody: extrapolationCenter, pivot };
    return result.samples;
  }

  // 積分せず、外から与えられた状態を先端にする。保持方針・prevState の更新は step と同じ。
  public follow(state: KinematicState, sampleInterval: number, keepDuration: number): void {
    this.advanceTip(state, sampleInterval, keepDuration);
  }

  // 先端を next にする。いまの先端は、1つ手前の保持サンプルから sampleInterval 秒以上
  // 離れていれば保持サンプルとして残り、そうでなければ捨てて置き換わる。keepDuration が 0 なら
  // 常に置き換える。prevState はいまの先端へ進む。
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

  // 不連続な差し替え(剛体接触・反動など、積分を経ない外部からの上書き)。state の時刻以降の
  // サンプルは無効になって捨てられる。中心天体も、先端の軌道自体が変わるため破棄する。
  public reset(state: KinematicState): void {
    this._prevState = this.state;
    this._samples.push(state);
    this._extrapolationCenter = null;
    this._samplesCache = null;
  }

  // 保持区間全体を古い順に並べた1本の列。先端が動かない限り同じ配列参照を返すので、
  // 参照の同一性で内容の変化を判定できる。
  public samplesOldestFirst(): readonly KinematicState[] {
    if (this._samplesCache === null) this._samplesCache = this._samples.toArrayOldestFirst();
    return this._samplesCache;
  }

  // 保持区間内(最古 〜 先端)の任意時刻の状態。区間外は null。
  public at(t: number): KinematicState | null { return this._samples.at(t); }

  // state より新しい時刻 t を、先端(state)を extrapolationCenter まわりの二体ケプラー軌道と
  // みなして外挿する。t が state 以前、または中心天体を保持していなければ at(t) と同じ。
  // 外挿できない軌道(双曲線など)では null。centerStateAtT は時刻 t における中心天体の ECI 状態。
  public extrapolatedAt(t: number, centerStateAtT: KinematicState): KinematicState | null {
    const tip = this.state;
    if (t <= tip.t || this._extrapolationCenter === null) return this.at(t);
    const center = this._extrapolationCenter;
    const rel = extrapolatedRelativeState(tip, center.celestialBody, center.pivot, t);
    if (rel === null) return null;
    return kinematicState<'eci'>(t, add(rel.r, centerStateAtT.r), add(rel.v, centerStateAtT.v));
  }
}
