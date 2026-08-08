// 多ノードの計画軌道を arc 単位で描く。Plan の corners を区間へ分解し、
// 区間ごとに PlanArc を生成・所有する。画面判定も同じ表示変換を通すため描画とずれない。
import * as THREE from 'three/webgpu';
import { OrbitState } from '../../physics/orbital-state';
import { elementsAround, strongestAttractor } from '../../physics/attractor';
import { Vec3, v3 } from '../../physics/vec3';
import { Frame, INERTIAL_FRAME, toFramePoint, toInertialPoint } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { Projected } from '../../physics/projection';
import { FloatingOrigin } from '../floating-origin';
import { ProjectFn } from '../camera/camera-system';
import { Plan, TimeRange, segmentDurationFrom } from './plan';
import { PlanArc } from './plan-arc';
import type { DisplayTimeManager } from '../display-time-manager';
import { SIM_EPOCH_SEC } from '../hud/utils';
import * as C from '../const';

const SEGMENT_COLORS = [0xffb36b, 0xff8a26, 0xff6a00];
const arcColor = (i: number): number => SEGMENT_COLORS[Math.min(i, SEGMENT_COLORS.length - 1)]!;
const arcOpacity = (i: number): number => (i === 0 ? 0.55 : 0.85);

const OFFSCREEN: Projected = { x: 0, y: 0, front: false };

type Segment = { state0: OrbitState; end: number };

export class PlanTrajectory {
  readonly group = new THREE.Group();
  // 先頭 activeCount 本がこのフレームの区間に対応する(色は index で決まるので使い回す)。
  private arcs: PlanArc[] = [];
  private activeCount = 0;
  // 先頭 nodeCount 本がノードで終わる区間(= 各ノードの到達状態を持つ)。
  private nodeCount = 0;
  // 積分予測が起点の楕円近似から大きく外れた場合、解析楕円線を隠す。
  private analyticDivergent = false;
  private frame: Frame = INERTIAL_FRAME;
  private ephemeris: Ephemeris | null = null;
  private unbakeTime = 0;
  private project: ProjectFn | null = null;
  // 最後のバーン後(これから乗る軌道)の起点状態。末尾区間が無ければ null。
  finalSegmentStart: OrbitState | null = null;

  get isAnalyticDivergent(): boolean { return this.analyticDivergent; }
  resetDivergence(): void { this.analyticDivergent = false; }

  // group をシーンへ登録する(初期状態は非表示)。
  constructor(scene: THREE.Scene, private readonly displayTimeManager: DisplayTimeManager) {
    this.group.visible = false;
    scene.add(this.group);
  }

