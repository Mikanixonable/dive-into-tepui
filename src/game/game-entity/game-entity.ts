// ゲーム内エンティティの定義。位置・速度は ECI 座標系 [m, m/s]。
import * as THREE from 'three/webgpu';
import { KinematicState } from '../../physics/kinematic-state';
import { OrbitalElements, keplerPeriod } from '../../physics/elements';
import { Attitude } from '../../physics/attitude';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import { Attractor, Degree2Gravity, orbitalElementsOf, localOrbitPeriod, reachedBody, strongestAttractor } from '../../physics/attractor';
import { containingBody } from '../../physics/sphere-contact';
import { isBurnedUp } from '../../physics/atmosphere';
import { Vec3, len, sub, v3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import { OrbitLine } from '../orbit-line';
import { TrajectoryLine } from '../trajectory-line';
import { LineStyle } from '../../render/line-style';
import { ReferenceFrame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import * as C from '../const';
import type { Stage } from '../stages/stage';
import type { Contact } from '../simulation/contact';
import { EntityIdAllocator } from './entity-id';
import { EquatorNodeMarkerPair } from '../marker/equator-node-marker-pair';
import type { EntityMarker } from '../marker/entity-marker';
import type { MarkerManager } from '../marker/marker-manager';
import { GRAVITATIONAL_CONSTANT } from '../../physics/solar-system';

// 乖離許容量の上限。その場の局所軌道の長半径に対する割合 [無次元]。
const DIVERGENCE_TOLERANCE_MAX_ORBIT_RATIO = 0.02;

const identityAttitude = (): Attitude => ({
  q: { x: 0, y: 0, z: 0, w: 1 },
  w: v3(),
  inertia: v3(1, 1, 1),
});

// 軌道上を運動するゲーム内エンティティの基底。表示ルート・HP・生死・姿勢・AI といったゲーム側の
// 付帯情報と、種別ごとの積分パラメータ(bcInv・historyDuration)を持つ。
export class GameEntity {
  readonly actual: DynamicTrajectory;

  get state(): KinematicState { return this.actual.state; }
  // 不連続な差し替え専用の口(剛体接触・反動など)。
  set state(s: KinematicState) { this.actual.reset(s); }
  get prevState(): KinematicState { return this.actual.prevState; }

  private static readonly idAllocator = new EntityIdAllocator('entity-');

  // 一意な識別子。表示名(name)とは別の概念。
  readonly id: string;
  // マーカー・一覧・ウィンドウに出す表示名。既定は id で、名前を持つ種別がコンストラクタで上書きする。
  name: string;
  att: Attitude;
  public readonly renderObject: THREE.Object3D;
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
  predictedLine: TrajectoryLine | null = null;
  // 過去に通ってきた軌跡の線。持たせるかは種別の判断。
  actualLine: TrajectoryLine | null = null;
  // 自身の軌道と中心天体の赤道面との交点マーカー。null = まだ出す必要が生じていない。
  equatorNodes: EquatorNodeMarkerPair | null = null;
  // 自身の位置を指すマーカー。null = 出さない。
  marker: EntityMarker | null = null;
  // 弾道係数の逆数 Cd·A/m(既定 0 = 抵抗なし)。
  protected readonly bcInv: number = 0;
  protected readonly srpCoeff: number = 0;
  // 過去列の保持時間 [s]。既定 0 = 記録しない。
  // 種別ごとの過去列の保持時間 [s]。0 は履歴を持たない。
  protected readonly baseHistoryDuration: number = 0;
  private requestedHistoryDuration = 0;

  // 実際に保持する過去列の長さ [s]。過去表示の要求(requestHistoryDuration)が種別の既定値より
  // 長ければそちらに従う。保持サンプル数は sampleInterval の間引きにより
  // PREDICT_MAX_SAMPLES で頭打ちなので、長くしてもメモリは有界。
  protected get historyDuration(): number {
    return Math.max(this.baseHistoryDuration, this.requestedHistoryDuration);
  }
  // 未来の状態を引かれる理由。読み手も成り立つ条件も理由ごとに違うので、1つの真偽値へ
  // 畳まずに別々に持つ。予測する長さは表示期間に追従するため、ここで決まるのは可否だけ。

  // 未来位置を重力源として引かれるか。引力を持つなら、予測と計画の積分が未来時刻の
  // この個体を必要とする。
  get predictedAsGravitySource(): boolean {
    return this.mu !== 0;
  }
  // 未来位置を計画軌道の衝突体として引かれるか。剛体接触への参加(collides)とは別の判断
  // で、こちらは「数分から数日先まで伸びる線が相手にするだけの寿命を持つか」を言う。
  protected readonly predictedAsPlanCollider: boolean = false;
  // 表示時刻(未来ゴースト)の位置でメッシュとマーカーを描く種別か。
  protected readonly predictedForGhost: boolean = false;

  // 予測列を伸ばす種別か。上の理由のどれか1つでも立てば伸ばす。
  get predictsFuture(): boolean {
    return this.predictedAsGravitySource || this.predictedAsPlanCollider
      || this.predictedForGhost || this.predictedLine !== null;
  }
  protected readonly scene?: THREE.Scene;

  // 未来の予測列。
  private _predicted: DynamicTrajectory | null = null;
  get predicted(): DynamicTrajectory | null { return this._predicted; }
  // 積分中に再突入高度を割った/非有限値が出て打ち切られたか。打ち切られた列はそれ以上
  // 伸びない(新しい列を作るまで恒久的)。
  private truncated = false;
  get predictionTruncated(): boolean { return this.truncated; }

  // 初期状態と姿勢からエンティティを構築する。addToScene は renderObject を scene へ
  // 直接登録する種別に指定し、インスタンス描画種別では同期用の変換として保持する。
  // id 省略時はこの基底が自動採番する。
  public constructor(
    state: KinematicState,
    renderObject: THREE.Object3D,
    scene?: THREE.Scene,
    att: Attitude = identityAttitude(),
    id?: string,
    addToScene = true,
  ) {
    this.actual = new DynamicTrajectory(state);
    this.id = id ?? GameEntity.idAllocator.next();
    this.name = this.id;
    this.att = att;
    this.renderObject = renderObject;
    this.scene = scene;
    if (addToScene) this.scene?.add(this.renderObject);
  }

  // 質量から剛体接触の換算質量と重力定数 μ を同時に定める。別々に書くと引力の強さと
  // 衝突の重さが食い違う。
  protected setGravitatingMass(mass: number): void {
    this.mass = mass;
    this.mu = GRAVITATIONAL_CONSTANT * mass;
  }

  // center を中心とする接触軌道要素。中心は呼び出し側が選ぶ(例: strongestAttractor)。
  orbitalElementsAround(center: Attractor): OrbitalElements | null {
    return orbitalElementsOf(this.state, center);
  }

  // 軌道楕円の線を style で出す。既に出ていれば style を塗り直す。
  showOrbitLine(style: LineStyle): void {
    if (this.orbitLine !== null) {
      this.orbitLine.setStyle(style);
      return;
    }
    const line = new OrbitLine(style);
    this.scene?.add(line.line);
    this.orbitLine = line;
  }

  // 軌道楕円の線を消す。出し直すと作り直しになる。
  hideOrbitLine(): void {
    if (this.orbitLine === null) return;
    this.scene?.remove(this.orbitLine.line);
    this.orbitLine.dispose();
    this.orbitLine = null;
  }

  // orbitLine を現在位置で最も強く引く天体まわりの軌道楕円に合わせる。線を持たなければ何もしない。
  // frame / displayTime / ephemeris を渡すと、その座標系・時刻で楕円を描く。
  syncOrbitLine(
    fo: FloatingOrigin, camera: THREE.Camera, attractors: readonly Attractor[], force = false,
    frame?: ReferenceFrame, displayTime?: number, ephemeris?: Ephemeris,
  ): void {
    if (this.orbitLine === null) return;
    const center = strongestAttractor(this.state.r, attractors);
    this.orbitLine.sync(
      this.orbitalElementsAround(center), fo, camera, force, frame, displayTime, ephemeris, attractors,
    );
  }

  // 予測線を style で出す。既に出ていれば style を塗り直す。
  showPredictedLine(style: LineStyle): void {
    if (this.predictedLine !== null) {
      this.predictedLine.setStyle(style);
      return;
    }
    const line = new TrajectoryLine(style);
    this.scene?.add(line.line);
    this.predictedLine = line;
  }

  // 予測線を消す。出し直すと作り直しになる。
  hidePredictedLine(): void {
    if (this.predictedLine === null) return;
    this.scene?.remove(this.predictedLine.line);
    this.predictedLine.dispose();
    this.predictedLine = null;
  }

  // 実軌道の過去線を style で出す。既に出ていれば style を塗り直す。
  showActualLine(style: LineStyle): void {
    if (this.actualLine !== null) {
      this.actualLine.setStyle(style);
      return;
    }
    const line = new TrajectoryLine(style);
    this.scene?.add(line.line);
    this.actualLine = line;
  }

  // 実軌道の過去線を消す。
  hideActualLine(): void {
    if (this.actualLine === null) return;
    this.scene?.remove(this.actualLine.line);
    this.actualLine.dispose();
    this.actualLine = null;
  }

  // predictedLine を [simTime, predictedTo] の predicted に、actualLine を
  // [simTime - pastDuration, simTime] の actual に合わせる(未来線の先頭と過去線の
  // 末尾が常に現在位置で接するようにする)。predictedTo に null を渡すと未来線を先端で止める。
  // simTime は描く区間の境目、displayTime は座標系から慣性系へ戻す時刻。
  syncTrajectoryLines(
    frame: ReferenceFrame, simTime: number, displayTime: number, pastDuration: number, predictedTo: number | null,
    ephemeris: Ephemeris, fo: FloatingOrigin, camera: THREE.Camera, attractors: readonly Attractor[],
  ): void {
    if (this.predictedLine !== null) {
      this.predictedLine.syncGeometry(this.predicted, simTime, predictedTo, frame, ephemeris, attractors);
      this.predictedLine.syncTransform(frame, displayTime, ephemeris, fo, attractors);
      this.predictedLine.sync(camera);
    }
    if (this.actualLine !== null) {
      this.actualLine.syncGeometry(
        this.actual, simTime - pastDuration, simTime, frame, ephemeris, attractors,
      );
      this.actualLine.syncTransform(frame, displayTime, ephemeris, fo, attractors);
      this.actualLine.sync(camera);
    }
  }

  // 過去表示に必要な履歴の保持時間 [s] を要求する。履歴を持たない種別(弾・薬莢・破片)は
  // 無視する。実際の保持時間は種別ごとの既定値との大きい方。
  requestHistoryDuration(sec: number): void {
    if (this.baseHistoryDuration <= 0) return;
    this.requestedHistoryDuration = Math.max(0, Math.min(C.HISTORY_DURATION_MAX, sec));
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
    this.actual.step(dt, attractors, this.bcInv, this.srpCoeff, this.thrust, interval, this.historyDuration);
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
  // attractors は simTime の重力源一覧。
  discardPredictionIfDiverged(simTime: number, attractors: readonly Attractor[]): boolean {
    if (this._predicted === null) return false;
    const predictedState = this._predicted.at(simTime);
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
    const interval = this._predicted?.sampleInterval ?? 0;
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
  // horizon は simTime から先に予測する長さ [s]。extrapolationCenter は先端位置で最も強く引く
  // 解析天体(外挿用、省略時 null)。伸ばせなかったら false。
  stepPredicted(
    attractors: readonly Attractor[], simTime: number, dt: number, horizon: number,
    extrapolationCenter: Attractor | null = null,
  ): boolean {
    if (!this.predictsFuture) return false;
    if (this._predicted === null) {
      this._predicted = new DynamicTrajectory(this.actual.state);
      this.truncated = false;
    }
    if (this.truncated) return false;
    const p = this._predicted;

    // 先端が既にホライズンへ達していたら、それ以上は伸ばさない。
    if (p.state.t >= simTime + horizon) return false;

    p.step(
      dt, attractors, this.bcInv, this.srpCoeff, null,
      this.sampleInterval(attractors, p.state, horizon), horizon, extrapolationCenter,
    );

    // 有限チェック
    const { r, v } = p.state;
    const finite = Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
      && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    if (!finite || containingBody(r, attractors, 0) !== null || isBurnedUp(r, attractors, C.REENTRY_ALT)) this.truncated = true;

    return true;
  }

  // 表示時刻 t の状態。予測を持たない/予測期間を超えた時刻は null。ephemeris を渡すと、
  // 予測列で答えられない未来時刻を、先端を中心天体まわりの二体軌道とみなして外挿した値で
  // 答える(外挿もできなければ null)。
  displayState(t: number, ephemeris?: Ephemeris): KinematicState | null {
    if (t <= this.actual.state.t) return this.actual.at(t);
    const predicted = this._predicted;
    const normal = predicted?.at(t) ?? null;
    if (normal !== null || ephemeris === undefined) return normal;
    if (predicted === null || this.truncated || predicted.extrapolationCenter === null) return null;
    return predicted.extrapolatedAt(t, ephemeris.stateOf(predicted.extrapolationCenter.id, t));
  }

  // displayTime の描画位置・姿勢を fo 経由でメッシュへ同期する。
  sync(fo: FloatingOrigin, displayTime: number): void {
    const s = this.displayState(displayTime);
    if (s === null) {
      this.renderObject.visible = false;
      return;
    }
    this.renderObject.visible = true;
    this.renderObject.position.copy(fo.RtoThreeV3(s.r));
    this.renderObject.quaternion.set(this.att.q.x, this.att.q.y, this.att.q.z, this.att.q.w);
  }

  // playerPos は「自機からの距離」で消える種別(弾)のために一律で渡す。attractors はその
  // 時刻の重力源一覧(表面到達判定に使う)。
  checkLoss(_dt: number, _simTime: number, _activeStage: Stage, _playerPos: Vec3, attractors: readonly Attractor[]): void {
    if (!this.alive) return;
    if (reachedBody(this.actual.prevState, this.state, attractors, 0) !== null
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

  // メッシュを scene から、マーカーを HUD から取り除く。配下メッシュのジオメトリ・マテリアルも
  // 解放するが、共有資源を巻き添えにしないよう所有権フラグが立つものだけを対象にする。
  dispose(): void {
    this.scene?.remove(this.renderObject);
    this.equatorNodes?.dispose();
    this.marker?.dispose();
    this.hideOrbitLine();
    this.hidePredictedLine();
    this.hideActualLine();
    this.renderObject.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.userData.ownsGeometry && mesh.geometry) {
        mesh.geometry.dispose();
      }
      if (mesh.userData.ownsMaterial && mesh.material) {
        if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
        else mesh.material.dispose();
      }
    });
  }
}
