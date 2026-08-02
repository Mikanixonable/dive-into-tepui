// 多ノードの計画軌道を arc 単位で描く。Plan の corners を区間へ分解し、
// 区間ごとに PlanArc を生成・所有する。画面判定も同じ表示変換を通すため描画とずれない。
import * as THREE from 'three/webgpu';
import { OrbitState } from '../../physics/orbital';
import { Vec3, v3 } from '../../physics/vec3';
import { Frame, toFramePos, toInertialPos } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { Projected } from '../../physics/projection';
import { FloatingOrigin } from '../floating-origin';
import { ProjectFn } from '../camera/camera-system';
import { orbitPeriodOf, Plan, TimeRange } from './plan';
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
  // 最後のバーン後(これから乗る軌道)の起点状態。末尾区間が無ければ null。
  finalSegmentStart: OrbitState | null = null;

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
    const segments = buildSegments(plan.anchor, plan.nodes);
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      this.arcAt(i).update(seg.state0, seg.end, ephemeris);
    }
    this.activeCount = segments.length;
    this.nodeCount = plan.nodes.length;
    this.finalSegmentStart = segments.length > plan.nodes.length ? segments[segments.length - 1]!.state0 : null;
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
  nearestSample(mx: number, my: number, maxPx: number, range?: TimeRange): OrbitState | null {
    let best: OrbitState | null = null;
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

// anchor を起点に nodes を順にたどって区間列を返す。先頭 nodes.length 本は次のノードで終わり、
// 末尾の1本は起点の解析軌道1周期ぶん伸びる。
function buildSegments(anchor: OrbitState, nodes: readonly OrbitState[]): Segment[] {
  const segments: Segment[] = [];
  let state0 = anchor;
  // ノードを1つずつ経由点として区間を切り出す
  for (const node of nodes) {
    segments.push({ state0, end: node.t });
    state0 = node;
  }
  // 最後のノード(無ければ anchor)から1周期ぶんを末尾区間とする
  segments.push({ state0, end: state0.t + orbitPeriodOf(state0) });
  return segments;
}
