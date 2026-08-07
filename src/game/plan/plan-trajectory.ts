// 多ノードの計画軌道を arc 単位で描く。Plan の corners を区間へ分解し、
// 区間ごとに PlanArc を生成・所有する。画面判定も同じ表示変換を通すため描画とずれない。
import * as THREE from 'three/webgpu';
import { MU_EARTH, OrbitState, elementsFromState } from '../../physics/orbital';
import { Vec3, v3 } from '../../physics/vec3';
import { Frame, toFramePos, toInertialPos } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { Projected } from '../../physics/projection';
import { FloatingOrigin } from '../floating-origin';
import { ProjectFn } from '../camera/camera-system';
import { orbitPeriodOf, Plan, TimeRange } from './plan';
import { PlanArc } from './plan-arc';

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
  private frame: Frame = 'inertial';
  private ephemeris: Ephemeris | null = null;
  private unbakeTime = 0;
  private project: ProjectFn | null = null;
  // 最後のバーン後(これから乗る軌道)の起点状態。末尾区間が無ければ null。
  finalSegmentStart: OrbitState | null = null;

  get isAnalyticDivergent(): boolean { return this.analyticDivergent; }
  resetDivergence(): void { this.analyticDivergent = false; }

  // group をシーンへ登録する(初期状態は非表示)。
  constructor(scene: THREE.Scene) {
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
    const segments = buildSegments(plan, ephemeris);
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      this.arcAt(i).update(seg.state0, seg.end, ephemeris, plan.centralBody);
    }
    this.activeCount = segments.length;
    this.nodeCount = plan.nodes.length;
    this.finalSegmentStart = segments.length > plan.nodes.length ? segments[segments.length - 1]!.state0 : null;
    this.analyticDivergent = this.detectAnalyticDivergence(segments[0]?.state0 ?? null);
  }

  // 各サンプルから求めた瞬時軌道要素を起点要素と比較する。月フライバイのような
  // 摂動では長半径・離心率・軌道面が変化するため、解析楕円を表示し続けると積分線と
  // 二重に見えてしまう。通常のLEOの数値誤差/J2の微小変化は閾値未満に収める。
  private detectAnalyticDivergence(anchor: OrbitState | null): boolean {
    const base = anchor ? elementsFromState(anchor.r, anchor.v, MU_EARTH) : null;
    if (!base || base.e >= 0.98 || !isFinite(base.a) || base.a <= 0) return false;
    const samples = this.arcs[0]?.samplesRef() ?? [];
    for (const s of samples) {
      const el = elementsFromState(s.r, s.v, MU_EARTH);
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

  // 時刻 t のサンプル位置 r を、現在の表示座標(ECI)へ変換する。
  toDisplay(r: Vec3, t: number): Vec3 {
    if (!this.ephemeris) return v3(r.x, r.y, r.z);
    return toInertialPos(this.frame, this.unbakeTime, toFramePos(this.frame, t, r, this.ephemeris), this.ephemeris);
  }

  // 時刻 t のサンプル位置 r をスクリーン座標へ投影する。
  projectPoint(r: Vec3, t: number): Projected {
    if (!this.project) return OFFSCREEN;
    return this.project(this.toDisplay(r, t));
  }

  // 画面座標に最も近い計画軌道のサンプル(maxPx 以内)。なければ null。
  // range を渡すと、その時刻範囲に入るサンプルだけを候補にする。
  nearestSample(mx: number, my: number, maxPx: number, range?: TimeRange): { state: OrbitState, arcIdx: number } | null {
    let best: OrbitState | null = null;
    let bestArc = -1;
    let bestD = maxPx * maxPx;
    // 全 arc の全サンプルを画面座標へ投影し、最も近いものを選ぶ
    for (let i = 0; i < this.activeCount; i++) {
      for (const s of this.arcs[i]!.samplesRef()) {
        if (range && (s.t < range.min || s.t > range.max)) continue;
        const p = this.projectPoint(s.r, s.t);
        if (!p.front) continue;
        const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
        if (d < bestD) {
          bestD = d;
          best = s;
          bestArc = i;
        }
      }
    }
    return best ? { state: best, arcIdx: bestArc } : null;
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
// 末尾の1本は起点の解析軌道1周期ぶん伸びる。
function buildSegments(plan: Plan, ephemeris: Ephemeris): Segment[] {
  const segments: Segment[] = [];
  let state0 = plan.anchor;
  // ノードを1つずつ経由点として区間を切り出す
  for (const node of plan.nodes) {
    segments.push({ state0, end: node.t });
    state0 = node;
  }
  // 最後のノード(無ければ anchor)から1周期ぶんを末尾区間とする
  segments.push({ state0, end: state0.t + orbitPeriodOf(state0, plan.centralBody, ephemeris) });
  return segments;
}
