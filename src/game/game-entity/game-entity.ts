// ゲーム内エンティティの定義。位置・速度は ECI 座標系 [m, m/s]。
import * as THREE from 'three/webgpu';
import { KinematicState } from '../../physics/kinematic-state';
import { OrbitalElements } from '../../physics/elements';
import { Attitude } from '../../physics/attitude';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import { StateQueue } from '../../physics/state-queue';
import type { Ephemeris } from '../../physics/ephemeris';
import { Attractor, AttractorId, orbitalElementsOf, hitCelestialBody, localOrbitPeriod } from '../../physics/attractor';
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
  readonly actualTrajectory: DynamicTrajectory;

  get state(): KinematicState { return this.actualTrajectory.state; }
  // 不連続な差し替え専用の口(剛体接触・反動など)。
  set state(s: KinematicState) { this.actualTrajectory.reset(s); }
  get prevState(): KinematicState { return this.actualTrajectory.prevState; }
  get history(): StateQueue { return this.actualTrajectory.history; }

  // orbitalElementsAround(center) のメモ。state の参照同一性(KinematicState は不変で step ごとに
  // 新しい参照へ差し替わる)と center.id で無効化する。
  private _memoState: KinematicState | null = null;
  private _memoCenterId: AttractorId | null = null;
  private _memoElements: OrbitalElements | null = null;

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
  // 過去列の保持時間 [s]。既定 0 = 記録しない。
  protected readonly historyDuration: number = 0;
  // 未来を予測する種別か。既定 false。予測する長さは表示期間に追従するので、
  // 種別ごとに決まるのは可否だけ。
  readonly predictsFuture: boolean = false;
  protected readonly scene?: THREE.Scene;

  // 未来の予測列。
  private _predictedTrajectory: DynamicTrajectory | null = null;
  get predictedTrajectory(): DynamicTrajectory | null { return this._predictedTrajectory; }
  // 積分中に再突入高度を割った/非有限値が出て打ち切られたか。
  private truncated = false;

  // 初期状態と姿勢からエンティティを構築する。scene を渡すと obj を即座にシーンへ追加する。
  constructor(state: KinematicState, obj: THREE.Object3D, scene?: THREE.Scene, att: Attitude = identityAttitude()) {
    this.actualTrajectory = new DynamicTrajectory(state);
    this.att = att;
    this.obj = obj;
    this.scene = scene;
    this.scene?.add(this.obj);
  }

  // center を中心とする接触軌道要素。中心は呼び出し側が選ぶ(例: strongestAttractor)。
  orbitalElementsAround(center: Attractor): OrbitalElements | null {
    if (this._memoState !== this.state || this._memoCenterId !== center.id) {
      this._memoState = this.state;
      this._memoCenterId = center.id;
      this._memoElements = orbitalElementsOf(this.state, center);
    }
    return this._memoElements;
  }

  // 保持窓が keepDuration の列へ積む最小間隔 [s]。その場で最も強く引く天体を中心とする
  // 軌道周期を等分し、窓が長いときは保持サンプル数の上限側で頭打ちにする。
  protected sampleInterval(attractors: readonly Attractor[], state: KinematicState, keepDuration: number): number {
    const period = localOrbitPeriod(state.r, attractors);
    const span = isFinite(period) && period > 0 ? period : C.SHIP_HISTORY_DURATION;
    return Math.max(span / C.TRAJECTORY_SAMPLES_PER_REV, keepDuration / C.PREDICT_MAX_SAMPLES);
  }

  // 全天体重力 + J2 + 大気抵抗 + 自身の推力で 1 ステップ積分する。このステップぶんの重力源は
  // 中点(t + dt/2)で1回だけ引く — attractorsAt は同一時刻の呼び出しを前提にメモ化されて
  // いるので、1ステップの中で別の時刻を引くとメモが効かなくなる。historyDuration が 0
  // (弾・薬莢・破片)の間は間引き間隔を使わないので sampleInterval を評価しない。
  stepActual(dt: number, ephemeris: Ephemeris): void {
    if (!this.alive) return;
    const attractors = ephemeris.attractorsAt(this.state.t + dt / 2);
    const interval = this.historyDuration > 0
      ? this.sampleInterval(attractors, this.state, this.historyDuration)
      : 0;
    this.actualTrajectory.step(dt, attractors, this.bcInv, this.thrust, interval, this.historyDuration);
  }

  // シミュレーションを正確に区切る必要がある次の絶対時刻。寿命など、既知の時刻で
  // 発生するイベントを持たないエンティティは null を返す。
  nextSimulationEventTime(_simTime: number): number | null {
    return null;
  }

  // 予測列を破棄する。
  invalidatePrediction(): void {
    this._predictedTrajectory = null;
  }

  // 実状態との位置ずれが許容量を超えていたら予測列を破棄する。破棄したら true。
  // attractors は simTime の重力源一覧、horizon は予測している長さ [s]。
  resyncPrediction(simTime: number, attractors: readonly Attractor[], horizon: number): boolean {
    if (this._predictedTrajectory === null) return false;
    const predictedState = this._predictedTrajectory.at(simTime);
    if (predictedState !== null
      && len(sub(predictedState.r, this.state.r)) <= this.resyncTolerance(attractors, horizon)) {
      return false;
    }
    this.invalidatePrediction();
    return true;
  }

  // 乖離判定の許容量 [m]。保持サンプル数の上限で間引きが粗くなると at() の補間そのものが
  // 誤差を持つので、その誤差(間引き間隔の4乗に比例)まで許容量を広げる — 広げないと、
  // 実状態と一致している列を毎フレーム破棄して予測が永久に完成しなくなる。
  private resyncTolerance(attractors: readonly Attractor[], horizon: number): number {
    const period = localOrbitPeriod(this.state.r, attractors);
    const span = isFinite(period) && period > 0 ? period : C.SHIP_HISTORY_DURATION;
    const coarsening = Math.max(1, (horizon / C.PREDICT_MAX_SAMPLES) / (span / C.TRAJECTORY_SAMPLES_PER_REV));
    return Math.max(C.PREDICT_RESET_DIST, C.PREDICT_SAMPLE_ERROR * coarsening ** 4);
  }

  // 予測列の先端を、呼び出し側が確定させた重力源 attractors のもとで dt ぶん1ステップ伸ばす。
  // horizon は simTime から先に予測する長さ [s]。伸ばせなかったら false。
  stepPredicted(attractors: readonly Attractor[], simTime: number, dt: number, horizon: number): boolean {
    if (!this.predictsFuture) return false;
    // 自由飛行前提の予測は噴射中に成立しないので、推力がかかっている間は伸ばさない。
    if (this.thrust !== null) return false;
    if (this._predictedTrajectory === null) {
      this._predictedTrajectory = new DynamicTrajectory(this.actualTrajectory.state);
      this.truncated = false;
    }
    if (this.truncated) return false;
    const p = this._predictedTrajectory;

    // ホライズン時刻ちょうどを at() で引けるよう、先端は必ずホライズンを1ステップぶん
    // 越えたところまで伸ばす。
    if (p.state.t > simTime + horizon) return false;

    p.step(dt, attractors, this.bcInv, null, this.sampleInterval(attractors, p.state, horizon), horizon);

    // 有限チェック
    const { r, v } = p.state;
    const finite = Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
      && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    if (!finite || hitCelestialBody(r, attractors, C.REENTRY_ALT)) this.truncated = true;

    return true;
  }

  // 表示時刻 t の状態。予測を持たない/予測期間を超えた時刻は null。
  displayState(t: number): KinematicState | null {
    return t <= this.actualTrajectory.state.t ? this.actualTrajectory.at(t) : (this._predictedTrajectory?.at(t) ?? null);
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

  // playerPos は「自機からの距離」で消える種別(弾)のために一律で渡す。attractors はその
  // 時刻の重力源一覧(表面到達判定に使う)。
  checkLoss(_dt: number, _simTime: number, _activeStage: Stage, _playerPos: Vec3, attractors: readonly Attractor[]): void {
    if (!this.alive) return;
    if (hitCelestialBody(this.state.r, attractors, C.DEBRIS_REENTRY_ALT)) this.alive = false;
  }

  // メッシュを scene から取り除く。
  dispose(): void {
    this.scene?.remove(this.obj);
  }
}
