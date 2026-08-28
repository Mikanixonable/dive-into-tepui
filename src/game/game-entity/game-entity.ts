// ゲーム内エンティティの定義。位置・速度は ECI 座標系 [m, m/s]。
import * as THREE from 'three/webgpu';
import { KinematicState } from '../../physics/kinematic-state';
import { OrbitalElements } from '../../physics/elements';
import { Attitude, stepAttitude } from '../../physics/attitude';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import { CelestialBody, orbitalElementsOf, localOrbitPeriod, strongestAttractor } from '../../physics/celestial-body';
import { airflow } from '../../physics/atmosphere';
import {
  aeroHeating, radiativeCooling, solarHeating, sphereNoseRadius, stepTemperature,
  stepThermalDeviation,
} from '../../physics/thermal';
import { sunlitFactor } from '../../physics/shadow';
import { SOLAR_CONSTANT } from '../../physics/srp';
import { ApsisTrack } from '../../physics/trajectory-features';
import { Vec3, len, scale, sub, v3 } from '../../math/vec3';
import type { Viewpoint } from '../../math/projection';
import type { SphereHit } from './base-collision';
import { FloatingOrigin } from '../camera/floating-origin';
import { OrbitLine } from '../lines/orbit-line';
import { RelativeOrbitLine } from '../lines/relative-orbit-line';
import { TrajectoryLine } from '../lines/trajectory-line';
import type { OrbitReference } from '../orbit-reference';
import { LineStyle } from '../../render/line-style';
import { FrameAnchorSource, ReferenceFrame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { PredictedArc, trajectorySampleInterval } from '../simulation/predicted-arc';
import { atmosphericMaxStep, dragTakesFullAirspeed } from '../simulation/time-step';
import type { FutureCelestialBodyProvider } from '../simulation/arc-bodies';
import * as C from '../const';
import type { Stage } from '../stages/stage';
import type { Contact } from './contact';
import { EntityIdAllocator } from './entity-id';
import { EquatorNodeMarkerPair } from '../marker/equator-node-marker-pair';
import type { MarkerManager } from '../marker/marker-manager';
import { disposeOwnedRenderResources } from '../../render/dispose-owned-render-resources';
import { syncThermalState } from '../../render/thermal-emissive';

// 過去表示の要求で伸ばせる保持時間の上限 [s]。保持サンプル数は間引きにより
// ARC_MAX_SAMPLES で頭打ちなので、この値が決めるのは間引きの粗さ(補間精度)の下限。
const HISTORY_DURATION_MAX = C.DISPLAY_DURATION_MAX;

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
  // 戦闘ビューで非質量の艦・基地に表示基準を固定中、orbitLine の代わりに対象との直線を描く線。
  // null = 持たない。
  relativeOrbitLine: RelativeOrbitLine | null = null;
  // showOrbitLine で渡された style。relativeOrbitLine を遅延生成するときに使い回す。
  private orbitLineStyle: LineStyle | null = null;
  // 自身の予測軌道を描く線。null = 持たない。
  predictedLine: TrajectoryLine | null = null;
  // 過去に通ってきた軌跡の線。持たせるかは種別の判断。
  actualLine: TrajectoryLine | null = null;
  // プロパティウィンドウから切り替える、軌道線の表示方式。true = 解析軌道楕円の代わりに
  // 予測線・過去線を表示する。
  showTrajectoryLine = false;
  // 自身の軌道と中心天体の赤道面との交点マーカー。null = まだ出す必要が生じていない。
  equatorNodes: EquatorNodeMarkerPair | null = null;
  // 弾道係数の逆数 Cd·A/m(既定 0 = 抵抗なし)。抗力が要求する刻みを外から引けるよう公開する。
  readonly bcInv: number = 0;
  protected readonly srpCoeff: number = 0;

  // --- 熱(physics/thermal.ts の比量モデル) ---
  // 現在の平均温度 [K]。
  temperature = C.ENV_TEMP;
  // 局所的に過熱した部分が平均より高い温度差 [K]。0 = 全体が等温。
  protected thermalDeviation = 0;
  // 比熱 [J/(kg·K)]。**0 = 熱を蓄えない種別**で、温度は動かない。
  protected readonly specificHeat: number = 0;
  // 材質の密度 [kg/m^3]。よどみ点の曲率半径を bcInv から戻すのに使う。
  protected readonly bulkDensity: number = C.SMALL_DEBRIS_BULK_DENSITY;
  // いまの輻射面積の比 [m^2/kg]。展開して面積が変わる放熱面を持つ種別は override する。
  protected get radiatingAreaPerMass(): number { return 0; }
  // 輻射率。
  protected readonly emissivity: number = C.HULL_EMISS;
  // 太陽光を受ける面積の比 [m^2/kg]。吸収率を織り込んだ実効値で、既定は球とみなした断面積
  // (bcInv/Cd)に外殻の吸収率(灰色体とみなし輻射率に等しい)を掛けたもの。展開して受光面が
  // 増える種別は sunDir を見て override する。
  protected solarAbsorbAreaPerMass(_sunDir: Vec3): number {
    return (this.emissivity * this.bcInv) / C.DRAG_COEFFICIENT;
  }
  // これを超えると焼失する温度 [K]。既定 Infinity = 熱では失われない。
  protected readonly maxTemperature: number = Infinity;
  // 刻みに依らない投入熱 [J/kg]。次の熱計算で一度だけ温度へ変換する。
  private pendingSpecificHeat = 0;
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

  // 軌道分析パネルがこの個体の未来を読んでいるか。戦闘ビューでも(canDisplayFuture が false
  // でも)開いている間は弧を伸ばし続けたいので、他の理由と同じく独立に持つ。
  analysisPanelReader = false;

  // ナビゲーションターゲットとして選ばれ、相対軌道要素(再接近点など)の計算対象になって
  // いるか。マップビューでのみ意味を持つが、そこでは canDisplayFuture が既に真なので
  // 専用のフラグとして独立に持つ。
  navTargetReader = false;

  // この個体の未来を読む消費者がいるか。ゴーストだけは表示時刻が未来へ動けるかに依るので、
  // 動けるかどうかを引数で受け取る。
  hasFutureReader(canDisplayFuture: boolean): boolean {
    return (this.predictedForGhost && canDisplayFuture)
      || this.predictedLine !== null || this.analysisPanelReader || this.navTargetReader;
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

  // 軌道楕円(または戦闘ビューで非質量ターゲット固定中の対象への直線)の線を style で出す。
  // 既に出ていれば style を塗り直す。
  showOrbitLine(style: LineStyle): void {
    this.orbitLineStyle = style;
    if (this.orbitLine !== null) {
      this.orbitLine.setStyle(style);
    } else {
      const line = new OrbitLine(style);
      this.scene?.add(line.line);
      this.orbitLine = line;
    }
    this.relativeOrbitLine?.setStyle(style);
  }

  // 軌道楕円・対象への直線を消す。出し直すと作り直しになる。
  hideOrbitLine(): void {
    this.orbitLineStyle = null;
    if (this.orbitLine !== null) {
      this.scene?.remove(this.orbitLine.line);
      this.orbitLine.dispose();
      this.orbitLine = null;
    }
    if (this.relativeOrbitLine !== null) {
      this.scene?.remove(this.relativeOrbitLine.line);
      this.relativeOrbitLine.dispose();
      this.relativeOrbitLine = null;
    }
  }

  // 軌道楕円を隠す(相対軌跡モードへ切り替える/状態が求まらないときに使う)。
  private hideOrbitEllipse(fo: FloatingOrigin, camera: THREE.Camera): void {
    this.orbitLine?.sync(null, fo, camera);
  }

  // orbitLine を表示時刻の状態に合わせる。線を持たなければ何もしない。displayTime が現在時刻
  // より先なら、表示用の予測状態を使って船体と同じ時刻に揃える。orbitRef が非質量の艦・基地
  // ターゲットを指すのは戦闘ビューだけ(EntityLineManager がマップビューでは orbitRef を渡さない)
  // ので、context.orbitRef の有無だけで戦闘ビュー/マップビューを判別できる。
  syncOrbitLine(
    displayTime: number, ephemeris: Ephemeris, fo: FloatingOrigin, camera: THREE.Camera,
    frameAnchors: FrameAnchorSource, orbitRef: OrbitReference | undefined,
  ): void {
    if (this.orbitLine === null && this.relativeOrbitLine === null) return;
    const state = this.displayState(displayTime, ephemeris);
    if (state === null) {
      // 表示時刻の状態が求まらない: 両方隠す。
      this.hideOrbitEllipse(fo, camera);
      this.relativeOrbitLine?.hide();
      return;
    }
    // 非質量の艦・基地に固定中で、自分自身がその対象でなければ対象への直線モード。
    const relativeTarget = orbitRef?.fixed && !orbitRef.hasMass ? orbitRef.entity : null;
    if (relativeTarget !== null && relativeTarget !== this) {
      this.hideOrbitEllipse(fo, camera);
      if (this.relativeOrbitLine === null && this.orbitLineStyle !== null) {
        const line = new RelativeOrbitLine(this.orbitLineStyle);
        this.scene?.add(line.line);
        this.relativeOrbitLine = line;
      }
      const targetPos = relativeTarget.displayState(displayTime, ephemeris)?.r ?? relativeTarget.state.r;
      this.relativeOrbitLine?.sync(state.r, targetPos, fo, camera);
      return;
    }
    this.relativeOrbitLine?.hide();
    // 艦・基地以外の非質量対象(ラグランジュ点など)、または自分自身が対象のときは楕円も出さない。
    if (orbitRef?.fixed && !orbitRef.hasMass) {
      this.hideOrbitEllipse(fo, camera);
      return;
    }
    // 質量天体に固定中はその天体中心、自動選択(未固定)なら自身にとって最も強く引く天体を中心に描く。
    const center = orbitRef?.fixed && orbitRef.attractor
      ? orbitRef.attractor
      : strongestAttractor(state.r, frameAnchors.bodies);
    this.orbitLine?.sync(orbitalElementsOf(state, center), fo, camera);
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
    this.requestedHistoryDuration = Math.max(0, Math.min(HISTORY_DURATION_MAX, sec));
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

  // このサブステップを内側で何等分して進めるか。濃い大気の中では抗力が dt より短い刻みを
  // 要求するので、それに従う種別はここで 2 以上を返す。atmosphereBodies はその区間の大気天体
  // 一覧。
  substepDivisions(dt: number, atmosphereBodies: readonly CelestialBody[]): number {
    if (!this.doPreciseReentry) return 1;
    const innerDt = atmosphericMaxStep(this.state, this.bcInv, atmosphereBodies);
    return innerDt >= dt ? 1 : Math.ceil(dt / innerDt);
  }

  // 濃い大気に対して刻みが広すぎて、抗力をもう積めなくなったか。刻みを細かく割って積む種別は
  // 積めなくなることがないので常に false。true になった個体は、そこから先の軌道が正確では
  // ないので失われる — 物理ではなく積分器の都合による喪失。
  outpacedByDrag(dt: number, atmosphereBodies: readonly CelestialBody[]): boolean {
    return !this.doPreciseReentry
      && dragTakesFullAirspeed(this.state, this.bcInv, atmosphereBodies, dt);
  }

  // 1区間ぶん自分を進める。呼び出し側は生存を確かめてから呼ぶ。celestialBodies はこの区間の
  // 重力源一覧、occluders は日照率の遮蔽体一覧、atmosphereBody は抗力を及ぼすただ1体の大気
  // 天体(null なら抗力なし)、star は日照と受熱の光源(null なら光源なし)。
  //
  // 位置と速度は、既に伸びている予測が区間の終端を持っていればそれを辿り、無ければ積分する。
  // **どちらを通っても姿勢と受動的な環境は同じ区間ぶん進む** — 位置と速度の決まり方は、その
  // 個体に何が起きるかを変えない。積分したなら true を返す(負荷確認の集計だけがこれを読む)。
  stepSimulation(
    dt: number,
    celestialBodies: readonly CelestialBody[],
    occluders: readonly CelestialBody[],
    atmosphereBody: CelestialBody | null,
    star: CelestialBody | null,
    activeStage: Stage,
  ): boolean {
    const integrated = !this.followPredicted(this.state.t + dt, celestialBodies);
    if (integrated) {
      this.actual.step(
        dt, celestialBodies, occluders, atmosphereBody, this.bcInv, this.srpCoeff, this.thrust,
        this.historySampleInterval(celestialBodies), this.historyDuration,
      );
      // 積分した弧はもう現実を表さない。ある時間帯の状態を決める積分を常に1本に保つ。
      this.invalidatePrediction();
    }
    if (this.hasAttitude) this.att = stepAttitude(this.att, this.torque, dt);
    // 太陽の幾何は熱収支と受動的な環境の両方が読むので、この区間で1度だけ引いて両方へ渡す。
    // 日照率は遮蔽体の数だけ走るため、熱を蓄えない種別(弾)には引かせない — 受動的な環境を
    // 持つ種別はどれも熱を蓄える。
    const sun = this.specificHeat > 0 ? star : null;
    const toSun = sun === null ? v3() : sub(sun.state.r, this.state.r);
    const sunDist = len(toSun);
    const sunDir = sunDist > 0 ? scale(toSun, 1 / sunDist) : v3();
    const sunlit = sun === null ? 0 : sunlitFactor(this.state.r, sun, occluders);
    // 環境を先に進める。放熱面の展開のように、熱収支が読む値をここで書き換える種別がある。
    this.stepEnvironment(dt, atmosphereBody, sunlit, sunDir);
    this.stepThermal(dt, atmosphereBody, sunDist, sunlit, sunDir, activeStage);
    return integrated;
  }

  // 刻みに依らない投入熱 [J/kg] を次の熱計算へ持ち越す。射撃や被弾のように、サブステップの
  // 分割数で回数が変わってはならない熱がここを通る。
  absorbHeat(specificJoules: number): void {
    this.pendingSpecificHeat += specificJoules;
  }

  // 温度が上限を超えて失われる。死因を記録する種別が override する。
  protected burnUp(_activeStage: Stage): void {
    this.alive = false;
  }

  // 空力加熱・太陽光の受熱と放射冷却で温度を1区間ぶん進め、上限を超えていれば焼失させる。
  // atmosphereBody は自分が浴びるただ1体の大気天体(null なら真空)、sunDist は太陽までの
  // 距離、sunlit は日照率、sunDir は太陽方向。比熱を持たない種別は温度も持たないので何もしない。
  //
  // 焼失の判定をここへ置くのは、区間を細かく割って積む個体のためである。放射冷却は高温ほど
  // 速いので、粗い区間の終わりだけを見ると、加熱の山で上限を越えて戻ってきた個体を取り逃がす。
  private stepThermal(
    dt: number, atmosphereBody: CelestialBody | null,
    sunDist: number, sunlit: number, sunDir: Vec3, activeStage: Stage,
  ): void {
    if (this.specificHeat <= 0) return;
    const atm = atmosphereBody?.atmosphere ?? null;
    let heating = solarHeating(
      SOLAR_CONSTANT, sunDist, sunlit, this.solarAbsorbAreaPerMass(sunDir));
    if (atm !== null && this.bcInv > 0) {
      const { density, speed } = airflow(
        sub(this.state.r, atmosphereBody!.state.r),
        sub(this.state.v, atmosphereBody!.state.v), atm);
      heating += aeroHeating(
        density, speed, this.bcInv, C.SG_CONST,
        sphereNoseRadius(this.bcInv, C.DRAG_COEFFICIENT, this.bulkDensity),
        (C.STAGNATION_AREA_FRACTION * this.bcInv) / C.DRAG_COEFFICIENT);
    }
    const cooling = radiativeCooling(
      this.temperature, C.ENV_TEMP, this.emissivity, this.radiatingAreaPerMass,
      this.specificHeat, dt);
    this.temperature = stepTemperature(this.temperature, heating - cooling, this.specificHeat, dt)
      + this.pendingSpecificHeat / this.specificHeat;
    this.pendingSpecificHeat = 0;
    this.thermalDeviation = stepThermalDeviation(
      this.thermalDeviation, this.temperature, this.emissivity, this.radiatingAreaPerMass,
      this.specificHeat, dt);
    if (this.temperature > this.maxTemperature) this.burnUp(activeStage);
  }

  // 同じ区間ぶん、位置と姿勢から決まる受動的な環境(放熱面の展開・電力など)を進める。既定
  // では持たない。atmosphereBody は自分が浴びるただ1体の大気天体、sunlit は日照率、sunDir は
  // 太陽方向の単位ベクトル。
  protected stepEnvironment(
    _dt: number, _atmosphereBody: CelestialBody | null, _sunlit: number, _sunDir: Vec3,
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

  // 予測列が時刻 t を持っていれば、その状態を先端にして true。持っていなければ何もせず false。
  // celestialBodies は履歴の間引き間隔を出すための重力源一覧。
  private followPredicted(t: number, celestialBodies: readonly CelestialBody[]): boolean {
    // 現行の予測弧は自由落下だけを表す。噴射中にそれを実状態へ消費すると、Player/RCSや
    // ブースターの加速度を丸ごと失うため、推力がある区間は必ず実積分へ落とす。
    if (this.thrust !== null) return false;
    const s = this._predictedArc?.trajectory.at(t) ?? null;
    if (s === null) return false;
    this.actual.follow(s, this.historySampleInterval(celestialBodies), this.historyDuration);
    return true;
  }

  // 表示時刻 t の状態。予測を持たない/予測期間を超えた時刻は null。ephemeris を渡すと、
  // 予測列で答えられない未来時刻を、先端を中心天体まわりの二体軌道とみなして外挿した値で
  // 答える(外挿もできなければ null)。
  displayState(t: number, ephemeris?: Ephemeris): KinematicState | null {
    if (t <= this.actual.state.t) {
      const past = this.actual.at(t);
      if (past !== null) return past;
      // 履歴を持たない種別(弾・薬莢・破片)の保持列は先端1件だけなので、at() は t が先端時刻
      // と完全に一致したときしか答えられない。積分の刻みの積み方や simTime の強制前進で先端が
      // 丸め1つぶん外れただけで非表示になってしまうため、その1件をそのまま答えにする。
      return this.historyDuration > 0 ? null : this.actual.state;
    }
    const predicted = this.predicted;
    const normal = predicted?.at(t) ?? null;
    if (normal !== null || ephemeris === undefined) return normal;
    if (predicted === null || this.predictionTruncated || predicted.extrapolationCenter === null) return null;
    return predicted.extrapolatedAt(t, ephemeris.stateOf(predicted.extrapolationCenter.id, t));
  }

  // displayTime の描画位置・姿勢を fo 経由でメッシュへ同期する。
  sync(fo: FloatingOrigin, displayTime: number, _viewer?: Viewpoint, _proteinVibrationEnabled = true): void {
    const s = this.displayState(displayTime);
    if (s === null) {
      this.renderObject.visible = false;
      return;
    }
    this.renderObject.visible = true;
    this.renderObject.position.copy(fo.RtoThreeV3(s.r));
    this.renderObject.quaternion.set(this.att.q.x, this.att.q.y, this.att.q.z, this.att.q.w);
    this.syncThermalAppearance();
  }

  // いまの温度と局所的な過熱をメッシュへ配る。
  protected syncThermalAppearance(): void {
    if (this.specificHeat <= 0) return;
    syncThermalState(
      this.renderObject, this.temperature, this.thermalDeviation, this.emissivity);
  }

  // 種別ごとの自然死。大気による焼失は温度が決めるので(stepSimulation)、ここに残るのは
  // 寿命や距離のような、状態から直接は決まらない事情だけ。playerPos は「自機からの距離」で
  // 消える種別(弾)のために一律で渡す。atmosphereBodies はその時刻の大気天体一覧。
  checkLoss(
    _dt: number, _simTime: number, _activeStage: Stage, _playerPos: Vec3,
    _atmosphereBodies: readonly CelestialBody[],
  ): void {
  }

  // 自分がこの相手と接触しうるか。既定 true。両側が true を返したときだけ接触する。
  contactsWith(_other: GameEntity, _simTime: number): boolean {
    return true;
  }

  // 球を broad phase として使った後に、種別固有のメッシュで狭域判定を行うためのフック。
  // 既定のエンティティは球判定へフォールバックする。法線は「自分の形状から相手の球へ」
  // 向き、depth は相手の球を自分の形状から押し出す距離 [m] を返す。
  testCustomSphereCollision(
    _sphereCenter: Vec3, _sphereRadius: number, _selfState: KinematicState,
  ): SphereHit | null {
    return null;
  }

  // 高速な球が区間の途中でカスタム形状を横切ったときの狭域 CCD フック。toi は
  // prevState→selfState の割合で、既定の種別は null を返して球の掃引判定へ進む。
  testCustomSweptSphereCollision(
    _previousSphereCenter: Vec3, _sphereCenter: Vec3, _sphereRadius: number,
    _previousSelfState: KinematicState, _selfState: KinematicState,
  ): { readonly hit: SphereHit; readonly toi: number } | null {
    return null;
  }

  // true の種別では、カスタム判定が null を返しても外接球へフォールバックしない。
  // これを分けないと「リボンに触れていない空間」が球の当たり判定として残ってしまう。
  usesCustomSphereCollision(): boolean {
    return false;
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
    this.hideOrbitLine();
    this.hidePredictedLine();
    this.hideActualLine();
    disposeOwnedRenderResources(this.renderObject);
  }
}
