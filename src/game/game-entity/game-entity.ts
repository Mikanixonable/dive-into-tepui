// ゲーム内エンティティの定義。位置・速度は ECI 座標系 [m, m/s]。
import * as THREE from 'three/webgpu';
import { KinematicState } from '../../physics/kinematic-state';
import { OrbitalElements } from '../../physics/elements';
import { Attitude } from '../../physics/attitude';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import { StateQueue } from '../../physics/state-queue';
import { Attractor, Degree2Gravity, orbitalElementsOf, localOrbitPeriod } from '../../physics/attractor';
import { containingBody } from '../../physics/sphere-contact';
import { isBurnedUp } from '../../physics/atmosphere';
import { Vec3, len, sub, v3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import type { Stage } from '../stages/stage';
import type { Contact } from '../simulation/contact';
import { EntityIdAllocator } from './entity-id';
import { GRAVITATIONAL_CONSTANT } from '../../physics/solar-system';

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
  private _memoCenterId: string | null = null;
  private _memoElements: OrbitalElements | null = null;

  private static readonly idAllocator = new EntityIdAllocator('entity-');

  // 一意な識別子。表示名(Ship.name/Player.displayName)とは別の概念。
  readonly id: string;
  att: Attitude;
  obj: THREE.Object3D;
  alive = true;
  mass = 1; // 剛体接触の換算質量
  radius = 0; // 物理的な半径 [m]。0 = 点。Attractor.radius と同じ量
  collides = false; // 剛体接触(ContactPhysics)に参加するか
  // 特定の艦に取り付いた実体(ベルトの節点・放熱板の折りなど)であれば、その艦自身。
  // 独立した実体なら既定 null。
  attachedTo: GameEntity | null = null;
  // 重力定数 GM [m^3/s^2]。0 = 重力を及ぼさない
  mu = 0;
  // 自身が及ぼす二次重力項(J2/C22 等)。null = 質点として扱う
  degree2: Degree2Gravity | null = null;
  isStar = false;
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
  private _predictedTrajectory: DynamicTrajectory | null = null;
  get predictedTrajectory(): DynamicTrajectory | null { return this._predictedTrajectory; }
  // 積分中に再突入高度を割った/非有限値が出て打ち切られたか。
  private truncated = false;

  // 初期状態と姿勢からエンティティを構築する。scene を渡すと obj を即座にシーンへ追加する。
  // id 省略時はこの基底が自動採番する(復元 id を渡すクラスはそれをそのまま通す)。
  constructor(state: KinematicState, obj: THREE.Object3D, scene?: THREE.Scene, att: Attitude = identityAttitude(), id?: string) {
    this.actualTrajectory = new DynamicTrajectory(state);
    this.id = id ?? GameEntity.idAllocator.next();
    this.att = att;
    this.obj = obj;
    this.scene = scene;
    this.scene?.add(this.obj);
  }

  // 質量から剛体接触の換算質量と重力定数 μ を同時に定める。別々に書くと引力の強さと
  // 衝突の重さが食い違う。
  protected setGravitatingMass(mass: number): void {
    this.mass = mass;
    this.mu = GRAVITATIONAL_CONSTANT * mass;
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

  // 重力源 + J2 + 大気抵抗 + 自身の推力で 1 ステップ積分する。attractors はこのステップの
  // 重力源一覧 — 呼び出し側(Simulator)が全エンティティで同じ瞬間の同じ配列を使い回す。
  // historyDuration が 0(弾・薬莢・破片)の間は間引き間隔を使わないので sampleInterval を
  // 評価しない。
  stepActual(dt: number, attractors: readonly Attractor[]): void {
    if (!this.alive) return;
    const interval = this.historyDuration > 0
      ? this.sampleInterval(attractors, this.state, this.historyDuration)
      : 0;
    this.actualTrajectory.step(dt, attractors, this.bcInv, this.srpCoeff, C.SHADOW_PENUMBRA, this.thrust, interval, this.historyDuration);
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

    p.step(dt, attractors, this.bcInv, this.srpCoeff, C.SHADOW_PENUMBRA, null, this.sampleInterval(attractors, p.state, horizon), horizon);

    // 有限チェック
    const { r, v } = p.state;
    const finite = Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
      && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    if (!finite || containingBody(r, attractors, 0) !== null || isBurnedUp(r, attractors, C.REENTRY_ALT)) this.truncated = true;

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
    if (containingBody(this.state.r, attractors, 0) !== null
      || isBurnedUp(this.state.r, attractors, C.DEBRIS_REENTRY_ALT)) this.alive = false;
  }

  // 自分がこの相手と接触しうるか。既定 true。両側が true を返したときだけ接触する。
  contactsWith(_other: GameEntity | Attractor, _simTime: number): boolean {
    return true;
  }

  // この接触で自分に何が起きるかを記述する。相手に何が起きるかは書かない(相手の
  // collideWith が書く)。既定は何もしない。
  collideWith(_other: GameEntity | Attractor, _contact: Contact, _activeStage: Stage): void {}

  // メッシュを scene から取り除く。
  dispose(): void {
    this.scene?.remove(this.obj);
  }
}
