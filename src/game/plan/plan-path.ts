// 多ノードの計画軌道を arc 単位で描く。Plan の corners を区間へ分解し、区間ごとに区間ソース
// (SegmentSource: 統一 PredictedArc への参照と、そこから読む [from, to])と TrajectoryLine(折れ線)を
// index で対応付けて持つ。ノードを1つも持たない唯一の区間は操作対象自身の予測弧を借用し(owned=false)、
// それ以外は起点・重力源が既存の弧と変われば作り直し、終端だけが動いた区間は requiredEnd の
// 書き換えだけで済ませる — どちらの場合も折れ線はその区間の TrajectoryLine プールを使い回す。
// 画面判定も同じ表示変換を通すため描画とずれない。
import * as THREE from 'three/webgpu';
import { KinematicState } from '../../physics/kinematic-state';
import { bodyAnchorSource } from '../../physics/attractor';
import { CelestialMotion } from '../../physics/celestial-motion';
import { Vec3, v3 } from '../../math/vec3';
import { FrameAnchorSource, FrameTransform, ReferenceFrame, toFrameDir, toFramePoint, toInertialDir, toInertialPoint } from '../../physics/frame';
import type { CelestialSystem } from '../celestial/celestial-system';
import { Projected } from '../../math/projection';
import { isOccluded } from '../../physics/occlusion';
import { FloatingOrigin } from '../camera/floating-origin';
import { TrajectoryLine } from '../lines/trajectory-line';
import { LINE_RENDER_ORDER } from '../../render/line-style';
import { ProjectFn, ScaleFn } from '../camera/camera-system';
import { DisplayDurationSource, PlanData, TimeRange, segmentDurationFrom } from './plan';
import { BodyImpact, PredictedArc } from '../dynamic/predicted-arc';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import { clipSamplesTo, samplesInRange, stateAt, withinEnd } from './arc-range';
import { goldenSectionMin } from '../../math/optimize';
import { SHIP_BCINV, SHIP_SRP_COEFF } from '../dynamic/dynamic-entity/ship';
import { PLAYER_HULL_RADIUS } from '../player/player';

// 折れ線が自分自身に重なる(周回を跨いで表示期間が延びた)場合、最短画面距離からこの
// 許容差以内の候補のうち最も早い時刻のものを選ぶ [px]
const NEAREST_SAMPLE_TIE_PX = 3;

// 計画軌道の折れ線を破線で描くときの、破線1本・間隔の画面上の長さ [px] と不透明度。
// 実距離ではなく画面ピクセルで持つのは、マップの倍率が数桁変わるため実距離で固定すると
// 拡大時は数本の線分に、縮小時はサブピクセルになって実線と区別できなくなるため。
const PLAN_ARC_DASH_PX = 8;
const PLAN_ARC_GAP_PX = 6;
const PLAN_ARC_OPACITY = 0.85;

const SEGMENT_COLORS = [0xffb36b, 0xff8a26, 0xff6a00];
const arcColor = (i: number): number => SEGMENT_COLORS[Math.min(i, SEGMENT_COLORS.length - 1)]!;

const OFFSCREEN: Projected = { x: 0, y: 0, front: false };
const NO_SAMPLES: readonly KinematicState[] = [];

// 時刻の近さで tie-break するときに同点とみなす幅[s]。
const TIME_TIE_SEC = 1e-6;

// nearestSample が最寄りサンプルの左右区間を補間曲線上で細分するときの黄金分割探索の反復回数。
const NEAREST_SAMPLE_REFINE_ITERATIONS = 20;

type Segment = { state0: KinematicState; end: number };

// 1区間ぶんの積分ソース。owned が真なら PlanPath がこの弧の生成・requiredEnd/retainFrom の
// 書き込みまで持つ(伸ばすのは Predictor の予算パス — growableArcs 参照)。偽ならノードを1つも
// 持たない唯一の区間で、arc は操作艦自身の予測弧をそのまま借りたもの(艦の予測がまだ無い
// フレームは null)。
type SegmentSource = { arc: PredictedArc | null; from: number; to: number; owned: boolean };

