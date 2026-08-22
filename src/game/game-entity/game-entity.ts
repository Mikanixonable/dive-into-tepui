// ゲーム内エンティティの定義。位置・速度は ECI 座標系 [m, m/s]。
import * as THREE from 'three/webgpu';
import { KinematicState } from '../../physics/kinematic-state';
import { OrbitalElements } from '../../physics/elements';
import { Attitude } from '../../physics/attitude';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import { CelestialBody, orbitalElementsOf, localOrbitPeriod, strongestAttractor } from '../../physics/celestial-body';
import { burnUpBody } from '../../physics/atmosphere';
import { ApsisTrack } from '../../physics/trajectory-features';
import { Vec3, v3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import { OrbitLine } from '../orbit-line';
import { TrajectoryLine } from '../trajectory-line';
import { LineStyle } from '../../render/line-style';
import { FrameAnchorSource, ReferenceFrame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { PredictedArc, trajectorySampleInterval } from '../simulation/predicted-arc';
import type { FutureCelestialBodyProvider } from '../simulation/arc-bodies';
import * as C from '../const';
import type { Stage } from '../stages/stage';
import type { Contact } from './contact';
import { EntityIdAllocator } from './entity-id';
import { EquatorNodeMarkerPair } from '../marker/equator-node-marker-pair';
import type { EntityMarker } from '../marker/entity-marker';
import type { MarkerManager } from '../marker/marker-manager';

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
  // 不連続な差し替え専用の口(剛体接触・反動など)。差し替え前の軌道を表す弧はもう
  // 現実を表さないので、この場で無効化する。
  set state(s: KinematicState) { this.actual.reset(s); this.invalidatePrediction(); }
  get prevState(): KinematicState { return this.actual.prevState; }

  private static readonly idAllocator = new EntityIdAllocator('entity-');

  // 一意な識別子。表示名(name)とは別の概念。
  readonly id: string;
  // マーカー・一覧・ウィンドウに出す表示名。既定は id で、名前を持つ種別がコンストラクタで上書きする。
  name: string;
  att: Attitude;
  // 姿勢を積分する種別か。false の個体は att を進めず、向きを別の規則で決める
  // (弾は速度方向を向く)。
  readonly hasAttitude: boolean = true;
  public readonly renderObject: THREE.Object3D;
  alive = true;
  mass = 1; // 剛体接触の換算質量
  radius = 0; // 物理的な半径 [m]。0 = 点。CelestialBody.radius と同じ量
  collides = false; // 物体どうしの剛体接触(EntityContactPhysics)に参加するか
  // 濃い大気の中を、抗力が要求する細かい刻みで積むか。true の個体はサブステップの内側で
  // さらに分割され、熱・動圧と天体表面への到達もその刻みで解かれる。false の個体は大気圏に
  // 入れば失われるだけで、いつどれだけの精度で失われるかは結果を変えない。
  doPreciseReentry = false;
  // 自分に触れた相手が受けるダメージへ掛かる重み。0 なら触れても相手を傷つけない。
  contactDamageWeight = 1;

  // 剛体接触で反作用を受け持つ質量 [kg]。0 なら相手に力を及ぼさず自分だけが跳ね返り、
  // 無限大なら押されない。
  get contactMass(): number { return this.mass; }
  // 特定の艦に取り付いた実体(ベルトの節点・放熱板の折りなど)であれば、その艦自身。
  // 独立した実体なら既定 null。
  attachedTo: GameEntity | null = null;
  private _thrust: Vec3 | null = null;
  // 自身が出している ECI 加速度 [m/s²]。null = 噴射していない。噴射している間の弧は現実を
  // 表さないので、非 null を書いた時点で無効化する — 実シミュレーションはそこから積分へ落ち、
  // 次の Predictor がその時点の実状態を種に弧を作り直す。
  get thrust(): Vec3 | null { return this._thrust; }
  set thrust(t: Vec3 | null) {
    this._thrust = t;
    if (t !== null) this.invalidatePrediction();
  }
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
  // 弾道係数の逆数 Cd·A/m(既定 0 = 抵抗なし)。抗力が要求する刻みを外から引けるよう公開する。
  readonly bcInv: number = 0;
  protected readonly srpCoeff: number = 0;
  // 焼失せずに耐えられる大気密度の上限 [kg/m^3]。熱シミュレーションを持たない種別が
  // 加熱と動圧をまとめて代理する粗い近似(const.ts)。既定は破片・薬莢・弾・基地・弾薬の値。
  protected readonly burnUpDensity: number = C.DEBRIS_BURNUP_DENSITY;
  // 過去列の保持時間 [s]。既定 0 = 記録しない。
  // 種別ごとの過去列の保持時間 [s]。0 は履歴を持たない。
  protected readonly baseHistoryDuration: number = 0;
  private requestedHistoryDuration = 0;

  // 実際に保持する過去列の長さ [s]。過去表示の要求(requestHistoryDuration)が種別の既定値より
  // 長ければそちらに従う。保持サンプル数は sampleInterval の間引きにより
  // ARC_MAX_SAMPLES で頭打ちなので、長くしてもメモリは有界。
  protected get historyDuration(): number {
    return Math.max(this.baseHistoryDuration, this.requestedHistoryDuration);
  }
  // 未来の状態を引かれる理由。読み手も成り立つ条件も理由ごとに違うので、1つの真偽値へ
  // 畳まずに別々に持つ。予測する長さは表示期間に追従するため、ここで決まるのは可否だけ。

  // 表示時刻(未来ゴースト)の位置でメッシュとマーカーを描く種別か。
  protected readonly predictedForGhost: boolean = false;

  // この個体の未来を読む消費者がいるか。ゴーストだけは表示時刻が未来へ動けるかに依るので、
  // 動けるかどうかを引数で受け取る。
  hasFutureReader(canDisplayFuture: boolean): boolean {
    return (this.predictedForGhost && canDisplayFuture) || this.predictedLine !== null;
  }

  // 予測列を持ちうる種別か。上の理由のどれか1つでも立ちうれば持つ。
  get predictsFuture(): boolean {
    return this.hasFutureReader(true);
  }

  protected readonly scene?: THREE.Scene;

  // 未来の予測列を保持する統一積分弧(game/simulation/predicted-arc.ts の PredictedArc)。
  private _predictedArc: PredictedArc | null = null;
  // 弧そのもの(素の読み取り専用アクセス)。plan/plan-path.ts がノードの無い末尾区間として
  // 丸ごと借用するために公開する — 生成は ensurePredictedArc の専任のまま。
  get predictedArc(): PredictedArc | null { return this._predictedArc; }
  get predicted(): DynamicTrajectory | null { return this._predictedArc?.trajectory ?? null; }
  // 弧の積分中に見つかった近地点・遠地点。中心天体は弧を作った時点で最も強く引く解析天体に固定する。
  get predictedApsides(): ApsisTrack | null { return this._predictedArc?.apsides ?? null; }
  // 積分中に天体表面へ到達した/非有限値が出て打ち切られたか。打ち切られた弧はそれ以上
  // 伸びない(新しい弧を作るまで恒久的)。
  get predictionTruncated(): boolean { return this._predictedArc?.truncated ?? false; }

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

  // center を中心とする接触軌道要素。中心は呼び出し側が選ぶ(例: strongestAttractor)。
  orbitalElementsAround(center: CelestialBody): OrbitalElements | null {
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
    fo: FloatingOrigin, camera: THREE.Camera, frameAnchors: FrameAnchorSource, force = false,
    frame?: ReferenceFrame, displayTime?: number, ephemeris?: Ephemeris,
  ): void {
    if (this.orbitLine === null) return;
    const center = strongestAttractor(this.state.r, frameAnchors.bodies);
    this.orbitLine.sync(
      this.orbitalElementsAround(center), fo, camera, force, frame, displayTime, ephemeris, frameAnchors,
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
    ephemeris: Ephemeris, fo: FloatingOrigin, camera: THREE.Camera, frameAnchors: FrameAnchorSource,
  ): void {
    if (this.predictedLine !== null) {
      this.predictedLine.syncGeometry(this.predicted, simTime, predictedTo, frame, ephemeris, frameAnchors);
      this.predictedLine.syncTransform(frame, displayTime, ephemeris, fo, frameAnchors);
      this.predictedLine.sync(camera);
    }
    if (this.actualLine !== null) {
      this.actualLine.syncGeometry(
        this.actual, simTime - pastDuration, simTime, frame, ephemeris, frameAnchors,
      );
      this.actualLine.syncTransform(frame, displayTime, ephemeris, fo, frameAnchors);
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
  protected sampleInterval(celestialBodies: readonly CelestialBody[], state: KinematicState, keepDuration: number): number {
    return trajectorySampleInterval(localOrbitPeriod(state.r, celestialBodies), keepDuration);
  }

  // 実状態の履歴へ積む間引き間隔 [s]。履歴を持たない種別は 0。
  private historySampleInterval(celestialBodies: readonly CelestialBody[]): number {
    return this.historyDuration > 0
      ? this.sampleInterval(celestialBodies, this.state, this.historyDuration) : 0;
  }

  // 重力源 + J2 + 大気抵抗 + 自身の推力で 1 ステップ積分する。celestialBodies はこのステップの
  // 重力源一覧、occluders は日照率の遮蔽体一覧 — どちらも呼び出し側(Simulator)が全
  // エンティティで同じ瞬間の同じ配列を使い回す。atmosphereBody は抗力を及ぼすただ1体の
  // 大気天体(null なら抗力なし)。
  stepActual(
    dt: number,
    celestialBodies: readonly CelestialBody[],
    occluders: readonly CelestialBody[],
    atmosphereBody: CelestialBody | null,
  ): void {
    if (!this.alive) return;
    this.actual.step(
      dt, celestialBodies, occluders, atmosphereBody, this.bcInv, this.srpCoeff, this.thrust,
      this.historySampleInterval(celestialBodies), this.historyDuration,
    );
    // 積分した弧はもう現実を表さない。ある時間帯の状態を決める積分を常に1本に保つ。
    this.invalidatePrediction();
  }

  // 直前の stepActual と同じ区間ぶん、位置と姿勢から決まる受動的な環境(熱・電力など)を
  // 進める。既定では持たない。bodies はその区間の天体窓。
  stepEnvironment(
    _dt: number, _ephemeris: Ephemeris, _simTime: number, _bodies: readonly CelestialBody[],
  ): void {
  }

  // シミュレーションを正確に区切る必要がある次の絶対時刻。寿命など、既知の時刻で
  // 発生するイベントを持たないエンティティは null を返す。
  nextSimulationEventTime(_simTime: number): number | null {
    return null;
  }

  // 予測列を破棄する。
  invalidatePrediction(): void {
    this._predictedArc = null;
  }

  // 未来の予測列を保持する弧を返す(無ければ現在状態を起点に作る)。予測しない種別は null。
  ensurePredictedArc(sources: FutureCelestialBodyProvider): PredictedArc | null {
    if (!this.predictsFuture) return null;
    this._predictedArc ??= new PredictedArc(
      this.actual.state, sources, this.radius, this.bcInv, this.srpCoeff, /* keplerTail */ true,
      /* consumable */ true,
    );
    return this._predictedArc;
  }

  // 予測列が時刻 t を持っていれば、その状態を先端にして true。持っていなければ何もせず false
  // (呼び出し側は積分へ落とす)。celestialBodies は履歴の間引き間隔を出すための重力源一覧。
  followPredicted(t: number, celestialBodies: readonly CelestialBody[]): boolean {
    if (!this.alive) return false;
    const s = this._predictedArc?.trajectory.at(t) ?? null;
    if (s === null) return false;
    this.actual.follow(s, this.historySampleInterval(celestialBodies), this.historyDuration);
    return true;
  }

  // 表示時刻 t の状態。予測を持たない/予測期間を超えた時刻は null。ephemeris を渡すと、
  // 予測列で答えられない未来時刻を、先端を中心天体まわりの二体軌道とみなして外挿した値で
  // 答える(外挿もできなければ null)。
  displayState(t: number, ephemeris?: Ephemeris): KinematicState | null {
    if (t <= this.actual.state.t) return this.actual.at(t);
    const predicted = this.predicted;
    const normal = predicted?.at(t) ?? null;
    if (normal !== null || ephemeris === undefined) return normal;
    if (predicted === null || this.predictionTruncated || predicted.extrapolationCenter === null) return null;
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

  // 大気による焼失の判定。固体表面への接触は collideWithCelestialBody が扱う。playerPos は
  // 「自機からの距離」で消える種別(弾)のために一律で渡す。atmosphereBodies はその時刻の
  // 大気天体一覧。
  checkLoss(
    _dt: number, _simTime: number, _activeStage: Stage, _playerPos: Vec3,
    atmosphereBodies: readonly CelestialBody[],
  ): void {
    if (!this.alive) return;
    if (burnUpBody(this.state.r, atmosphereBodies, this.burnUpDensity) !== null) this.alive = false;
  }

  // 自分がこの相手と接触しうるか。既定 true。両側が true を返したときだけ接触する。
  contactsWith(_other: GameEntity, _simTime: number): boolean {
    return true;
  }

  // 個体どうしの接触で自分に何が起きるかを記述する。相手に何が起きるかは書かない(相手の
  // collideWithEntity が書く)。既定は何も起きない。
  collideWithEntity(_other: GameEntity, _contact: Contact, _activeStage: Stage): void {
  }

  // 天体の固体表面へ触れたときに自分に何が起きるか。既定は失われる。
  collideWithCelestialBody(_body: CelestialBody, _contact: Contact, _activeStage: Stage): void {
    this.alive = false;
  }

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
