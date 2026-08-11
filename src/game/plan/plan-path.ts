// 多ノードの計画軌道を arc 単位で描く。Plan の corners を区間へ分解し、
// 区間ごとに PlanArc を生成・所有する。画面判定も同じ表示変換を通すため描画とずれない。
import * as THREE from 'three/webgpu';
import { KinematicState } from '../../physics/kinematic-state';
import { Attractor, strongestAttractor } from '../../physics/attractor';
import { Vec3, v3 } from '../../physics/vec3';
import { FrameTransform, ReferenceFrame, frameDir, toFrameDir, toFramePoint, toFrameState, toInertialDir, toInertialPoint } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { Projected } from '../../physics/projection';
import { isOccluded } from '../../physics/occlusion';
import { FloatingOrigin } from '../floating-origin';
import { ProjectFn, ScaleFn } from '../camera/camera-system';
import { DisplayDurationSource, Plan, TimeRange, segmentDurationFrom } from './plan';
import { PlanArc } from './plan-arc';
import type { PlanAttractorProvider } from '../simulation/attractors';
import * as C from '../const';

const SEGMENT_COLORS = [0xffb36b, 0xff8a26, 0xff6a00];
const arcColor = (i: number): number => SEGMENT_COLORS[Math.min(i, SEGMENT_COLORS.length - 1)]!;

const OFFSCREEN: Projected = { x: 0, y: 0, front: false };

// 時刻の近さで tie-break するときに同点とみなす幅[s]。
const TIME_TIE_SEC = 1e-6;

type Segment = { state0: KinematicState; end: number };

// 最後のバーン後(これから乗る軌道)の区間。samples は PlanArc.samples をそのまま渡す参照で、
// 区間を再積分しない限り同一参照を保つ。periapsis/apoapsis は、区間が地表到達等で
// 打ち切られてその極値へ届かなければ null。
export interface FinalSegment {
  readonly state0: KinematicState;
  readonly samples: readonly KinematicState[];
  readonly periapsis: KinematicState | null;
  readonly apoapsis: KinematicState | null;
}

export class PlanPath {
  readonly group = new THREE.Group();
  // 先頭 activeCount 本がこのフレームの区間に対応する(色は index で決まるので使い回す)。
  private arcs: PlanArc[] = [];
  private activeCount = 0;
  // 先頭 nodeCount 本がノードで終わる区間(= 各ノードの到達状態を持つ)。
  private nodeCount = 0;
  // update() で実際のレジストリの慣性系に置き換わるまでの暫定値。
  private frame: ReferenceFrame = { center: 'earth', rotatingWith: null };
  private ephemeris: Ephemeris | null = null;
  private unbakeTime = 0;
  // un-bake は update() が受け取った currentTime に固定される。同じフレーム中に ghost/impact/apsis/tick と
  // 折れ線同期・ポインタ判定が何度も参照するため、update 単位で1回だけ組み立てる。天体暦の
  // attractors はフレームごとに差し替わりうるので、時刻だけでなく update() ごとに無効化する。
  private unbakeTransform: FrameTransform | null = null;
  // 直近の update が受け取った重力源一覧。toDisplay/toDisplayDir/nearestSample はポインタ
  // イベント起点でフレーム外から呼ばれうるため、update と同じ値をここから読む。
  private attractors: readonly Attractor[] = [];
  private project: ProjectFn | null = null;
  // sync が最後に受け取ったカメラ位置。nearestSample の遮蔽判定に使う(呼び出しは DOM
  // ポインタイベント起点でフレーム外なので、直近の sync から引き継ぐ)。
  private cameraPos: Vec3 | null = null;
  private final: FinalSegment | null = null;
  // 直近の update() で再積分した区間の本数と、その積分step数の合計。
  lastReintegratedArcs = 0;
  lastSteps = 0;

  // group をシーンへ登録する(初期状態は非表示)。
  constructor(scene: THREE.Scene, private readonly displayTimeManager: DisplayDurationSource) {
    this.group.visible = false;
    scene.add(this.group);
  }