// 最後のバーン後(これから乗る軌道)の区間で見つかったアプシス。
// periapsis/apoapsis は、区間が地表到達等で打ち切られてその極値へ届かなければ null。
// apsisCenter はその極値を検出した弧自身が答える中心天体。
interface FinalSegment {
  readonly periapsis: KinematicState | null;
  readonly apoapsis: KinematicState | null;
  readonly periapsisCenter: CelestialMotion | null;
  readonly apoapsisCenter: CelestialMotion | null;
}

interface PlanPathSample {
  readonly state: KinematicState;
  readonly arcIdx: number;
}

export class PlanPath {
  readonly group = new THREE.Group();
  // 先頭 activeCount 本がこのフレームの区間に対応する(区間が減れば末尾を捨てる)。
  private sources: SegmentSource[] = [];
  // 折れ線は index ごとのプールとして持ち、区間数が減っても捨てない(色は index で決まるので
  // 使い回す)。
  private lines: TrajectoryLine[] = [];
  private activeCount = 0;
  // 先頭 _nodeCount 本がノードで終わる区間(= 各ノードの到達状態を持つ)。
  private _nodeCount = 0;
  // update() で実際のレジストリの慣性系に置き換わるまでの暫定値。
  private frame: ReferenceFrame = { center: 'earth', rotatingWith: null };
  private celestialSystem: CelestialSystem | null = null;
  private unbakeTime = 0;
  // un-bake は update() が受け取った displayTime に固定される。同じフレーム中に ghost/impact/apsis/tick と
  // 折れ線同期・ポインタ判定が何度も参照するため、update 単位で1回だけ組み立てる。天体を引く
  // 時刻はフレームごとに動くので、時刻だけでなく update() ごとに無効化する。
  private unbakeTransform: FrameTransform | null = null;
  // 直近の update が受け取った FrameAnchorSource。toDisplay/toDisplayDir/nearestSample は
  // ポインタイベント起点でフレーム外から呼ばれうるため、update と同じ値をここから読む。
  private frameAnchors: FrameAnchorSource = bodyAnchorSource([], 0);
  private project: ProjectFn | null = null;
  // sync が最後に受け取ったカメラ位置。nearestSample の遮蔽判定に使う(呼び出しは DOM
  // ポインタイベント起点でフレーム外なので、直近の sync から引き継ぐ)。
  private cameraPos: Vec3 | null = null;
  private final: FinalSegment | null = null;
  // 計画を積分して保持する範囲とは別に、画面へ描く時間窓を持つ。ノードが複数あると
  // 計画全体は表示期間より長くなり得るため、折れ線と目盛が同じ窓を読むようにする。
  private displayFrom = 0;
  private displayTo = 0;
  // clipSamplesTo が実際に切り詰めた(= 新規配列を作った)結果を区間の index ごとに
  // (元配列, to) でメモ化する。TrajectoryLine.syncGeometry の再 bake 抑制やクリック候補の
  // 走査が同一フレーム内で何度も同じ配列参照を要求するため。
  private readonly samplesCache: ({ source: readonly KinematicState[]; to: number; result: readonly KinematicState[] } | null)[] = [];
  // 直近の update() で作り直した区間の本数。
  lastRebuiltArcs = 0;

  // group をシーンへ登録する(初期状態は非表示)。
  constructor(scene: THREE.Scene, private readonly displayDuration: DisplayDurationSource) {
    this.group.visible = false;
    scene.add(this.group);
  }

