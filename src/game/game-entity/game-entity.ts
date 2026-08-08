// ゲーム内エンティティの定義。位置・速度は ECI 座標系 [m, m/s]。
import * as THREE from 'three/webgpu';
import { OrbitState } from '../../physics/orbital-state';
import { Elements } from '../../physics/elements';
import { Attitude } from '../../physics/attitude';
import { OrbitEntity } from '../../physics/orbit-entity';
import { StateQueue } from '../../physics/state-queue';
import type { Ephemeris } from '../../physics/ephemeris';
import { Attractor, AttractorId, elementsAround as elementsAroundBody, hitsAnySurface, localOrbitPeriod } from '../../physics/attractor';
import { Vec3, len, sub, v3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import type { Stage } from '../stages/stage';

const identityAttitude = (): Attitude => ({
  q: { x: 0, y: 0, z: 0, w: 1 },
  w: v3(),
  inertia: v3(1, 1, 1),
});

// 軌道上を運動するゲーム内エンティティの基底。mesh・HP・生死・姿勢・AI といったゲーム側の
// 付帯情報と、種別ごとの積分パラメータ(bcInv・historyDuration)を持つ。
export class GameEntity {
  readonly current: OrbitEntity;

  get state(): OrbitState { return this.current.state; }
  // 不連続な差し替え専用の口(剛体接触・反動など)。
  set state(s: OrbitState) { this.current.reset(s); }
  get prevState(): OrbitState { return this.current.prevState; }
  get history(): StateQueue { return this.current.history; }

  // elementsAround(body) のメモ。state の参照同一性(OrbitState は不変で step ごとに
  // 新しい参照へ差し替わる)と body.id で無効化する。
  private _memoState: OrbitState | null = null;
  private _memoBodyId: AttractorId | null = null;
  private _memoElements: Elements | null = null;

  att: Attitude;
  obj: THREE.Object3D;
  alive = true;
  mass = 1; // 剛体接触の換算質量
  collideRadius?: number; // 剛体接触半径 [m]。未設定 = 剛体接触に参加しない
  thrust: Vec3 | null = null;
  // 機体座標系トルク。既定ゼロ = 自由回転。
  torque: Vec3 = v3();
  // 弾道係数の逆数 Cd·A/m(既定 0 = 抵抗なし)。
  protected readonly bcInv: number = 0;
  protected readonly srpCoeff: number = 0;
  // 過去列の保持時間 [s]。既定 0 = 記録しない。
  protected readonly historyDuration: number = 0;
  // 未来を予測する種別か。既定 false。予測する長さは表示期間に追従するので、
  // 種別ごとに決まるのは可否だけ。
  readonly predictsFuture: boolean = false;
  protected readonly scene?: THREE.Scene;

  // 未来の予測列。
  private _predicted: OrbitEntity | null = null;
  get predicted(): OrbitEntity | null { return this._predicted; }
  // 積分中に再突入高度を割った/非有限値が出て打ち切られたか。
  private truncated = false;

  // 初期状態と姿勢からエンティティを構築する。scene を渡すと obj を即座にシーンへ追加する。
  constructor(state: OrbitState, obj: THREE.Object3D, scene?: THREE.Scene, att: Attitude = identityAttitude()) {
    this.current = new OrbitEntity(state);
    this.att = att;
    this.obj = obj;
    this.scene = scene;
    this.scene?.add(this.obj);
  }

  // body を中心とする接触軌道要素。中心は呼び出し側が選ぶ(例: strongestAttractor)。
  elementsAround(body: Attractor): Elements | null {
    if (this._memoState !== this.state || this._memoBodyId !== body.id) {
      this._memoState = this.state;
      this._memoBodyId = body.id;
      this._memoElements = elementsAroundBody(this.state, body);
    }
    return this._memoElements;
  }

  // 保持窓が keepDuration の列へ積む最小間隔 [s]。その場で最も強く引く天体を中心とする
  // 軌道周期を等分し、窓が長いときは保持サンプル数の上限側で頭打ちにする。
  protected sampleInterval(bodies: readonly Attractor[], state: OrbitState, keepDuration: number): number {
    const period = localOrbitPeriod(state.r, bodies);
    const span = isFinite(period) && period > 0 ? period : C.SHIP_HISTORY_DURATION;
    return Math.max(span / C.PREDICT_SAMPLES_PER_REV, keepDuration / C.PREDICT_MAX_SAMPLES);
  }

  // 全天体重力 + J2 + 大気抵抗 + 自身の推力で 1 ステップ積分する。このステップぶんの重力源は
  // 中点(t + dt/2)で1回だけ引く — attractorsAt は同一時刻の呼び出しを前提にメモ化されて
  // いるので、1ステップの中で別の時刻を引くとメモが効かなくなる。historyDuration が 0
  // (弾・薬莢・破片)の間は間引き間隔を使わないので sampleInterval を評価しない。
  stepSim(dt: number, ephemeris: Ephemeris): void {
    if (!this.alive) return;
    const bodies = ephemeris.attractorsAt(this.state.t + dt / 2);
    const interval = this.historyDuration > 0
      ? this.sampleInterval(bodies, this.state, this.historyDuration)
      : 0;
    this.current.step(dt, bodies, this.bcInv, this.srpCoeff, C.SHADOW_PENUMBRA, this.thrust, interval, this.historyDuration);
  }

  // シミュレーションを正確に区切る必要がある次の絶対時刻。寿命など、既知の時刻で
  // 発生するイベントを持たないエンティティは null を返す。
  nextSimulationEventTime(_simTime: number): number | null {
    return null;
  }

  // 予測列を破棄する。
  invalidatePrediction(): void {
    this._predicted = null;
  }

  // 実状態との位置ずれが許容量を超えていたら予測列を破棄する。破棄したら true。
  // bodies は simTime の重力源一覧、horizon は予測している長さ [s]。
  resyncPrediction(simTime: number, bodies: readonly Attractor[], horizon: number): boolean {
    if (this._predicted === null) return false;
    const predictedState = this._predicted.at(simTime);
    if (predictedState !== null
      && len(sub(predictedState.r, this.state.r)) <= this.resyncTolerance(bodies, horizon)) {
      return false;
    }
    this.invalidatePrediction();
    return true;
  }

  // 乖離判定の許容量 [m]。保持サンプル数の上限で間引きが粗くなると at() の補間そのものが
  // 誤差を持つので、その誤差(間引き間隔の4乗に比例)まで許容量を広げる — 広げないと、
  // 実状態と一致している列を毎フレーム破棄して予測が永久に完成しなくなる。
  private resyncTolerance(bodies: readonly Attractor[], horizon: number): number {
    const period = localOrbitPeriod(this.state.r, bodies);
    const span = isFinite(period) && period > 0 ? period : C.SHIP_HISTORY_DURATION;
    const coarsening = Math.max(1, (horizon / C.PREDICT_MAX_SAMPLES) / (span / C.PREDICT_SAMPLES_PER_REV));
    return Math.max(C.PREDICT_RESET_DIST, C.PREDICT_SAMPLE_ERROR * coarsening ** 4);
  }

  // 予測列の先端を、呼び出し側が確定させた重力源 bodies のもとで dt ぶん1ステップ伸ばす。
  // horizon は simTime から先に予測する長さ [s]。伸ばせなかったら false。
  stepPrediction(bodies: readonly Attractor[], simTime: number, dt: number, horizon: number): boolean {
    if (!this.predictsFuture) return false;
    // 自由飛行前提の予測は噴射中に成立しないので、推力がかかっている間は伸ばさない。
    if (this.thrust !== null) return false;
    if (this._predicted === null) {
      this._predicted = new OrbitEntity(this.current.state);
      this.truncated = false;
    }
    if (this.truncated) return false;
    const p = this._predicted;

    // ホライズン時刻ちょうどを at() で引けるよう、先端は必ずホライズンを1ステップぶん
    // 越えたところまで伸ばす。
    if (p.state.t > simTime + horizon) return false;

    p.step(dt, bodies, this.bcInv, this.srpCoeff, C.SHADOW_PENUMBRA, null, this.sampleInterval(bodies, p.state, horizon), horizon);

    // 有限チェック
    const { r, v } = p.state;
    const finite = Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
      && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    if (!finite || hitsAnySurface(r, bodies, C.REENTRY_ALT)) this.truncated = true;

    return true;
  }

  // 表示時刻 t の状態。予測を持たない/予測期間を超えた時刻は null。
  displayState(t: number): OrbitState | null {
    return t <= this.current.state.t ? this.current.at(t) : (this._predicted?.at(t) ?? null);
  }

  // displayTime の描画位置・姿勢を fo 経由でメッシュへ同期する。
  sync(fo: FloatingOrigin, displayTime: number): void {
    const s = this.displayState(displayTime);
    if (s === null) {
      this.obj.visible = false;
      return;
    }
    this.obj.visible = true;
    this.obj.position.copy(fo.RtoThreeV3(s.r));
    this.obj.quaternion.set(this.att.q.x, this.att.q.y, this.att.q.z, this.att.q.w);
  }

  // playerPos は「自機からの距離」で消える種別(弾)のために一律で渡す。bodies はその時刻の
  // 重力源一覧(表面到達判定に使う)。
  checkLoss(_dt: number, _simTime: number, _activeStage: Stage, _playerPos: Vec3, bodies: readonly Attractor[]): void {
    if (!this.alive) return;
    if (hitsAnySurface(this.state.r, bodies, C.DEBRIS_REENTRY_ALT)) this.alive = false;
  }

  // メッシュを scene から取り除く。
  dispose(): void {
    this.scene?.remove(this.obj);
  }
}
