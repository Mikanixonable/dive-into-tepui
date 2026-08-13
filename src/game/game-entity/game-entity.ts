// ゲーム内エンティティの定義。位置・速度は ECI 座標系 [m, m/s]。
import * as THREE from 'three/webgpu';
import { KinematicState } from '../../physics/kinematic-state';
import { OrbitalElements, keplerPeriod } from '../../physics/elements';
import { Attitude } from '../../physics/attitude';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import { StateQueue } from '../../physics/state-queue';
import { Attractor, Degree2Gravity, orbitalElementsOf, localOrbitPeriod, reachedBody, strongestAttractor } from '../../physics/attractor';
import { containingBody } from '../../physics/sphere-contact';
import { isBurnedUp } from '../../physics/atmosphere';
import { Vec3, len, sub, v3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import { OrbitLine, OrbitLineExcludeNearBody } from '../orbit-line';
import { TrajectoryLine } from '../trajectory-line';
import { ReferenceFrame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import * as C from '../const';
import type { Stage } from '../stages/stage';
import type { Contact } from '../simulation/contact';
import { EntityIdAllocator } from './entity-id';
import { EquatorNodeMarkerPair } from '../marker/equator-node-marker-pair';
import type { MarkerManager } from '../marker/marker-manager';
import { GRAVITATIONAL_CONSTANT } from '../../physics/solar-system';

// 乖離許容量の上限。その場の局所軌道の長半径に対する割合 [無次元]。
const DIVERGENCE_TOLERANCE_MAX_ORBIT_RATIO = 0.02;

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

  // 一意な識別子。表示名(name)とは別の概念。
  readonly id: string;
  // マーカー・一覧・ウィンドウに出す表示名。既定は id で、名前を持つ種別がコンストラクタで上書きする。
  name: string;
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
  // 自身の軌道楕円を描く線。null = 持たない。
  orbitLine: OrbitLine | null = null;
  // 自身の予測軌道を描く線。null = 持たない。
  trajectoryLine: TrajectoryLine | null = null;
  // 自身の軌道と中心天体の赤道面との交点マーカー。null = まだ出す必要が生じていない。
  equatorNodes: EquatorNodeMarkerPair | null = null;
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
  // 積分中に再突入高度を割った/非有限値が出て打ち切られたか。打ち切られた列はそれ以上
  // 伸びない(新しい列を作るまで恒久的)。
  private truncated = false;
  get predictionTruncated(): boolean { return this.truncated; }

  // 初期状態と姿勢からエンティティを構築する。scene を渡すと obj を即座にシーンへ追加する。
  // id 省略時はこの基底が自動採番する(復元 id を渡すクラスはそれをそのまま通す)。addToScene
  // を false にすると obj をシーンへ足さない — InstancedPool 経由で描画する種別(弾・薬莢)が
  // 使う。obj 自体は sync が書き込む変換の置き場所として残る。
  constructor(
    state: KinematicState,
    obj: THREE.Object3D,
    scene?: THREE.Scene,
    att: Attitude = identityAttitude(),
    id?: string,
    addToScene = true,
  ) {
    this.actualTrajectory = new DynamicTrajectory(state);
    this.id = id ?? GameEntity.idAllocator.next();
    this.name = this.id;
    this.att = att;
    this.obj = obj;
    this.scene = scene;
    if (addToScene) this.scene?.add(this.obj);
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

  // orbitLine を、現在位置で最も強く引く天体を中心とする軌道楕円に合わせる。
  // show が false のときは非表示にする。force/excludeNearBody は OrbitLine.sync へそのまま渡す。
  syncOrbitLine(
    show: boolean, fo: FloatingOrigin, camera: THREE.Camera, attractors: readonly Attractor[],
    force = false, excludeNearBody?: OrbitLineExcludeNearBody,
  ): void {
    if (this.orbitLine === null) return;
    const center = strongestAttractor(this.state.r, attractors);
    this.orbitLine.sync(show ? this.orbitalElementsAround(center) : null, fo, camera, force, excludeNearBody);
  }

  // trajectoryLine を、現在時刻以降の predictedTrajectory に合わせる(線の先頭が常に現在位置に
  // 一致するようにする)。show が false のときは非表示にする。
  syncTrajectoryLine(
    show: boolean, frame: ReferenceFrame, simTime: number, ephemeris: Ephemeris, fo: FloatingOrigin,
    camera: THREE.Camera, attractors: readonly Attractor[],
  ): void {
    if (this.trajectoryLine === null) return;
    this.trajectoryLine.syncGeometry(
      show ? this.predictedTrajectory : null, simTime, null, frame, ephemeris, attractors,
    );
    this.trajectoryLine.syncTransform(frame, simTime, ephemeris, fo, attractors);
    this.trajectoryLine.sync(camera);
  }

  // 自分の解析楕円(orbitLine)をこの予測軌道線で隠してよいかを返す。マップビューでは楕円が
  // 表示期間 [simTime, simTime + horizon] 全体の代替を担うため、予測がそこまで覆っている
  // (天体貫入などで打ち切られ、以後伸びない場合も含む)ときだけ隠す。戦闘ビューには表示期間を
  // 見せるという用途がなく、予測線が描かれてさえいれば解析楕円と並んで見える方が誤読を招くので、
  // 覆っているかを問わず隠す。
  supersedesAnalyticEllipse(simTime: number, horizon: number, overviewMode: boolean): boolean {
    const line = this.trajectoryLine;
    if (!line || !line.visible) return false;
    if (!overviewMode) return true;
    if (this.predictionTruncated) return true;
    const tip = this.predictedTrajectory?.state.t;
    return tip !== undefined && tip >= simTime + horizon;
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
    this.actualTrajectory.step(dt, attractors, this.bcInv, this.srpCoeff, this.thrust, interval, this.historyDuration);
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
  // attractors は simTime の重力源一覧。
  discardPredictionIfDiverged(simTime: number, attractors: readonly Attractor[]): boolean {
    if (this._predictedTrajectory === null) return false;
    const predictedState = this._predictedTrajectory.at(simTime);
    if (predictedState !== null
      && len(sub(predictedState.r, this.state.r)) <= this.divergenceTolerance(attractors)) {
      return false;
    }
    this.invalidatePrediction();
    return true;
  }

  // 乖離判定の許容量 [m]。間引きが粗い列では at() の補間そのものが誤差を持つので、その誤差
  // (間引き間隔の4乗に比例)まで許容量を広げる — 広げないと、実状態と一致している列を
  // 毎フレーム破棄して予測が永久に完成しなくなる。粗さは列自身が記録している値から取る:
  // 現在の表示期間から導くと、表示期間を短く切り替えた瞬間に、粗い間隔で積まれた既存の列に
  // 対して閾値だけが縮み、正しい列を破棄し続けることになる。
  // coarsening^4 は粗い列で発散するので、その場の局所軌道の長半径に対する一定割合で頭打ちに
  // する — 距離を基準にすると、惑星間で最強重力源が恒星になった途端に上限が実質無くなる。
  // 下限の PREDICT_RESET_DIST は、小さな天体のすぐ近くで割合の上限自体が補間誤差を下回り、
  // 頭打ちが逆に永久破棄を招くのを防ぐ。
  private divergenceTolerance(attractors: readonly Attractor[]): number {
    const center = strongestAttractor(this.state.r, attractors);
    const period = keplerPeriod(len(sub(this.state.r, center.state.r)), center.mu);
    const span = isFinite(period) && period > 0 ? period : C.SHIP_HISTORY_DURATION;
    const interval = this._predictedTrajectory?.sampleInterval ?? 0;
    const coarsening = Math.max(1, interval / (span / C.TRAJECTORY_SAMPLES_PER_REV));
    const raw = C.PREDICT_SAMPLE_ERROR * coarsening ** 4;
    // 局所軌道周期に対応する長半径(ケプラー第三法則)。中心天体の μ が取れなければ
    // 中心からの距離で代用する。
    const orbitScale = center.mu > 0 && isFinite(span)
      ? (center.mu * (span / (2 * Math.PI)) ** 2) ** (1 / 3)
      : len(sub(this.state.r, center.state.r));
    return Math.max(C.PREDICT_RESET_DIST, Math.min(raw, orbitScale * DIVERGENCE_TOLERANCE_MAX_ORBIT_RATIO));
  }

  // 予測列の先端を、呼び出し側が確定させた重力源 attractors のもとで dt ぶん1ステップ伸ばす。
  // horizon は simTime から先に予測する長さ [s]。伸ばせなかったら false。
  stepPredicted(attractors: readonly Attractor[], simTime: number, dt: number, horizon: number): boolean {
    if (!this.predictsFuture) return false;
    if (this._predictedTrajectory === null) {
      this._predictedTrajectory = new DynamicTrajectory(this.actualTrajectory.state);
      this.truncated = false;
    }
    if (this.truncated) return false;
    const p = this._predictedTrajectory;

    // 先端が既にホライズンへ達していたら、それ以上は伸ばさない。
    if (p.state.t >= simTime + horizon) return false;

    p.step(dt, attractors, this.bcInv, this.srpCoeff, null, this.sampleInterval(attractors, p.state, horizon), horizon);

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
    if (reachedBody(this.actualTrajectory.prevState, this.state, attractors, 0) !== null
      || isBurnedUp(this.state.r, attractors, C.DEBRIS_REENTRY_ALT)) this.alive = false;
  }

  // 自分がこの相手と接触しうるか。既定 true。両側が true を返したときだけ接触する。
  contactsWith(_other: GameEntity | Attractor, _simTime: number): boolean {
    return true;
  }

  // この接触で自分に何が起きるかを記述する。相手に何が起きるかは書かない(相手の
  // collideWith が書く)。既定は何もしない。
  collideWith(_other: GameEntity | Attractor, _contact: Contact, _activeStage: Stage): void {}

  // 赤道交点マーカーを用意して返す。出す必要が生じた側が呼ぶ。
  ensureEquatorNodes(markerManager: MarkerManager): EquatorNodeMarkerPair {
    return this.equatorNodes ??= new EquatorNodeMarkerPair(this, markerManager);
  }

  // メッシュを scene から、マーカーを HUD から取り除く。
  dispose(): void {
    this.scene?.remove(this.obj);
    this.equatorNodes?.dispose();
  }
}