  // plan から区間列を組み直して各区間を再積分し、表示変換の文脈(座標系・un-bake 時刻)を
  // このフレームのものに更新する。
  update(
    plan: Plan, ephemeris: Ephemeris, frame: ReferenceFrame, currentTime: number,
    attractors: readonly Attractor[], attractorProvider: PlanAttractorProvider,
  ): void {
    this.frame = frame;
    this.ephemeris = ephemeris;
    this.unbakeTime = currentTime;
    this.attractors = attractors;
    this.unbakeTransform = ephemeris.frameTransformAt(frame, currentTime, attractors);
    this.lastReintegratedArcs = 0;
    this.lastSteps = 0;
    // anchor→node…→末尾区間に分解する
    const segments = buildSegments(plan, ephemeris, this.displayTimeManager);
    // ノードが1つも無い間はその唯一の区間(末尾区間)の起点が毎フレーム自機を追従する。
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const tracksLiveAnchor = plan.nodes.length === 0 && i === segments.length - 1;
      // 近地点/遠地点は末尾区間だけが必要とするので、他区間は追跡自体を省く。
      // 起点自身の時刻の重力源スナップショットで判定する — displayTime 時点の attractors では
      // 表示時刻に応じて中心天体が変わってしまい、区間の物理そのものと食い違う。
      const isFinalSegment = i === segments.length - 1;
      const apsisCenter = isFinalSegment ? strongestAttractor(seg.state0.r, ephemeris.attractorsAt(seg.state0.t)) : null;
      const arc = this.arcAt(i);
      if (arc.update(seg.state0, seg.end, attractorProvider, tracksLiveAnchor, apsisCenter)) {
        this.lastReintegratedArcs++;
        this.lastSteps += arc.lastSteps;
      }
    }
    this.activeCount = segments.length;
    this.nodeCount = plan.nodes.length;
    const finalArc = this.arcs[segments.length - 1]!;
    this.final = {
      state0: segments[segments.length - 1]!.state0,
      samples: finalArc.samples,
      periapsis: finalArc.periapsisPoint(),
      apoapsis: finalArc.apoapsisPoint(),
    };
  }

  // 最後のバーン後の区間。update() を一度も通していなければ null。
  finalSegment(): FinalSegment | null {
    return this.final;
  }

  // 各区間の折れ線メッシュを最新のサンプル列へ同期し、区間数が減った分の arc を隠す。
  // 画面判定が使う視点(project)もここで受け取り、毎フレーム上書きする。破線のドット/隙間は
  // 各区間のサンプル列中央の代表点で scale(m/px)を引き、ピクセル指定を実距離に直してから渡す
  // — ズームによらず画面上の間隔を一定に保つため。
  sync(fo: FloatingOrigin, project: ProjectFn, scale: ScaleFn, cameraPos: Vec3): void {
    this.project = project;
    this.cameraPos = cameraPos;
    if (this.ephemeris === null) return;
    for (let i = 0; i < this.activeCount; i++) {
      const arc = this.arcs[i]!;
      arc.setVisible(true);
      const samples = arc.samples;
      let dashSize = C.PLAN_ARC_DASH_PX;
      let gapSize = C.PLAN_ARC_GAP_PX;
      if (samples.length > 0) {
        const mid = samples[Math.floor(samples.length / 2)]!;
        const mpp = scale(this.toDisplay(mid.r, mid.t));
        dashSize = C.PLAN_ARC_DASH_PX * mpp;
        gapSize = C.PLAN_ARC_GAP_PX * mpp;
      }
      arc.sync(this.ephemeris, this.frame, this.unbakeTime, fo, dashSize, gapSize, scale, this.attractors);
    }
    for (let i = this.activeCount; i < this.arcs.length; i++) this.arcs[i]!.setVisible(false);
  }

  // 天体衝突が検出された地点と、その相手の天体(区間ごとに高々1つ)。今フレーム表示中の
  // 区間だけを対象にする。
  impactPoints(): readonly { readonly state: KinematicState; readonly body: Attractor; readonly arcIdx: number }[] {
    const out: { state: KinematicState; body: Attractor; arcIdx: number }[] = [];
    for (let i = 0; i < this.activeCount; i++) {
      const impact = this.arcs[i]?.impactPoint();
      if (impact) out.push({ state: impact.state, body: impact.body, arcIdx: i });
    }
    return out;
  }

  // 表示中の区間が覆う simTime の範囲。どの区間にもサンプルが無ければ null。
  timeRange(): { readonly min: number; readonly max: number } | null {
    let minT = Infinity;
    let maxT = -Infinity;
    for (let i = 0; i < this.activeCount; i++) {
      const samples = this.arcs[i]!.samples;
      if (samples.length === 0) continue;
      minT = Math.min(minT, samples[0]!.t);
      maxT = Math.max(maxT, samples[samples.length - 1]!.t);
    }
    if (minT > maxT) return null;
    return { min: minT, max: maxT };
  }

  // 各ノードの到達時点(噴射直前)の状態。到達前に打ち切られた区間は null。
  arrivalStates(): (KinematicState | null)[] {
    const out: (KinematicState | null)[] = [];
    for (let i = 0; i < this.nodeCount; i++) out.push(this.arcs[i]?.endState() ?? null);
    return out;
  }

  // 時刻 t を保持区間に含む最初の arc から補間した状態を返す。どの arc の外でも null。
  sampleAt(t: number): KinematicState | null {
    for (let i = 0; i < this.activeCount; i++) {
      const s = this.arcs[i]!.at(t);
      if (s) return s;
    }
    return null;
  }

  // 時刻 t のサンプル位置 r を、現在の表示座標(ECI)へ変換する。座標系の原点・姿勢はサンプル
  // 時刻 t で bake し、表示時刻 unbakeTime で un-bake する(点なので FrameTransform を2つ引く)。
  toDisplay(r: Vec3, t: number): Vec3 {
    if (!this.ephemeris) return v3(r.x, r.y, r.z);
    const bakeTf = this.ephemeris.frameTransformAt(this.frame, t, this.attractors);
    const unbakeTf = this.currentUnbakeTransform()!;
    return toInertialPoint(unbakeTf, toFramePoint(bakeTf, r));
  }

  // 時刻 t の方向ベクトル dir を、現在の表示座標(ECI)へ変換する。方向なので原点移動は掛からず、
  // サンプル時刻 t の bake 姿勢と表示時刻 unbakeTime の un-bake 姿勢の回転だけを受ける。
  toDisplayDir(dir: Vec3, t: number): Vec3 {
    if (!this.ephemeris) return v3(dir.x, dir.y, dir.z);
    const bakeTf = this.ephemeris.frameTransformAt(this.frame, t, this.attractors);
    const unbakeTf = this.currentUnbakeTransform()!;
    return toInertialDir(unbakeTf, toFrameDir(bakeTf, dir));
  }

  // 時刻 t の状態 state における折れ線の接線方向を、現在の表示座標(ECI)へ変換する。
  // 折れ線自体は toFrameState の座標系相対速度(ω×r 項込み)を接線として描かれるため、
  // 単純な方向変換の toDisplayDir(ω×r 項を持たない)ではその接線と一致しない。
  toDisplayTangent(state: KinematicState, t: number): Vec3 {
    if (!this.ephemeris) return v3(state.v.x, state.v.y, state.v.z);
    const bakeTf = this.ephemeris.frameTransformAt(this.frame, t, this.attractors);
    const unbakeTf = this.currentUnbakeTransform()!;
    const relV = toFrameState(bakeTf, state).v;
    return toInertialDir(unbakeTf, frameDir(relV.x, relV.y, relV.z));
  }

  // 時刻 t のサンプル位置 r をスクリーン座標へ投影する。
  projectPoint(r: Vec3, t: number): Projected {
    if (!this.project) return OFFSCREEN;
    return this.project(this.toDisplay(r, t));
  }

  // 画面座標に最も近い計画軌道のサンプル(maxPx 以内)。なければ null。range を渡すと、
  // その時刻範囲に入るサンプルだけを候補にする。まず画面距離だけで最寄りの arc を選び
  // (バーン前後で arc をまたぐと t の大小関係が逆転するため、複数 arc を通して時刻を
  // 比べると誤った arc を選びかねない)、その arc の中で画面最短距離から NEAREST_SAMPLE_TIE_PX
  // 以内の候補に絞ってから referenceT に最も近い時刻を選ぶ — 新規配置は範囲の下端(= 最も
  // 早く到達する時刻)を、既存ノードのドラッグはそのノードの現在時刻を渡すことで、
  // 「表示期間が延びて折れ線が自分自身に重なる区間」の曖昧さを呼び出しの意図どおりに解く。
  nearestSample(mx: number, my: number, maxPx: number, referenceT: number, range?: TimeRange): { state: KinematicState, arcIdx: number } | null {
    const maxDSq = maxPx * maxPx;
    const cameraPos = this.cameraPos;
    const ephemeris = this.ephemeris;
    const attractors = cameraPos && ephemeris ? ephemeris.attractorsAt(this.unbakeTime) : null;
    // 表示座標への変換をサンプルごとに1回だけ行い、遮蔽判定と投影で共有する。un-bake 側の
    // 変換は時刻が固定なのでループの外で1回だけ引く。
    const unbakeTf = ephemeris ? this.currentUnbakeTransform() : null;
    const candidates: { state: KinematicState; arcIdx: number; dSq: number }[] = [];
    for (let i = 0; i < this.activeCount; i++) {
      for (const s of this.arcs[i]!.samples) {
        if (range && (s.t < range.min || s.t > range.max)) continue;
        const pos = ephemeris && unbakeTf
          ? toInertialPoint(unbakeTf, toFramePoint(ephemeris.frameTransformAt(this.frame, s.t, this.attractors), s.r))
          : v3(s.r.x, s.r.y, s.r.z);
        // 天体に遮蔽されて画面上見えていない点は候補から除く — マップ右クリックの
        // ピック候補(map-picker.ts)と同じ判定を通す。
        if (cameraPos && attractors && isOccluded(cameraPos, pos, attractors)) continue;
        const p = this.project ? this.project(pos) : OFFSCREEN;
        if (!p.front) continue;
        const dSq = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
        if (dSq <= maxDSq) candidates.push({ state: s, arcIdx: i, dSq });
      }
    }
    if (candidates.length === 0) return null;

    // 画面最短距離の候補が属する arc だけを tie-break の対象にする。
    let nearest = candidates[0]!;
    for (const c of candidates) if (c.dSq < nearest.dSq) nearest = c;
    const toleranceDSq = (Math.sqrt(nearest.dSq) + C.NEAREST_SAMPLE_TIE_PX) ** 2;

    // referenceT が -Infinity なら全候補が同点になり、最後の t 昇順の同点判定だけで最早時刻に落ち着く。
    let best: typeof candidates[number] | null = null;
    for (const c of candidates) {
      if (c.arcIdx !== nearest.arcIdx || c.dSq > toleranceDSq) continue;
      const d = Math.abs(c.state.t - referenceT);
      const bestD = best ? Math.abs(best.state.t - referenceT) : Infinity;
      if (!best || d < bestD - TIME_TIE_SEC
        || (Math.abs(d - bestD) <= TIME_TIE_SEC && c.state.t < best.state.t)) best = c;
    }
    return best ? { state: best.state, arcIdx: best.arcIdx } : null;
  }

  // update() がまだ呼ばれていない経路にも、従来どおり遅延評価で対応する。ただし通常の
  // 表示経路では update() が先に値を入れるため、同一フレーム内の再生成は起きない。
  private currentUnbakeTransform(): FrameTransform | null {
    if (!this.ephemeris) return null;
    if (this.unbakeTransform === null) {
      this.unbakeTransform = this.ephemeris.frameTransformAt(
        this.frame, this.unbakeTime, this.attractors,
      );
    }
    return this.unbakeTransform;
  }

  // group 全体の表示/非表示を切り替える。
  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  // i 番目の PlanArc を返す(なければ生成して group へ追加する)。
  private arcAt(i: number): PlanArc {
    while (this.arcs.length <= i) {
      const idx = this.arcs.length;
      const arc = new PlanArc(arcColor(idx), C.PLAN_ARC_OPACITY, C.LINE_RENDER_ORDER.plan);
      this.arcs.push(arc);
      this.group.add(arc.object3d);
    }
    return this.arcs[i]!;
  }
}

// anchor を起点に nodes を順にたどって区間列を返す。先頭 nodes.length 本は次のノードで終わり、
// 末尾の1本は segmentDurationFrom ぶん伸びる。
function buildSegments(plan: Plan, ephemeris: Ephemeris, displayTimeManager: DisplayDurationSource): Segment[] {
  const segments: Segment[] = [];
  let state0 = plan.anchor;
  // ノードを1つずつ経由点として区間を切り出す
  for (const node of plan.nodes) {
    segments.push({ state0, end: node.t });
    state0 = node;
  }
  const attractors = ephemeris.attractorsAt(state0.t);
  segments.push({ state0, end: state0.t + segmentDurationFrom(state0, attractors, displayTimeManager) });
  return segments;
}
