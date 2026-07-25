// 素案 B-2: 軌道計画(Plan)の多ノード予測軌道を描く、plan 隣接の描画ユニット。
// Plan の corners(frozen アンカー + 凍結ノード)を arc へ分解し、arc ごとに 1 本の
// PredictedLine(素案 B-1)を生成・所有して描く(B-1 の複数実行)。「まだ実行していない
// 噴射(グレー)→最初のノード後(白)→2個目以降(オレンジ)」の色分けはここが担う。
//
// arc の分解: [アンカー時刻 → node0 → node1 → … → 表示 end]。arc i は前境界(アンカー or
// 前ノードの postState)を初期状態に、次ノード時刻(最後は表示 end)まで自由伝播する。ノードは
// 速度不連続(Δv)で位置は連続なので、arc はノード位置で視覚的に繋がる(§0-5「途切れてよい」)。
//
// キャッシュは各 arc の B-1 が per-arc に持つ(入力変化検出 + スロットル)。ノードを編集すると
// その下流 arc の初期状態だけが変わり、上流 arc は再計算されない — 旧来の「1フラグ dirty で
// 全軌道を引き直す」より無駄が少ない。B-2 は arc の増減に応じて B-1 プールを伸縮させるだけ。
//
// 画面判定も担う: 描画メッシュと同じ表示座標変換(bake/un-bake)+ カメラ投影で、ghost マーカー
// (predict-system)とクリック判定(plan-editor)へ toDisplay / projectPoint / nearestSample を
// 提供する。plan-editor は座標系(frame)や physics/frame.ts(XX)を直接参照せず、この 1 箇所を
// 通すので描画とクリック判定が画面上でずれない(§5-4)。
import * as THREE from 'three/webgpu';
import { OrbitState } from '../../physics/orbital';
import { TrajectorySample, sampleAt } from '../../physics/predict';
import { Vec3, v3 } from '../../physics/vec3';
import { Frame, toFramePos, toInertialPos } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { Projected } from '../../physics/projection';
import { FloatingOrigin } from '../floating-origin';
import { ProjectFn } from '../camera/camera-system';
import { PredictedLine } from '../predict/predicted-line';
import { PlanAnchor, PlannedNode } from './plan';

// セグメント色: [未実行の噴射前=グレー, 最初のノード後=白, 2個目以降=オレンジ]。
const SEGMENT_COLORS = [0xbfc9d4, 0xffffff, 0xff6a00];
const arcColor = (i: number): number => SEGMENT_COLORS[Math.min(i, SEGMENT_COLORS.length - 1)]!;
const arcOpacity = (i: number): number => (i === 0 ? 0.55 : 0.85);

// 分解された 1 arc: 初期状態と描画区間 [start, end](絶対 simTime)。
type Arc = { state0: OrbitState; start: number; end: number };

export class PlanTrajectory {
  readonly group = new THREE.Group();
  private lines: PredictedLine[] = [];
  // 現在有効な arc の [start, end]。sampleAt が時刻から arc を選ぶのに使う。
  private arcs: Arc[] = [];
  // 表示座標変換(bake/un-bake)の文脈。update が毎フレーム保存し、picking/ghost の toDisplay が
  // 描画と同じ frame・同じ現在時刻(un-bake 基準)を使うために参照する。
  private frame: Frame = 'inertial';
  private ephemeris: Ephemeris | null = null;
  private unbakeTime = 0;
  // 表示期間切替など、窓の滑り以外の理由で次フレームに全 arc を強制再計算するフラグ。
  private forceNext = false;

  constructor(scene: THREE.Scene, private readonly project: ProjectFn) {
    this.group.visible = false;
    scene.add(this.group);
  }

