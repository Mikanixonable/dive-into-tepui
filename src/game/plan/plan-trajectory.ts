// 軌道計画の多ノード予測軌道を arc 単位で描く。Plan の corners を区間へ分解し、
// 区間ごとに PlanArc を生成・所有する。画面判定も同じ表示変換を通すため描画とずれない。
import * as THREE from 'three/webgpu';
import { OrbitState } from '../../physics/orbital';
import { Vec3, v3 } from '../../physics/vec3';
import { Frame, toFramePos, toInertialPos } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { Projected } from '../../physics/projection';
import { FloatingOrigin } from '../floating-origin';
import { ProjectFn } from '../camera/camera-system';
import { Plan } from './plan';
import { PlanArc } from './plan-arc';

const SEGMENT_COLORS = [0xbfc9d4, 0xffffff, 0xff6a00];
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
  private frame: Frame = 'inertial';
  private ephemeris: Ephemeris | null = null;
  private unbakeTime = 0;
  private project: ProjectFn | null = null;
  private forceNext = false;
  // 最後のバーン後(まだノードで終わらない末尾区間)の起点状態。ノードが尽きていれば null。
  private trailingStart: OrbitState | null = null;

  // group をシーンへ登録する(初期状態は非表示)。
  constructor(scene: THREE.Scene) {
    this.group.visible = false;
    scene.add(this.group);
  }

  // plan/displayEnd から区間列を組み直し、各区間の PlanArc を更新する。
  update(
    plan: Plan,
    displayEnd: number,
    ephemeris: Ephemeris,
    frame: Frame,
    currentTime: number,
    fo: FloatingOrigin,
    project: ProjectFn,
  ): void {
    this.frame = frame;
    this.ephemeris = ephemeris;
    this.unbakeTime = currentTime;
    this.project = project;
    // anchor→node…→displayEnd を区間に分解する
    const segments = buildSegments(plan.anchor, plan.nodes, displayEnd);
    const force = this.forceNext;
    this.forceNext = false;
    // 各区間に対応する PlanArc を更新する。末尾区間だけが表示窓の終端で切れる。
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const arc = this.arcAt(i);
      arc.setVisible(true);
      arc.update(seg.state0, seg.end, i >= plan.nodes.length, ephemeris, frame, currentTime, fo, force);
    }
    // 区間数が減った分の余った arc を隠す
    for (let i = segments.length; i < this.arcs.length; i++) this.arcs[i]!.setVisible(false);
    this.activeCount = segments.length;
    this.nodeCount = plan.nodes.length;
    this.trailingStart = segments.length > plan.nodes.length ? segments[segments.length - 1]!.state0 : null;
  }

  // 最後のバーン後(これから乗る軌道)の起点状態。ノードがすべて表示終端より後にあり
  // 末尾区間が無ければ null。
  get finalSegmentStart(): OrbitState | null {
    return this.trailingStart;
  }

  // 各ノードの到達時点(噴射直前)の状態。到達前に打ち切られた区間は null。
  arrivalStates(): (OrbitState | null)[] {
    const out: (OrbitState | null)[] = [];
    for (let i = 0; i < this.nodeCount; i++) out.push(this.arcs[i]?.endState() ?? null);
    return out;
  }

  // 次フレームに全 arc を強制再計算させる(表示期間切替など窓の滑り以外の変化時)。
  invalidate(): void {
    this.forceNext = true;
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

  // 画面座標に最も近い予測サンプル(maxPx 以内)。なければ null。
  nearestSample(mx: number, my: number, maxPx: number): OrbitState | null {
    let best: OrbitState | null = null;
    let bestD = maxPx * maxPx;
    // 全 arc の全サンプルを画面座標へ投影し、最も近いものを選ぶ
    for (let i = 0; i < this.activeCount; i++) {
      for (const s of this.arcs[i]!.samplesRef()) {
        const p = this.projectPoint(s.r, s.t);
        if (!p.front) continue;
        const d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
    }
    return best;
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

// anchor を起点に nodes を順にたどり、end までを区切った区間列を返す。先頭 nodes.length 本は
// 必ずノードで終わる — 表示期間を縮めても各ノードの到達状態が得られるよう、end で打ち切らない。
function buildSegments(anchor: OrbitState, nodes: readonly OrbitState[], end: number): Segment[] {
  const segments: Segment[] = [];
  let state0 = anchor;
  // ノードを1つずつ経由点として区間を切り出す
  for (const node of nodes) {
    segments.push({ state0, end: node.t });
    state0 = node;
  }
  // 最後のノードから表示終端までを最終区間とする
  if (state0.t < end) segments.push({ state0, end });
  return segments;
}
