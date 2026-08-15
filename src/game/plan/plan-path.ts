// 多ノードの計画軌道を arc 単位で描く。Plan の corners を区間へ分解し、区間ごとに PlanArc
// (積分結果)と TrajectoryLine(折れ線)を index で対応付けて持つ。起点・重力源・apsisCenter が
// 変われば PlanArc を作り直し、終端だけが動いた区間は PlanArc.setEnd に継ぎ足し/縮小させる —
// どちらの場合も折れ線はその区間の TrajectoryLine プールを使い回す。画面判定も同じ表示変換を
// 通すため描画とずれない。
import * as THREE from 'three/webgpu';
import { KinematicState } from '../../physics/kinematic-state';
import { Attractor, strongestAttractor } from '../../physics/attractor';
import { Vec3, v3 } from '../../physics/vec3';
import { FrameTransform, ReferenceFrame, toFrameDir, toFramePoint, toInertialDir, toInertialPoint } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { Projected } from '../../physics/projection';
import { isOccluded } from '../../physics/occlusion';
import { FloatingOrigin } from '../floating-origin';
import { TrajectoryLine } from '../trajectory-line';
import { ProjectFn, ScaleFn } from '../camera/camera-system';
import { DisplayDurationSource, PlanData, TimeRange, segmentDurationFrom } from './plan';
import { PlanArc } from './plan-arc';
import type { PlanAttractorProvider } from '../simulation/attractors';
import * as C from '../const';

const SEGMENT_COLORS = [0xffb36b, 0xff8a26, 0xff6a00];
const arcColor = (i: number): number => SEGMENT_COLORS[Math.min(i, SEGMENT_COLORS.length - 1)]!;

const OFFSCREEN: Projected = { x: 0, y: 0, front: false };

// 時刻の近さで tie-break するときに同点とみなす幅[s]。
const TIME_TIE_SEC = 1e-6;

// apsisCenter は末尾区間だけが持つ、起点自身の時刻の重力源から選んだ中心天体。
type Segment = { state0: KinematicState; end: number; apsisCenter: Attractor | null };

// 最後のバーン後(これから乗る軌道)の区間。samples は PlanArc.samples をそのまま渡す参照で、
// その区間の終端(end)が変わらない限り同一参照を保つ。periapsis/apoapsis は、区間が地表到達等で
// 打ち切られてその極値へ届かなければ null。apsisCenter はその極値を測った中心天体。
export interface FinalSegment {
  readonly state0: KinematicState;
  readonly samples: readonly KinematicState[];
  readonly periapsis: KinematicState | null;
  readonly apoapsis: KinematicState | null;
  readonly apsisCenter: Attractor | null;
}

export interface PlanPathSample {
  readonly state: KinematicState;
  readonly arcIdx: number;
}

export class PlanPath {
  readonly group = new THREE.Group();
  // 先頭 activeCount 本がこのフレームの区間の積分結果に対応する(区間が減れば末尾を捨てる)。
  private arcs: PlanArc[] = [];
  // 折れ線は index ごとのプールとして持ち、区間数が減っても捨てない(色は index で決まるので
  // 使い回す)。
  private lines: TrajectoryLine[] = [];
  private activeCount = 0;
  // 先頭 _nodeCount 本がノードで終わる区間(= 各ノードの到達状態を持つ)。
  private _nodeCount = 0;
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
  // 計画を積分して保持する範囲とは別に、画面へ描く時間窓を持つ。ノードが複数あると
  // 計画全体は表示期間より長くなり得るため、折れ線と目盛が同じ窓を読むようにする。
  private displayFrom = 0;
  private displayTo = 0;
  // 直近の update() で作り直した区間の本数と、積分に回した積分step数の合計
  // (作り直し・継ぎ足しの両方を含む)。
  lastRebuiltArcs = 0;
  lastSteps = 0;

  // group をシーンへ登録する(初期状態は非表示)。
  constructor(scene: THREE.Scene, private readonly displayDuration: DisplayDurationSource) {
    this.group.visible = false;
    scene.add(this.group);
  }

