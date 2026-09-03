// 選択中ノードの Δv アーム(PRO/RET・NRM/ANM・OUT/IN の6方向)の画面配置と、アームのドラッグ・
// ラッチ・キー/ボタンの長押しそれぞれから Δv の加算量を決めるレート。加算量は onApplyDv へ渡す。
import { KinematicState, orbitAxes } from '../../physics/kinematic-state';
import { Projected } from '../../math/projection';
import { Vec3, add, scale } from '../../math/vec3';
import { AxisHandleSpec } from './node-gizmo';

const NODE_GIZMO_HANDLE_PX = 42; // ノードからアームハンドルを離す距離 [px]
const AXIS_PROBE_PER_MAP_DIST = 0.05; // 画面方向を求めるために軸方向へ進める距離の、マップカメラ距離に対する比

const NODE_DV_RATE = 300; // Δv 調整速度 [m/s per 実秒]
const NODE_DV_RATE_FINE = 30; // 微調整モードの Δv 調整速度 [m/s per 実秒]
const DV_DRAG_PX_PER_RATE = 200; // ラッチ前のドラッグで、この変位が NODE_DV_RATE ぶんの Δv になる [px]
const DV_LATCH_RATE_PER_PX = 3.0; // ラッチ中、閾値超過1pxあたりのΔv加算レート [m/s per 実秒 per px]

const DV_RATE_MIN = 1; // 長押し開始時のΔv加算レート [m/s per 実秒]
const DV_RATE_MAX = 400; // 長押し継続後に到達するΔv加算レート [m/s per 実秒]
const DV_RATE_RAMP_SEC = 3.0; // DV_RATE_MIN から DV_RATE_MAX への指数的ランプ時間 [s]

// 画面上の単位方向ベクトル。
interface ScreenDir {
  readonly x: number;
  readonly y: number;
}

// ホールド継続時間 [s] から Δv 加算レートを指数的に求める。押し始めは細かく、長押しで粗くなる。
function rampedDvRate(heldSec: number): number {
  const t = Math.min(heldSec / DV_RATE_RAMP_SEC, 1);
  return DV_RATE_MIN * (DV_RATE_MAX / DV_RATE_MIN) ** t;
}

// 微調整モードのときに Δv 加算レートへ掛ける係数。
function fineScale(fineAttitude: boolean): number {
  return fineAttitude ? NODE_DV_RATE_FINE / NODE_DV_RATE : 1;
}

export class AxisDragGizmo {
  // 6 方向それぞれのホールド継続時間 [s]。index は axis*2 + (sign<0 ? 1 : 0)。
  private readonly dvHoldTime: number[] = [0, 0, 0, 0, 0, 0];

  // bodyStateOf は軌道基準枠を解釈するための中心天体相対の状態、projectPoint は ECI 位置の
  // 画面投影、onApplyDv は求めた加算量の届け先。
  public constructor(
    private readonly bodyStateOf: (state: KinematicState) => KinematicState,
    private readonly projectPoint: (r: Vec3, t: number) => Projected,
    private readonly onApplyDv: (axis: 0 | 1 | 2, sign: 1 | -1, amount: number) => void,
  ) {}

  // Δv アーム 6 個の画面方向をノード位置と微小先の投影差分から求める。
  private computeAxisScreenDirs(
    node: KinematicState,
    mapDist: number,
  ): { pro: ScreenDir; nrm: ScreenDir; rad: ScreenDir; } {
    const { r } = node;
    const { pro, nrm, radOut } = orbitAxes(this.bodyStateOf(node));
    const probe = mapDist * AXIS_PROBE_PER_MAP_DIST;
    const p0 = this.projectPoint(r, node.t);
    // 軸方向へわずかに動かした点との投影差分から、画面上の単位方向ベクトルを求める。
    const dirFor = (axisVec: Vec3): ScreenDir => {
      const p1 = this.projectPoint(add(r, scale(axisVec, probe)), node.t);
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const m = Math.hypot(dx, dy);
      return m > 1e-6 ? { x: dx / m, y: dy / m } : { x: 0, y: -1 };
    };
    return { pro: dirFor(pro), nrm: dirFor(nrm), rad: dirFor(radOut) };
  }

  // 画面座標 (nx, ny) のノード周囲に PRO/RET・NRM/ANM・OUT/IN 6 方向の Δv アームハンドル仕様を
  // 配置する。軸の向きは node の軌道基準から、ハンドルの間隔はマップカメラ距離 mapDist から決まる。
  public buildAxisHandles(nx: number, ny: number, node: KinematicState, mapDist: number): AxisHandleSpec[] {
    const dirs = this.computeAxisScreenDirs(node, mapDist);
    const R = NODE_GIZMO_HANDLE_PX;
    // 軸・符号・画面方向からハンドル1個分の位置とラベルを組む
    const mk = (axis: 0 | 1 | 2, sign: 1 | -1, d: ScreenDir, label: string): AxisHandleSpec => ({
      axis,
      sign,
      x: nx + d.x * R * sign,
      y: ny + d.y * R * sign,
      dirx: d.x * sign,
      diry: d.y * sign,
      label,
    });
    return [
      mk(0, 1, dirs.pro, 'PRO'),
      mk(0, -1, dirs.pro, 'RET'),
      mk(1, 1, dirs.nrm, 'NRM'),
      mk(1, -1, dirs.nrm, 'ANM'),
      mk(2, 1, dirs.rad, 'OUT'),
      mk(2, -1, dirs.rad, 'IN'),
    ];
  }

  // Δv アームのラッチ前のドラッグ変位 deltaPx [px] ぶんを Δv へ加算する。
  public applyAxisDrag(axis: 0 | 1 | 2, sign: 1 | -1, deltaPx: number, fineAttitude: boolean): void {
    this.onApplyDv(axis, sign, deltaPx * NODE_DV_RATE * fineScale(fineAttitude) / DV_DRAG_PX_PER_RATE);
  }

  // ラッチ中の Δv アームについて、閾値からの超過量 excessPx [px] に比例したレートで dt 秒分を加算する。
  public applyLatchDv(axis: 0 | 1 | 2, sign: 1 | -1, excessPx: number, dt: number, fineAttitude: boolean): void {
    // 超過距離に比例させる。ここを DV_RATE_MAX で飽和させると、一定距離以上のドラッグがすべて
    // 同じ Δv になり、「大きくドラッグするほど加速が増える」という操作感が失われる。
    this.onApplyDv(axis, sign, excessPx * DV_LATCH_RATE_PER_PX * fineScale(fineAttitude) * dt);
  }

  // axis/sign 方向のキー/ボタンが held の間ホールド時間を積み上げ、そのレートで dt 秒分の
  // Δv を加算する。held が false ならホールド時間をリセットするだけで加算はしない。
  public applyHeldDv(axis: 0 | 1 | 2, sign: 1 | -1, held: boolean, dt: number, fineAttitude: boolean): void {
    const idx = axis * 2 + (sign < 0 ? 1 : 0);
    if (!held) {
      this.dvHoldTime[idx] = 0;
      return;
    }
    this.dvHoldTime[idx] = (this.dvHoldTime[idx] ?? 0) + dt;
    this.onApplyDv(axis, sign, rampedDvRate(this.dvHoldTime[idx]!) * fineScale(fineAttitude) * dt);
  }

  // 編集対象がない間、6方向すべてのホールド時間をリセットする。
  public resetHold(): void {
    this.dvHoldTime.fill(0);
  }
}
