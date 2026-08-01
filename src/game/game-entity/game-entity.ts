// ゲーム内エンティティの定義。位置・速度は ECI 座標系 [m, m/s]。
import * as THREE from 'three/webgpu';
import { altitudeOf, Elements, OrbitState } from '../../physics/orbital';
import { Attitude } from '../../physics/attitude';
import { OrbitEntity } from '../../physics/orbit-entity';
import { StateQueue } from '../../physics/state-queue';
import type { Ephemeris } from '../../physics/ephemeris';
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
  get elements(): Elements | null { return this.current.elements; }

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
  // 予測する未来の長さ [s]。既定 0 = 予測しない。
  readonly predictDuration: number = 0;
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

  // 過去列へ積む最小間隔 [s]。
  protected sampleInterval(): number {
    const period = this.elements?.period;
    if (period !== undefined && period !== null && isFinite(period) && period > 0) {
      return period / C.PREDICT_SAMPLES_PER_REV;
    }
    return C.SHIP_HISTORY_DURATION / C.PREDICT_SAMPLES_PER_REV;
  }

  // 中心重力 + 環境加速度(大気抵抗・J2・第三体摂動)+ 自身の推力で 1 ステップ積分する。
  stepSim(dt: number, ephemeris: Ephemeris): void {
    if (!this.alive) return;
    this.current.step(dt, ephemeris, this.bcInv, this.thrust, this.sampleInterval(), this.historyDuration);
  }

  // 予測列を破棄する。
  invalidatePrediction(): void {
    this._predicted = null;
  }

  // 実状態との位置ずれが tolerance を超えていたら予測列を破棄する。
  resyncPrediction(simTime: number, tolerance: number): void {
    if (this._predicted === null) return;
    const predictedState = this._predicted.at(simTime);
    if (predictedState === null || len(sub(predictedState.r, this.state.r)) > tolerance) {
      this.invalidatePrediction();
    }
  }

  // 予測列の先端を dt ぶん1ステップ伸ばす。伸ばせなかったら false。
  stepPrediction(ephemeris: Ephemeris, simTime: number, dt: number): boolean {
    if (this.predictDuration <= 0) return false;
    // 自由飛行前提の予測は噴射中に成立しないので、推力がかかっている間は伸ばさない。
    if (this.thrust !== null) return false;
    if (this._predicted === null) {
      this._predicted = new OrbitEntity(this.current.state);
      this.truncated = false;
    }
    if (this.truncated) return false;
    const p = this._predicted;
    if (p.state.t + dt > simTime + this.predictDuration + 1e-6) return false;

    p.step(dt, ephemeris, this.bcInv, null, this.sampleInterval(), this.predictDuration);

    // 有限チェック
    const { r, v } = p.state;
    const finite = Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
      && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    if (!finite || altitudeOf(r) < C.REENTRY_ALT) this.truncated = true;

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

  // playerPos は「自機からの距離」で消える種別(弾)のために一律で渡す。
  checkLoss(_dt: number, _simTime: number, _activeStage: Stage, _playerPos: Vec3): void {
    if (!this.alive) return;
    if (altitudeOf(this.state.r) < C.DEBRIS_REENTRY_ALT) this.alive = false;
  }

  // メッシュを scene から取り除く。
  dispose(): void {
    this.scene?.remove(this.obj);
  }
}