  // 起点とノード列から区間列を組み直す。ノードを1つも持たない唯一の区間は ship 自身の予測弧を
  // 借用し、それ以外の区間は起点・重力源が既存の弧と一致すれば requiredEnd/retainFrom の
  // 書き換えだけで済ませ、一致しなければ作り直す(伸ばすのは呼び出し側の予算パス — growableArcs
  // 参照)。表示変換の文脈(座標系・un-bake 時刻)もこのフレームのものに更新する。
  update(
    planData: PlanData, ship: Controllable | null,
    celestialSystem: CelestialSystem, frame: ReferenceFrame, simTime: number, displayTime: number,
    frameAnchors: FrameAnchorSource, displayDurationSec: number,
  ): void {
    this.frame = frame;
    this.celestialSystem = celestialSystem;
    this.unbakeTime = displayTime;
    this.displayFrom = simTime;
    this.displayTo = simTime + Math.max(0, displayDurationSec);
    this.frameAnchors = frameAnchors;
    this.unbakeTransform = celestialSystem.frames.transformAt(frame, displayTime, frameAnchors);
    this.lastRebuiltArcs = 0;
    // 起点→node…→末尾区間に分解する
    const segments = buildSegments(planData, celestialSystem, this.displayDuration);
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const isFinal = i === segments.length - 1;
      // ノードが1つも無い間の唯一の区間は操作対象の予測弧そのものを借りる。その予測がまだ
      // 生えていないフレームは何も答えず、次のフレームで生え直す。
      if (planData.nodes.length === 0 && isFinal && ship !== null) {
        const arc = ship.predictedArc;
        arc?.apsides?.dropBefore(seg.state0.t);
        this.sources[i] = { arc, from: seg.state0.t, to: seg.end, owned: false };
        continue;
      }
      const prev = this.sources[i];
      let arc = prev?.owned ? prev.arc : null;
      if (!arc || !arc.represents(seg.state0, seg.end)) {
        // 惑星への周回計画のみが対象なので、自機自身の諸元(PLAYER_HULL_RADIUS/SHIP_BCINV/
        // SHIP_SRP_COEFF)で積分する。外挿の尾は持たない(keplerTail=false) — 尾の上にノードを
        // 置くと、実際に積分し直した次のノードと繋がらなくなるため。
        arc = new PredictedArc(
          seg.state0, celestialSystem, PLAYER_HULL_RADIUS, SHIP_BCINV, SHIP_SRP_COEFF,
          /* keplerTail */ false, /* consumable */ false,
        );
        this.lastRebuiltArcs++;
      }
      arc.requiredEnd = seg.end;
      arc.retainFrom = seg.state0.t;
      this.sources[i] = { arc, from: seg.state0.t, to: seg.end, owned: true };
    }
    this.sources.length = segments.length;
    this.samplesCache.length = segments.length;
    this.activeCount = segments.length;
    this._nodeCount = planData.nodes.length;
    const finalSource = this.sources[segments.length - 1]!;
    this.final = {
      periapsis: this.periapsisOf(finalSource),
      apoapsis: this.apoapsisOf(finalSource),
      periapsisCenter: finalSource.arc?.apsides?.periapsisCenter ?? null,
      apoapsisCenter: finalSource.arc?.apsides?.apoapsisCenter ?? null,
    };
  }

  // 表示する区間を空にする。
  clear(): void {
    this.activeCount = 0;
    this.final = null;
  }

  // いま描いている折れ線そのもの(表示窓で切った区間ごとのサンプル列、時刻昇順)。線の上に
  // 乗せる点(交点など)を探す対象になる。
  displayedSamples(): readonly (readonly KinematicState[])[] {
    const out: (readonly KinematicState[])[] = [];
    for (let i = 0; i < this.activeCount; i++) {
      const source = this.sources[i]!;
      const from = Math.max(this.displayFrom, source.from);
      const to = Math.min(this.displayTo, source.to);
      const drawn = samplesInRange(
        this.samplesOf(i, source), from, to, (t) => this.stateAtSource(source, t),
      );
      if (drawn.length >= 2) out.push(drawn);
    }
    return out;
  }

  // このフレーム owned な弧を区間順(= 時刻順)で返す。Predictor の予算パスが実際に伸ばす対象。
  growableArcs(): readonly PredictedArc[] {
    const out: PredictedArc[] = [];
    for (let i = 0; i < this.activeCount; i++) {
      const source = this.sources[i]!;
      if (source.owned && source.arc) out.push(source.arc);
    }
    return out;
  }

  // 最後のバーン後の区間。update() を一度も通していなければ null。
  finalSegment(): FinalSegment | null {
    return this.final;
  }

  // 各区間の折れ線メッシュを最新のサンプル列へ同期し、区間数が減った分の線を隠す。ノードを
  // 1つも持たない区間(借用のみ)は操作対象自身の predictedLine が描くので、ここでは折れ線を
  // 隠すだけにする。画面判定が使う視点(project)もここで受け取り、毎フレーム上書きする。
  // 破線のドット/隙間は各区間のサンプル列中央の代表点で scale(m/px)を引き、ピクセル指定を
  // 実距離に直してから渡す — ズームによらず画面上の間隔を一定に保つため。camera は各区間の
  // 折れ線の解像度を決める画面上のサジッタを実距離へ換算するための描画カメラ。
  sync(fo: FloatingOrigin, project: ProjectFn, scale: ScaleFn, cameraPos: Vec3, camera: THREE.Camera): void {
    this.project = project;
    this.cameraPos = cameraPos;
    if (this.celestialSystem === null) return;
    for (let i = 0; i < this.activeCount; i++) {
      const source = this.sources[i]!;
      const line = this.lineAt(i);
      if (!source.owned || !source.arc) {
        line.setVisible(false);
        continue;
      }
      line.setVisible(true);
      const samples = this.samplesOf(i, source);
      let dashSize = PLAN_ARC_DASH_PX;
      let gapSize = PLAN_ARC_GAP_PX;
      if (samples.length > 0) {
        const mid = samples[Math.floor(samples.length / 2)]!;
        const mpp = scale(this.toDisplay(mid.r, mid.t));
        dashSize = PLAN_ARC_DASH_PX * mpp;
        gapSize = PLAN_ARC_GAP_PX * mpp;
      }
      line.setDash(dashSize, gapSize);
      // 計画全体が表示期間より長くても、折れ線は表示窓内だけを描く。
      line.syncGeometry(
        source.arc.trajectory,
        Math.max(this.displayFrom, source.from),
        Math.min(this.displayTo, source.to),
        this.frame, this.celestialSystem, this.frameAnchors,
      );
      line.syncTransform(this.frame, this.unbakeTime, this.celestialSystem, fo, this.frameAnchors);
      line.sync(camera);
    }
    // 線プールは区間数が減っても捨てずに残すので、隠す範囲は sources でなく lines の本数まで見る。
    for (let i = this.activeCount; i < this.lines.length; i++) this.lines[i]!.setVisible(false);
  }

  // 天体衝突が検出された地点と、その相手の天体(区間ごとに高々1つ)。今フレーム表示中の
  // 区間だけを対象にする。
  impactPoints(): readonly { readonly state: KinematicState; readonly body: CelestialMotion; readonly arcIdx: number }[] {
    const out: { state: KinematicState; body: CelestialMotion; arcIdx: number }[] = [];
    for (let i = 0; i < this.activeCount; i++) {
      const impact = this.impactOf(this.sources[i]!);
      if (impact) out.push({ state: impact.state, body: impact.body, arcIdx: i });
    }
    return out;
  }

  // 表示中の区間が覆う simTime の範囲。どの区間にもサンプルが無ければ null。
  timeRange(): { readonly min: number; readonly max: number } | null {
    let minT = Infinity;
    let maxT = -Infinity;
    for (let i = 0; i < this.activeCount; i++) {
      const samples = this.samplesOf(i, this.sources[i]!);
      if (samples.length === 0) continue;
      const from = Math.max(samples[0]!.t, this.displayFrom);
      const to = Math.min(samples[samples.length - 1]!.t, this.displayTo);
      if (from > to) continue;
      minT = Math.min(minT, from);
      maxT = Math.max(maxT, to);
    }
    if (minT > maxT) return null;
    return { min: minT, max: maxT };
  }

  // この折れ線が経由するノードの数。
  get nodeCount(): number {
    return this._nodeCount;
  }

  // 各ノードの到達時点(噴射直前)の状態。到達前に打ち切られた区間は null。
  arrivalStates(): (KinematicState | null)[] {
    const out: (KinematicState | null)[] = [];
    for (let i = 0; i < this._nodeCount; i++) {
      const source = this.sources[i];
      out.push(source ? this.stateAtSource(source, source.to) : null);
    }
    return out;
  }

  // 時刻 t を保持区間に含む最初の arc から補間した状態を返す。どの arc の外でも null。
  sampleAt(t: number): KinematicState | null {
    return this.sampleAtWithArc(t)?.state ?? null;
  }

  // 時刻 t の補間状態と、それが属する区間の index を返す。ノードを別区間へ移すときは、
  // その区間までに適用済みの Δv を差し引いてから新しい到着状態を組み立てる必要があるため、
  // PlanEditor は sampleAt() ではなくこちらを使う。
  sampleAtWithArc(t: number): PlanPathSample | null {
    for (let i = 0; i < this.activeCount; i++) {
      const s = this.stateAtSource(this.sources[i]!, t);
      if (s) return { state: s, arcIdx: i };
    }
    return null;
  }

  // 時刻 t のサンプル位置 r を、現在の表示座標(ECI)へ変換する。座標系の原点・姿勢はサンプル
  // 時刻 t で bake し、表示時刻 unbakeTime で un-bake する(点なので FrameTransform を2つ引く)。
  toDisplay(r: Vec3, t: number): Vec3 {
    if (!this.celestialSystem) return v3(r.x, r.y, r.z);
    const bakeTf = this.celestialSystem.frames.transformAt(this.frame, t, this.frameAnchors);
    const unbakeTf = this.currentUnbakeTransform()!;
    return toInertialPoint(unbakeTf, toFramePoint(bakeTf, r));
  }

  // 時刻 t の方向ベクトル dir を、現在の表示座標(ECI)へ変換する。方向なので原点移動は掛からず、
  // サンプル時刻 t の bake 姿勢と表示時刻 unbakeTime の un-bake 姿勢の回転だけを受ける。
  toDisplayDir(dir: Vec3, t: number): Vec3 {
    if (!this.celestialSystem) return v3(dir.x, dir.y, dir.z);
    const bakeTf = this.celestialSystem.frames.transformAt(this.frame, t, this.frameAnchors);
    const unbakeTf = this.currentUnbakeTransform()!;
    return toInertialDir(unbakeTf, toFrameDir(bakeTf, dir));
  }

  // 時刻 t のサンプル位置 r をスクリーン座標へ投影する。
  projectPoint(r: Vec3, t: number): Projected {
    if (!this.project) return OFFSCREEN;
    return this.project(this.toDisplay(r, t));
  }

  // 画面座標に最も近い計画軌道上の点(maxPx 以内)。なければ null。range を渡すと、
  // その時刻範囲に入るサンプルだけを候補にする。まず画面距離だけで最寄りの arc を選び
  // (バーン前後で arc をまたぐと t の大小関係が逆転するため、複数 arc を通して時刻を
  // 比べると誤った arc を選びかねない)、その arc の中で画面最短距離から NEAREST_SAMPLE_TIE_PX
  // 以内の候補に絞ってから referenceT に最も近い時刻を選ぶ — 新規配置は範囲の下端(= 最も
  // 早く到達する時刻)を、既存ノードのドラッグはそのノードの現在時刻を渡すことで、
  // 「表示期間が延びて折れ線が自分自身に重なる区間」の曖昧さを呼び出しの意図どおりに解く。
  // こうして選んだ1点の左右の隣接サンプルまでを区間とし、区間内では画面距離が単峰であると
  // みなして黄金分割探索を掛け、補間曲線上の最寄り点まで追い込む。
  nearestSample(mx: number, my: number, maxPx: number, referenceT: number, range?: TimeRange): { state: KinematicState, arcIdx: number } | null {
    const maxDSq = maxPx * maxPx;
    const cameraPos = this.cameraPos;
    const celestialSystem = this.celestialSystem;
    const celestialBodies = cameraPos && celestialSystem ? celestialSystem.celestialMotions : null;
    // 表示座標への変換をサンプルごとに1回だけ行い、遮蔽判定と投影で共有する。un-bake 側の
    // 変換は時刻が固定なのでループの外で1回だけ引く。
    const unbakeTf = celestialSystem ? this.currentUnbakeTransform() : null;
    const candidates: { state: KinematicState; arcIdx: number; sampleIdx: number; dSq: number }[] = [];
    for (let i = 0; i < this.activeCount; i++) {
      const samples = this.samplesOf(i, this.sources[i]!);
      for (let j = 0; j < samples.length; j++) {
        const s = samples[j]!;
        if (range && (s.t < range.min || s.t > range.max)) continue;
        const pos = celestialSystem && unbakeTf
          ? toInertialPoint(unbakeTf, toFramePoint(celestialSystem.frames.transformAt(this.frame, s.t, this.frameAnchors), s.r))
          : v3(s.r.x, s.r.y, s.r.z);
        // 天体に遮蔽されて画面上見えていない点は候補から除く — マップ右クリックの
        // ピック候補(map-picker.ts)と同じ判定を通す。
        if (cameraPos && celestialBodies
          && isOccluded(cameraPos, pos, celestialBodies, this.frameAnchors.bodiesPivot)) continue;
        const p = this.project ? this.project(pos) : OFFSCREEN;
        if (!p.front) continue;
        const dSq = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
        if (dSq <= maxDSq) candidates.push({ state: s, arcIdx: i, sampleIdx: j, dSq });
      }
    }
    if (candidates.length === 0) return null;

    // 画面最短距離の候補が属する arc だけを tie-break の対象にする。
    let nearest = candidates[0]!;
    for (const c of candidates) if (c.dSq < nearest.dSq) nearest = c;
    const toleranceDSq = (Math.sqrt(nearest.dSq) + NEAREST_SAMPLE_TIE_PX) ** 2;

    // referenceT が -Infinity なら全候補が同点になり、最後の t 昇順の同点判定だけで最早時刻に落ち着く。
    let best: typeof candidates[number] | null = null;
    for (const c of candidates) {
      if (c.arcIdx !== nearest.arcIdx || c.dSq > toleranceDSq) continue;
      const d = Math.abs(c.state.t - referenceT);
      const bestD = best ? Math.abs(best.state.t - referenceT) : Infinity;
      if (!best || d < bestD - TIME_TIE_SEC
        || (Math.abs(d - bestD) <= TIME_TIE_SEC && c.state.t < best.state.t)) best = c;
    }
    if (!best) return null;

    const source = this.sources[best.arcIdx]!;
    const samples = this.samplesOf(best.arcIdx, source);
    let lo = best.sampleIdx > 0 ? samples[best.sampleIdx - 1]!.t : best.state.t;
    let hi = best.sampleIdx < samples.length - 1 ? samples[best.sampleIdx + 1]!.t : best.state.t;
    if (range) {
      lo = Math.max(lo, range.min);
      hi = Math.min(hi, range.max);
    }
    if (hi <= lo) return { state: best.state, arcIdx: best.arcIdx };

    // 時刻 t の画面距離の2乗。source が t を答えられない、または画面裏に投影される場合は Infinity。
    const f = (t: number): number => {
      const state = this.stateAtSource(source, t);
      if (!state) return Infinity;
      const p = this.projectPoint(state.r, t);
      if (!p.front) return Infinity;
      return (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
    };
    const t = goldenSectionMin(lo, hi, f, NEAREST_SAMPLE_REFINE_ITERATIONS);
    const refined = this.stateAtSource(source, t);
    return { state: refined ?? best.state, arcIdx: best.arcIdx };
  }

  // update() がまだ呼ばれていない経路にも、従来どおり遅延評価で対応する。ただし通常の
  // 表示経路では update() が先に値を入れるため、同一フレーム内の再生成は起きない。
  private currentUnbakeTransform(): FrameTransform | null {
    if (!this.celestialSystem) return null;
    if (this.unbakeTransform === null) {
      this.unbakeTransform = this.celestialSystem.frames.transformAt(
        this.frame, this.unbakeTime, this.frameAnchors,
      );
    }
    return this.unbakeTransform;
  }

  // source を to でクリップしたサンプル列。source.arc が無ければ空配列。end で実際に切り詰めが
  // 要ったとき(source.arc.trajectory 自身は end を越えて伸び続ける)だけ index ごとに
  // (元配列, to) でメモ化する — 同じフレーム内の複数の読者(sync/timeRange/nearestSample)へ
  // 同じ配列参照を返し続けないと、TrajectoryLine の再 bake 抑制が毎回働かなくなる。
  private samplesOf(i: number, source: SegmentSource): readonly KinematicState[] {
    if (!source.arc) return NO_SAMPLES;
    const raw = source.arc.trajectory.samplesOldestFirst();
    const cached = this.samplesCache[i];
    if (cached && cached.source === raw && cached.to === source.to) return cached.result;
    const result = clipSamplesTo(raw, source.to);
    this.samplesCache[i] = { source: raw, to: source.to, result };
    return result;
  }

  // source が答える範囲を to でクリップしたうえでの時刻 t の状態。
  private stateAtSource(source: SegmentSource, t: number): KinematicState | null {
    return source.arc ? stateAt(source.arc.trajectory, t, source.to) : null;
  }

  // source の弧が天体表面へ達した状態。to を超えていれば(区間が縮んでその先で見つかったことに
  // なれば)null。
  private impactOf(source: SegmentSource): BodyImpact | null {
    const impact = source.arc?.impact ?? null;
    return impact && withinEnd(impact.state.t, source.to) ? impact : null;
  }

  // source が答える範囲で最初の近地点。to を超えていれば null。
  private periapsisOf(source: SegmentSource): KinematicState | null {
    const first = source.arc?.apsides?.periapsis ?? null;
    return first && withinEnd(first.t, source.to) ? first : null;
  }

  // source が答える範囲で最初の遠地点。to を超えていれば null。
  private apoapsisOf(source: SegmentSource): KinematicState | null {
    const first = source.arc?.apsides?.apoapsis ?? null;
    return first && withinEnd(first.t, source.to) ? first : null;
  }

  // group 全体の表示/非表示を切り替える。
  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  // group をシーンから外し、プールした折れ線を解放する。
  dispose(): void {
    this.group.removeFromParent();
    for (const line of this.lines) line.dispose();
  }

  // i 番目の折れ線を返す(なければ生成して group へ追加する)。区間の色は index で決まる。
  private lineAt(i: number): TrajectoryLine {
    while (this.lines.length <= i) {
      const idx = this.lines.length;
      const line = new TrajectoryLine({
        color: arcColor(idx), opacity: PLAN_ARC_OPACITY, renderOrder: LINE_RENDER_ORDER.plan,
        dash: { dashSize: PLAN_ARC_DASH_PX, gapSize: PLAN_ARC_GAP_PX },
      });
      this.lines.push(line);
      this.group.add(line.line);
    }
    return this.lines[i]!;
  }
}

// 起点から nodes を順にたどって区間列を返す。先頭 nodes.length 本は次のノードで終わり、
// 末尾の1本は segmentDurationFrom ぶん伸びる。
function buildSegments(
  planData: PlanData,
  celestialSystem: CelestialSystem, displayDuration: DisplayDurationSource,
): Segment[] {
  const segments: Segment[] = [];
  let state0 = planData.anchor;
  // ノードを1つずつ経由点として区間を切り出す
  for (const node of planData.nodes) {
    segments.push({ state0, end: node.t });
    state0 = node;
  }
  const celestialBodies = celestialSystem.celestialMotions;
  segments.push({ state0, end: state0.t + segmentDurationFrom(state0, celestialBodies, displayDuration) });
  return segments;
}