  // 毎フレーム(マップモード中)呼ぶ。Plan の corners を arc へ分解し、各 arc の B-1 を駆動する。
  update(
    anchor: PlanAnchor,
    nodes: readonly PlannedNode[],
    displayEnd: number,
    ephemeris: Ephemeris,
    frame: Frame,
    currentTime: number,
    fo: FloatingOrigin,
  ): void {
    this.frame = frame;
    this.ephemeris = ephemeris;
    this.unbakeTime = currentTime;
    this.arcs = buildArcs(anchor, nodes, displayEnd);
    const force = this.forceNext;
    this.forceNext = false;
    for (let i = 0; i < this.arcs.length; i++) {
      const arc = this.arcs[i]!;
      const line = this.lineAt(i);
      line.setVisible(true);
      line.update(arc.state0, arc.start, arc.end, ephemeris, frame, currentTime, fo, undefined, force);
    }
    // 余った B-1(ノードが減った)は隠す。プールは維持して再利用する。
    for (let i = this.arcs.length; i < this.lines.length; i++) this.lines[i]!.setVisible(false);
  }

  // 表示期間切替など、窓の滑り以外の理由で次フレームに全 arc を再計算させる(スロットル無視)。
  // Plan の corners は変わらない — これは表示キャッシュ側の関心なので B-2 に閉じる(旧 markDirty
  // が Plan(正データ)にあったのは責務漏れ)。
  invalidate(): void {
    this.forceNext = true;
  }

  // 時刻 t の予測状態。ghost マーカー(predict-system)が未来位置を得るのに使う。
  // t を含む arc を選び、その arc の per-arc サンプル列を線形補間する。
  sampleAt(t: number): TrajectorySample | null {
    if (this.arcs.length === 0) return null;
    for (let i = 0; i < this.arcs.length; i++) {
      if (t <= this.arcs[i]!.end || i === this.arcs.length - 1) {
        return sampleAt(this.lines[i]!.samplesRef(), t);
      }
    }
    return null;
  }

  // ワールド点(時刻 t の r)を現在の表示座標系(frame + 現在時刻 unbakeTime)へ変換する。
  // 描画メッシュの bake(サンプル時刻 t) + un-bake(現在時刻)と同じ合成なので、ghost/クリック判定が
  // 描画とずれない。慣性系なら無変換。update 前(ephemeris 未設定)は慣性系扱い。
  toDisplay(r: Vec3, t: number): Vec3 {
    if (!this.ephemeris) return v3(r.x, r.y, r.z);
    return toInertialPos(this.frame, this.unbakeTime, toFramePos(this.frame, t, r, this.ephemeris), this.ephemeris);
  }

  // 表示座標系での画面投影(= toDisplay → カメラ投影)。plan-editor のノード画面位置・Δv アーム
  // 方向の算出に使う(plan-editor は frame/XX を知らずこの 1 箇所を通す)。
  projectPoint(r: Vec3, t: number): Projected {
    return this.project(this.toDisplay(r, t));
  }

  // 画面ポインタ最寄りの予測サンプル(maxPx 以内、無ければ null)。描画と同じ per-arc サンプルを
  // 同じ projectPoint で投影して探すので、クリック配置・リタイムが描画とずれない。
  nearestSample(mx: number, my: number, maxPx: number): TrajectorySample | null {
    let best: TrajectorySample | null = null;
    let bestD = maxPx * maxPx;
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

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  // arc i 用の B-1 を得る。足りなければプールを伸ばす。色はインデックスで一意なので再利用でも正しい。
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

// Plan の corners を arc 列へ分解する。arc i = [前境界時刻, min(次ノード時刻, end)] を前境界
// 状態(アンカー or 前ノード postState)から自由伝播。表示 end を超える arc は end で打ち切る。
function buildArcs(anchor: PlanAnchor, nodes: readonly PlannedNode[], end: number): Arc[] {
  const arcs: Arc[] = [];
  let t = anchor.time;
  let state0 = anchor.state;
  for (const node of nodes) {
    if (t >= end) break;
    const arcEnd = Math.min(node.time, end);
    if (arcEnd > t) arcs.push({ state0, start: t, end: arcEnd });
    t = node.time;
    state0 = node.postState;
  }
  if (t < end) arcs.push({ state0, start: t, end });
  return arcs;
}