  // 起点とノード列から区間列を組み直す。起点・重力源・apsisCenter が既存の arc と一致する区間は
  // setEnd で終端だけ動かし、一致しない区間は arc を作り直す。表示変換の文脈(座標系・
  // un-bake 時刻)もこのフレームのものに更新する。
  update(
    planData: PlanData,
    ephemeris: Ephemeris, frame: ReferenceFrame, currentTime: number,
    attractors: readonly Attractor[], attractorProvider: PlanAttractorProvider,
    displayDurationSec: number,
  ): void {
    this.frame = frame;
    this.ephemeris = ephemeris;
    this.unbakeTime = currentTime;
    this.displayFrom = currentTime;
    this.displayTo = currentTime + Math.max(0, displayDurationSec);
    this.attractors = attractors;
    this.unbakeTransform = ephemeris.frameTransformAt(frame, currentTime, attractors);
    this.lastRebuiltArcs = 0;
    this.lastSteps = 0;
    // 起点→node…→末尾区間に分解する
    const segments = buildSegments(planData, ephemeris, this.displayDuration);
    // ノードが1つも無い間はその唯一の区間(末尾区間)の起点が毎フレーム自機を追従する。
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const tracksLiveAnchor = planData.nodes.length === 0 && i === segments.length - 1;
      const apsisCenterId = seg.apsisCenter?.id ?? null;
      let arc = this.arcs[i];
      if (!arc || !arc.represents(seg.state0, seg.end, attractorProvider.revision, apsisCenterId, tracksLiveAnchor)) {
        arc = new PlanArc(seg.state0, seg.end, attractorProvider, seg.apsisCenter);
        this.arcs[i] = arc;
        this.lastRebuiltArcs++;
      } else {
        arc.setEnd(seg.end);
      }
      this.lastSteps += arc.lastSteps;
    }
    this.arcs.length = segments.length;
    this.activeCount = segments.length;
    this._nodeCount = planData.nodes.length;
    const finalArc = this.arcs[segments.length - 1]!;
    const finalSeg = segments[segments.length - 1]!;
    this.final = {
      state0: finalSeg.state0,
      samples: finalArc.samples,
      periapsis: finalArc.periapsisPoint(),
      apoapsis: finalArc.apoapsisPoint(),
      apsisCenter: finalSeg.apsisCenter,
    };
  }

  // 最後のバーン後の区間。update() を一度も通していなければ null。
  finalSegment(): FinalSegment | null {
    return this.final;
  }

  // 各区間の折れ線メッシュを最新のサンプル列へ同期し、区間数が減った分の線を隠す。
  // 画面判定が使う視点(project)もここで受け取り、毎フレーム上書きする。破線のドット/隙間は
  // 各区間のサンプル列中央の代表点で scale(m/px)を引き、ピクセル指定を実距離に直してから渡す
  // — ズームによらず画面上の間隔を一定に保つため。camera は各区間の折れ線の解像度を決める
  // 画面上のサジッタを実距離へ換算するための描画カメラ。
  sync(fo: FloatingOrigin, project: ProjectFn, scale: ScaleFn, cameraPos: Vec3, camera: THREE.Camera): void {
    this.project = project;
    this.cameraPos = cameraPos;
    if (this.ephemeris === null) return;
    for (let i = 0; i < this.activeCount; i++) {
      const arc = this.arcs[i]!;
      const line = this.lineAt(i);
      line.setVisible(true);
      const samples = arc.samples;
      let dashSize = C.PLAN_ARC_DASH_PX;
      let gapSize = C.PLAN_ARC_GAP_PX;
      if (samples.length > 0) {
        const mid = samples[Math.floor(samples.length / 2)]!;
        const mpp = scale(this.toDisplay(mid.r, mid.t));
        dashSize = C.PLAN_ARC_DASH_PX * mpp;
        gapSize = C.PLAN_ARC_GAP_PX * mpp;
      }
      line.setDash(dashSize, gapSize);
      // 計画全体が表示期間より長くても、折れ線は表示窓内だけを描く。
      line.syncGeometry(
        arc.trajectory,
        Math.max(this.displayFrom, arc.state0.t),
        Math.min(this.displayTo, arc.end),
        this.frame, this.ephemeris, this.attractors,
      );
      line.syncTransform(this.frame, this.unbakeTime, this.ephemeris, fo, this.attractors);
      line.sync(camera);
    }
    // 線プールは区間数が減っても捨てずに残すので、隠す範囲は arcs でなく lines の本数まで見る。
    for (let i = this.activeCount; i < this.lines.length; i++) this.lines[i]!.setVisible(false);
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
    for (let i = 0; i < this._nodeCount; i++) out.push(this.arcs[i]?.endState() ?? null);
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
      const s = this.arcs[i]!.at(t);
      if (s) return { state: s, arcIdx: i };
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

  // i 番目の折れ線を返す(なければ生成して group へ追加する)。区間の色は index で決まる。
  private lineAt(i: number): TrajectoryLine {
    while (this.lines.length <= i) {
      const idx = this.lines.length;
      const line = new TrajectoryLine(arcColor(idx), C.PLAN_ARC_OPACITY, C.LINE_RENDER_ORDER.plan,
        { dashSize: C.PLAN_ARC_DASH_PX, gapSize: C.PLAN_ARC_GAP_PX });
      this.lines.push(line);
      this.group.add(line.line);
    }
    return this.lines[i]!;
  }
}

// 起点から nodes を順にたどって区間列を返す。先頭 nodes.length 本は次のノードで終わり、
// 末尾の1本は segmentDurationFrom ぶん伸び、その起点自身の時刻で選んだ中心天体を持つ
// (表示時刻の重力源では表示時刻に応じて中心天体が変わり、区間の物理そのものと食い違う)。
function buildSegments(
  planData: PlanData,
  ephemeris: Ephemeris, displayDuration: DisplayDurationSource,
): Segment[] {
  const segments: Segment[] = [];
  let state0 = planData.anchor;
  // ノードを1つずつ経由点として区間を切り出す
  for (const node of planData.nodes) {
    segments.push({ state0, end: node.t, apsisCenter: null });
    state0 = node;
  }
  // 区間長と中心天体は同じ起点・同じ時刻の問いなので、天体窓は1回だけ引いて両方に使う。
  const attractors = ephemeris.attractorsAt(state0.t);
  segments.push({
    state0,
    end: state0.t + segmentDurationFrom(state0, attractors, displayDuration),
    apsisCenter: strongestAttractor(state0.r, attractors),
  });
  return segments;
}