  // plan から区間列を組み直して各区間を再積分し、表示変換の文脈(座標系・un-bake 時刻)を
  // このフレームのものに更新する。
  update(plan: Plan, ephemeris: Ephemeris, frame: Frame, currentTime: number): void {
    this.frame = frame;
    this.ephemeris = ephemeris;
    this.unbakeTime = currentTime;
    // anchor→node…→末尾区間に分解する
    const segments = buildSegments(plan, ephemeris, this.displayTimeManager);
    // ノードが1つも無い間はその唯一の区間(末尾区間)の起点が毎フレーム自機を追従する。
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const tracksLiveAnchor = plan.nodes.length === 0 && i === segments.length - 1;
      this.arcAt(i).update(seg.state0, seg.end, ephemeris, tracksLiveAnchor);
    }
    this.activeCount = segments.length;
    this.nodeCount = plan.nodes.length;
    this.finalSegmentStart = segments.length > plan.nodes.length ? segments[segments.length - 1]!.state0 : null;
    // 先頭区間が再積分されたときだけ判定し直す(全サンプル走査は再積分と同じ頻度に抑える)。
    if (this.arcs[0]?.didRecompute()) {
      this.analyticDivergent = this.detectAnalyticDivergence(segments[0]?.state0 ?? null);
    }
  }

  // 各サンプルから求めた瞬時軌道要素を起点要素と比較する。月フライバイのような
  // 摂動では長半径・離心率・軌道面が変化するため、解析楕円を表示し続けると積分線と
  // 二重に見えてしまう。通常のLEOの数値誤差/J2の微小変化は閾値未満に収める。
  // 途中で最も強く引く天体が起点と変われば、要素の比較を待たずその時点で divergent とする
  // (中心が違う要素同士を比べても意味がないため)。
  private detectAnalyticDivergence(anchor: OrbitState | null): boolean {
    if (!anchor || !this.ephemeris) return false;
    const center = strongestAttractor(anchor.r, this.ephemeris.attractorsAt(anchor.t));
    const base = elementsAround(anchor, center);
    if (!base || base.e >= 0.98 || !isFinite(base.a) || base.a <= 0) return false;
    const samples = this.arcs[0]?.samplesRef() ?? [];
    for (const s of samples) {
      // 中心天体自身もサンプル時刻ぶん動くので、そのつど ephemeris から引き直す。
      const sampleCenter = strongestAttractor(s.r, this.ephemeris.attractorsAt(s.t));
      if (sampleCenter.id !== center.id) return true;
      const el = elementsAround(s, sampleCenter);
      if (!el || !isFinite(el.a) || el.a <= 0) continue;
      if (Math.abs(el.a - base.a) / base.a > 0.03 || Math.abs(el.e - base.e) > 0.02) return true;
      const planeDot = el.hHat.x * base.hHat.x + el.hHat.y * base.hHat.y + el.hHat.z * base.hHat.z;
      if (planeDot < Math.cos(2 * Math.PI / 180)) return true;
    }
    return false;
  }

  // 各区間の折れ線メッシュを最新のサンプル列へ同期し、区間数が減った分の arc を隠す。
  // 画面判定が使う視点(project)もここで受け取り、毎フレーム上書きする。
  sync(fo: FloatingOrigin, project: ProjectFn): void {
    this.project = project;
    if (this.ephemeris === null) return;
    for (let i = 0; i < this.activeCount; i++) {
      const arc = this.arcs[i]!;
      arc.setVisible(true);
      arc.sync(this.ephemeris, this.frame, this.unbakeTime, fo);
    }
    for (let i = this.activeCount; i < this.arcs.length; i++) this.arcs[i]!.setVisible(false);
  }

  // 天体衝突が検出された地点(区間ごとに高々1つ)。今フレーム表示中の区間だけを対象にする。
  impactPoints(): readonly { readonly state: OrbitState; readonly arcIdx: number }[] {
    const out: { state: OrbitState; arcIdx: number }[] = [];
    for (let i = 0; i < this.activeCount; i++) {
      const state = this.arcs[i]?.impactPoint();
      if (state) out.push({ state, arcIdx: i });
    }
    return out;
  }

  // 表示中の区間が覆う時刻範囲(絶対 UTC)に含まれる日付境界(0時0分0秒)の simTime と、
  // その時刻の折れ線上の位置。区間をまたいでも重複させない。
  dayBoundaries(): readonly { readonly t: number; readonly pos: Vec3 }[] {
    if (this.activeCount === 0) return [];
    let minT = Infinity;
    let maxT = -Infinity;
    for (let i = 0; i < this.activeCount; i++) {
      const samples = this.arcs[i]!.samplesRef();
      if (samples.length === 0) continue;
      minT = Math.min(minT, samples[0]!.t);
      maxT = Math.max(maxT, samples[samples.length - 1]!.t);
    }
    if (minT > maxT) return [];

    const out: { t: number; pos: Vec3 }[] = [];
    const firstBoundaryUnix = Math.ceil((SIM_EPOCH_SEC + minT) / 86400) * 86400;
    for (let unix = firstBoundaryUnix; unix <= SIM_EPOCH_SEC + maxT; unix += 86400) {
      const t = unix - SIM_EPOCH_SEC;
      const state = this.sampleAt(t);
      if (state) out.push({ t, pos: state.r });
    }
    return out;
  }

  // 各ノードの到達時点(噴射直前)の状態。到達前に打ち切られた区間は null。
  arrivalStates(): (OrbitState | null)[] {
    const out: (OrbitState | null)[] = [];
    for (let i = 0; i < this.nodeCount; i++) out.push(this.arcs[i]?.endState() ?? null);
    return out;
  }

  // 時刻 t を保持区間に含む最初の arc から補間した状態を返す。どの arc の外でも null。
  sampleAt(t: number): OrbitState | null {
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
    const bakeTf = this.ephemeris.frameTransformAt(this.frame, t);
    const unbakeTf = this.ephemeris.frameTransformAt(this.frame, this.unbakeTime);
    return toInertialPoint(unbakeTf, toFramePoint(bakeTf, r));
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
  nearestSample(mx: number, my: number, maxPx: number, referenceT: number, range?: TimeRange): { state: OrbitState, arcIdx: number } | null {
    const maxDSq = maxPx * maxPx;
    const candidates: { state: OrbitState; arcIdx: number; dSq: number }[] = [];
    for (let i = 0; i < this.activeCount; i++) {
      for (const s of this.arcs[i]!.samplesRef()) {
        if (range && (s.t < range.min || s.t > range.max)) continue;
        const p = this.projectPoint(s.r, s.t);
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
      if (!best || d < bestD || (d === bestD && c.state.t < best.state.t)) best = c;
    }
    return best ? { state: best.state, arcIdx: best.arcIdx } : null;
  }

  // group 全体の表示/非表示を切り替える。
  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  // i 番目の PlanArc を返す(なければ生成して group へ追加する)。
  private arcAt(i: number): PlanArc {
    while (this.arcs.length <= i) {
      const idx = this.arcs.length;
      const arc = new PlanArc(arcColor(idx), arcOpacity(idx), 4);
      this.arcs.push(arc);
      this.group.add(arc.object3d);
    }
    return this.arcs[i]!;
  }
}

// anchor を起点に nodes を順にたどって区間列を返す。先頭 nodes.length 本は次のノードで終わり、
// 末尾の1本は segmentDurationFrom ぶん伸びる。
function buildSegments(plan: Plan, ephemeris: Ephemeris, displayTimeManager: DisplayTimeManager): Segment[] {
  const segments: Segment[] = [];
  let state0 = plan.anchor;
  // ノードを1つずつ経由点として区間を切り出す
  for (const node of plan.nodes) {
    segments.push({ state0, end: node.t });
    state0 = node;
  }
  const bodies = ephemeris.attractorsAt(state0.t);
  segments.push({ state0, end: state0.t + segmentDurationFrom(state0, bodies, displayTimeManager) });
  return segments;
}
