// 軌道計画の多ノード予測軌道を arc 単位で描く。Plan の corners を arc へ分解し、
// arc ごとに PredictedLine を生成・所有する。画面判定も同じ表示変換を通すため描画とずれない。
import * as THREE from 'three/webgpu';
import { OrbitState } from '../../physics/orbital';
import { sampleAt } from '../../physics/predict';
import { Vec3, v3 } from '../../physics/vec3';
import { Frame, toFramePos, toInertialPos } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { Projected } from '../../physics/projection';
import { FloatingOrigin } from '../floating-origin';
import { ProjectFn } from '../camera/camera-system';
import { Plan } from './plan';
import { PredictedLine } from './predicted-line';

const SEGMENT_COLORS = [0xbfc9d4, 0xffffff, 0xff6a00];
const arcColor = (i: number): number => SEGMENT_COLORS[Math.min(i, SEGMENT_COLORS.length - 1)]!;
const arcOpacity = (i: number): number => (i === 0 ? 0.55 : 0.85);

const OFFSCREEN: Projected = { x: 0, y: 0, front: false };

type Arc = { state0: OrbitState; end: number };

export class PlanTrajectory {
  readonly group = new THREE.Group();
  private lines: PredictedLine[] = [];
  private arcs: Arc[] = [];
  private frame: Frame = 'inertial';
  private ephemeris: Ephemeris | null = null;
  private unbakeTime = 0;
  private project: ProjectFn | null = null;
  private forceNext = false;

  // group をシーンへ登録する(初期状態は非表示)。
  constructor(scene: THREE.Scene) {
    this.group.visible = false;
    scene.add(this.group);
  }

  // plan/displayEnd から arc 列を組み直し、各 arc の PredictedLine を更新する。
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
    // anchor→node…→displayEnd を arc に分解する
    this.arcs = buildArcs(plan.anchor, plan.nodes, displayEnd);
    const force = this.forceNext;
    this.forceNext = false;
    // 各 arc に対応する PredictedLine を更新する
    for (let i = 0; i < this.arcs.length; i++) {
      const arc = this.arcs[i]!;
      const line = this.lineAt(i);
      line.setVisible(true);
      line.update(arc.state0, arc.end, ephemeris, frame, currentTime, fo, undefined, force);
    }
    // arc 数が減った分の余った line を隠す
    for (let i = this.arcs.length; i < this.lines.length; i++) this.lines[i]!.setVisible(false);
  }

  // 次フレームに全 arc を強制再計算させる(表示期間切替など窓の滑り以外の変化時)。
  invalidate(): void {
    this.forceNext = true;
  }

  // 時刻 t を含む arc から補間したサンプルを返す。arc がなければ null。
  sampleAt(t: number): OrbitState | null {
    if (this.arcs.length === 0) return null;
    for (let i = 0; i < this.arcs.length; i++) {
      if (t <= this.arcs[i]!.end || i === this.arcs.length - 1) {
        return sampleAt(this.lines[i]!.samplesRef(), t);
      }
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
    for (let i = 0; i < this.arcs.length; i++) {
      for (const s of this.lines[i]!.samplesRef()) {
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

  // i 番目の arc に対応する PredictedLine を返す(なければ生成して group へ追加する)。
  private lineAt(i: number): PredictedLine {
    while (this.lines.length <= i) {
      const idx = this.lines.length;
      const line = new PredictedLine(arcColor(idx), arcOpacity(idx), 2);
      this.lines.push(line);
      this.group.add(line.object3d);
    }
    return this.lines[i]!;
  }
}

// anchor を起点に nodes を順にたどり、end までを区切った arc(区間)列を返す。
function buildArcs(anchor: OrbitState, nodes: readonly OrbitState[], end: number): Arc[] {
  const arcs: Arc[] = [];
  let state0 = anchor;
  // ノードを1つずつ経由点として区間を切り出す
  for (const node of nodes) {
    if (state0.t >= end) break;
    const arcEnd = Math.min(node.t, end);
    if (arcEnd > state0.t) arcs.push({ state0, end: arcEnd });
    state0 = node;
  }
  // 最後のノードから end までを最終 arc とする
  if (state0.t < end) arcs.push({ state0, end });
  return arcs;
}
